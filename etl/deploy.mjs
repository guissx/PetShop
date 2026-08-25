import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const RAIZ = resolve(import.meta.dirname, '..');
const TABELAS_DW = [
  'dim_produto',
  'dim_loja',
  'dim_estado_civil',
  'dim_data',
  'fat_vendas',
  'fat_concorrente',
];

export function validarRef(ref) {
  if (!/^[a-z0-9]{20}$/.test(ref ?? '')) {
    throw new Error('PETSHOP_SUPABASE_PROJECT_REF deve conter exatamente os 20 caracteres do projeto.');
  }
  return ref;
}

export function validarDestino(databaseUrl, ref) {
  const url = new URL(databaseUrl);
  const hostDireto = `db.${ref}.supabase.co`;
  const pooler = url.hostname.endsWith('.pooler.supabase.com')
    && decodeURIComponent(url.username) === `postgres.${ref}`;

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL deve usar o protocolo postgresql://.');
  }
  if (url.hostname !== hostDireto && !pooler) {
    throw new Error(`Destino bloqueado: a conexão não pertence ao projeto ${ref}.`);
  }
  if (url.pathname !== '/postgres') {
    throw new Error('Destino bloqueado: o banco precisa ser postgres.');
  }
  return url;
}

async function importarEnv(caminho) {
  if (!existsSync(caminho)) return;
  const texto = await readFile(caminho, 'utf8');
  for (const linha of texto.split(/\r?\n/)) {
    const match = linha.match(/^\s*([^#\s][^=]*)=(.*)$/);
    if (!match) continue;
    const nome = match[1].trim();
    let valor = match[2].trim();
    if ((valor.startsWith('"') && valor.endsWith('"'))
      || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    if (!(nome in process.env)) process.env[nome] = valor;
  }
}

function obterArgumentos(argv) {
  const args = { gerar: true, confirmar: false, somenteVerificar: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-ref') args.ref = argv[++i];
    else if (arg === '--database-url') args.databaseUrl = argv[++i];
    else if (arg === '--env') args.env = argv[++i];
    else if (arg === '--skip-generate') args.gerar = false;
    else if (arg === '--yes') args.confirmar = true;
    else if (arg === '--check') args.somenteVerificar = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return args;
}

async function pedirSenhaOculta() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Defina DATABASE_URL em .env quando não houver terminal interativo.');
  }

  process.stdout.write('Senha do banco (não será gravada): ');
  return new Promise((resolveSenha, reject) => {
    let senha = '';
    const estavaRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const finalizar = () => {
      process.stdin.off('data', aoDigitar);
      process.stdin.setRawMode(estavaRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const aoDigitar = (trecho) => {
      for (const caractere of trecho) {
        if (caractere === '\u0003') {
          finalizar();
          reject(new Error('Operação cancelada.'));
          return;
        }
        if (caractere === '\r' || caractere === '\n') {
          finalizar();
          resolveSenha(senha);
          return;
        }
        if (caractere === '\u007f' || caractere === '\b') senha = senha.slice(0, -1);
        else senha += caractere;
      }
    };
    process.stdin.on('data', aoDigitar);
  });
}

async function montarUrl(args, ref) {
  if (args.databaseUrl || process.env.DATABASE_URL) {
    const url = validarDestino(args.databaseUrl || process.env.DATABASE_URL, ref);
    if (!url.password) url.password = await pedirSenhaOculta();
    return url.toString();
  }

  const senha = await pedirSenhaOculta();
  const url = new URL(`postgresql://postgres@db.${ref}.supabase.co:5432/postgres`);
  url.password = senha;
  return validarDestino(url.toString(), ref).toString();
}

async function aplicarArquivo(client, caminho) {
  const sql = await readFile(caminho, 'utf8');
  process.stdout.write(`Aplicando ${basename(caminho)}... `);
  await client.query(sql);
  console.log('ok');
}

async function inspecionar(client) {
  const identidade = await client.query(`
    SELECT current_database() AS banco,
           current_user AS usuario,
           inet_server_addr()::text AS endereco,
           version() AS versao
  `);
  const objetos = await client.query(`
    SELECT nome,
           to_regclass(format('public.%I', nome)) IS NOT NULL AS existe
    FROM unnest($1::text[]) AS nome
    ORDER BY nome
  `, [TABELAS_DW]);
  return { identidade: identidade.rows[0], objetos: objetos.rows };
}

async function marcarFalha(client, idCarga, erro) {
  if (!idCarga) return;
  try {
    await client.query(`
      UPDATE stg.etl_carga
         SET status = 'falhou', finalizado_em = clock_timestamp(), erro = $2
       WHERE id_carga = $1::uuid
    `, [idCarga, String(erro).slice(0, 4000)]);
  } catch {
    // A tabela de auditoria pode ainda não existir; o erro original prevalece.
  }
}

async function main() {
  const args = obterArgumentos(process.argv.slice(2));
  await importarEnv(resolve(RAIZ, args.env ?? '.env'));
  const ref = validarRef(args.ref ?? process.env.PETSHOP_SUPABASE_PROJECT_REF);
  const databaseUrl = await montarUrl(args, ref);

  const client = new Client({
    connectionString: databaseUrl,
    // Equivale a sslmode=require. A lista de hosts aceita é validada acima.
    ssl: { rejectUnauthorized: false },
    application_name: 'petshop_etl',
    connectionTimeoutMillis: 20_000,
    query_timeout: 120_000,
  });

  let idCarga;
  let conectado = false;
  try {
    await client.connect();
    conectado = true;
    const diagnostico = await inspecionar(client);
    console.log(`Conexão confirmada: projeto ${ref}, banco ${diagnostico.identidade.banco}, usuário ${diagnostico.identidade.usuario}.`);
    console.table(diagnostico.objetos);

    if (args.somenteVerificar) return;
    if (!args.confirmar) {
      throw new Error('Inspeção concluída. Use --yes para autorizar DDL e carga nesse destino validado.');
    }

    const existentes = diagnostico.objetos.filter((item) => item.existe).length;
    if (existentes !== 0 && existentes !== TABELAS_DW.length) {
      throw new Error(`Esquema parcial detectado (${existentes}/${TABELAS_DW.length}); carga bloqueada para revisão manual.`);
    }

    if (args.gerar) {
      const { spawnSync } = await import('node:child_process');
      const resultado = spawnSync(process.execPath, [resolve(RAIZ, 'etl/main.mjs')], {
        cwd: RAIZ,
        stdio: 'inherit',
      });
      if (resultado.status !== 0) throw new Error(`Geração do ETL falhou com código ${resultado.status}.`);
    }

    const gerados = resolve(RAIZ, 'sql/generated');
    const manifesto = JSON.parse(await readFile(resolve(gerados, 'manifest.json'), 'utf8'));
    idCarga = manifesto.idCarga;
    const scripts = [];
    if (existentes === 0) scripts.push(resolve(RAIZ, 'sql/01_dw_ddl.sql'));
    scripts.push(
      resolve(RAIZ, 'sql/00_preflight.sql'),
      resolve(RAIZ, 'sql/02_stg_ddl.sql'),
      resolve(gerados, '10_stg_raw.sql'),
      resolve(gerados, '20_stg_map.sql'),
      resolve(gerados, '30_stg_cln.sql'),
      resolve(gerados, '40_load_dw.sql'),
    );

    for (const script of scripts) await aplicarArquivo(client, script);
    console.log(`Carga ${idCarga} concluída no projeto ${ref}.`);
  } catch (erro) {
    if (conectado) await marcarFalha(client, idCarga, erro.message);
    throw erro;
  } finally {
    if (conectado) await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((erro) => {
    console.error(`ERRO: ${erro.message}`);
    process.exitCode = 1;
  });
}
