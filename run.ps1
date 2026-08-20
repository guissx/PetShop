# Carrega o .env no ambiente e abre o Claude Code.
# Uso:  .\run.ps1
$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envFile)) { Write-Error "Arquivo .env nao encontrado em $PSScriptRoot"; exit 1 }

Get-Content $envFile | Where-Object { $_ -match '^\s*[^#\s].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$($k.Trim())" -Value $v.Trim().Trim('"').Trim("'")
}

if (-not $env:SUPABASE_ACCESS_TOKEN) { Write-Warning 'SUPABASE_ACCESS_TOKEN vazio' }
if (-not $env:SUPABASE_PROJECT_REF)  { Write-Warning 'SUPABASE_PROJECT_REF vazio' }

claude @args
