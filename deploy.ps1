[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '.env'),
    [switch]$SkipGenerate
)

$ErrorActionPreference = 'Stop'

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Arquivo de ambiente não encontrado: $Path"
    }
    Get-Content -LiteralPath $Path | ForEach-Object {
        if ($_ -match '^\s*([^#\s][^=]*)=(.*)$') {
            $nome = $matches[1].Trim()
            $valor = $matches[2].Trim().Trim('"').Trim("'")
            Set-Item -LiteralPath "env:$nome" -Value $valor
        }
    }
}

Import-DotEnv $EnvFile

$petshopProjectRef = $env:PETSHOP_SUPABASE_PROJECT_REF
$databaseUrl = $env:DATABASE_URL
if (-not $petshopProjectRef) {
    throw 'PETSHOP_SUPABASE_PROJECT_REF não foi definido. A trava impede usar um projeto genérico por engano.'
}
if (-not $databaseUrl) {
    throw 'DATABASE_URL não foi definida.'
}
if ($databaseUrl -notmatch [regex]::Escape($petshopProjectRef)) {
    throw 'DATABASE_URL não contém PETSHOP_SUPABASE_PROJECT_REF. Execução bloqueada para proteger outro projeto.'
}

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    throw 'psql não está instalado ou não está no PATH.'
}

if (-not $SkipGenerate) {
    & node (Join-Path $PSScriptRoot 'etl\main.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Geração do ETL falhou com código $LASTEXITCODE" }
}

$generatedDir = Join-Path $PSScriptRoot 'sql\generated'
$manifestPath = Join-Path $generatedDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Manifesto da carga não encontrado: $manifestPath"
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$idCarga = [string]$manifest.idCarga

$scripts = @(
    (Join-Path $PSScriptRoot 'sql\00_preflight.sql'),
    (Join-Path $PSScriptRoot 'sql\02_stg_ddl.sql'),
    (Join-Path $generatedDir '10_stg_raw.sql'),
    (Join-Path $generatedDir '20_stg_map.sql'),
    (Join-Path $generatedDir '30_stg_cln.sql'),
    (Join-Path $generatedDir '40_load_dw.sql')
)

foreach ($script in $scripts) {
    if (-not (Test-Path -LiteralPath $script)) { throw "SQL ausente: $script" }
}

if (-not $PSCmdlet.ShouldProcess(
    "Supabase PetShop $petshopProjectRef",
    "aplicar preflight, staging e lote $idCarga"
)) {
    return
}

try {
    foreach ($script in $scripts) {
        Write-Host "Executando $([IO.Path]::GetFileName($script))..."
        & $psql.Source $databaseUrl -X -v ON_ERROR_STOP=1 -f $script
        if ($LASTEXITCODE -ne 0) {
            throw "$([IO.Path]::GetFileName($script)) falhou com código $LASTEXITCODE"
        }
    }
} catch {
    $erroCarga = $_.Exception.Message
    & $psql.Source $databaseUrl -X -v ON_ERROR_STOP=1 `
        -v "id_carga=$idCarga" -v "erro_carga=$erroCarga" `
        -c "UPDATE stg.etl_carga SET status='falhou', finalizado_em=clock_timestamp(), erro=:'erro_carga' WHERE id_carga=:'id_carga'::uuid;" 2>$null
    throw
}

Write-Host "Carga $idCarga concluída no projeto $petshopProjectRef."

