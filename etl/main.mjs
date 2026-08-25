#!/usr/bin/env node
// =============================================================================
// ETL PetShop — ponto de entrada
// =============================================================================
//   node etl/main.mjs                  gera os SQL em sql/generated/
//   node etl/main.mjs --dry            só o relatório, não escreve arquivo
//   node etl/main.mjs --dados ./data   aponta outro diretório de origem
//
// Não toca no banco: gera SQL para você revisar e rodar. Sai com código 1 se a
// conformação falhar, para que o passo quebre em CI em vez de gerar SQL ruim.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extrairTudo } from './extract.mjs';
import { conformarTudo } from './conform.mjs';
import { emitirRaw, emitirMap, emitirCln, emitirCarga } from './emit.mjs';
import { ARQUIVOS } from './config.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..');

function args() {
  const a = process.argv.slice(2);
  const pegar = nome => {
    const i = a.indexOf(nome);
    return i >= 0 ? a[i + 1] : null;
  };
  return {
    dry: a.includes('--dry'),
    dados: resolve(pegar('--dados') ?? join(RAIZ, 'data')),
    saida: resolve(pegar('--saida') ?? join(RAIZ, 'sql', 'generated')),
    idCarga: pegar('--id-carga') ?? randomUUID(),
    dataEfetiva: pegar('--data-efetiva') ?? new Date().toISOString(),
  };
}

export function criarContextoCarga(dados, idCarga, dataEfetiva) {
  const vistos = new Set();
  const manifest = [];
  for (const { arquivo } of Object.values(ARQUIVOS)) {
    if (vistos.has(arquivo)) continue;
    vistos.add(arquivo);
    const caminho = join(dados, arquivo);
    const bytes = readFileSync(caminho);
    manifest.push({
      arquivo,
      bytes: statSync(caminho).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { idCarga, dataEfetiva, origem: dados, manifest };
}

function titulo(t) {
  console.log('\n' + t);
  console.log('─'.repeat(t.length));
}

function main() {
  const { dry, dados, saida, idCarga, dataEfetiva } = args();
  const contexto = criarContextoCarga(dados, idCarga, dataEfetiva);

  titulo('1. Extração');
  console.log(`origem: ${dados}`);
  const fontes = extrairTudo(dados);
  for (const f of ['salvador', 'itabuna', 'feira']) {
    const s = fontes[f];
    console.log(`  ${f.padEnd(9)} produtos=${String(s.produtos.length).padStart(4)} ` +
                `clientes=${String(s.clientes.length).padStart(4)} ` +
                `vendas=${String(s.vendas.length).padStart(4)} ` +
                `itens=${String(s.itens.length).padStart(5)}` +
                (s.servicos.length ? `  servicos=${s.servicos.length} atendimentos=${s.atendimentos.length}` : ''));
  }
  console.log(`  ${'concorrente'.padEnd(9)} linhas=${fontes.concorrente.length}`);
  console.log(`  id_carga  ${contexto.idCarga}`);

  titulo('2. Conformação');
  const c = conformarTudo(fontes);
  const r = c.resumo;
  console.log(`  produtos conformados      ${r.produtos} (${r.produtos - 1} reais + 1 sentinela)`);
  console.log(`  entradas de de-para       ${r.deparaProduto}`);
  console.log(`  estado civil              ${r.estadoCivil} membros`);
  console.log(`  calendário                ${r.calendario} dias`);
  console.log(`  fatos de venda            ${r.fatos}`);
  console.log(`  fatos de concorrente      ${r.concorrente}`);
  console.log(`  rejeitados                ${r.rejeitos}`);
  console.log(`  reconciliação             ${r.itensOrigem} itens = ${r.fatos} + ${r.rejeitos} ✓`);

  titulo('3. Catálogo derivado');
  for (const p of c.catalogo) {
    console.log(`  ${String(p.id_produto).padStart(3)}  ${p.produto.padEnd(26)} ` +
                `${p.categoria.padEnd(14)} ${p.observacao ?? ''}`);
  }

  titulo('4. De-para de produto (ids que colidem entre fontes)');
  const porId = new Map();
  for (const d of c.deparaProduto) {
    if (!porId.has(d.id_conformado)) porId.set(d.id_conformado, {});
    const e = porId.get(d.id_conformado);
    e[d.fonte] = [...(e[d.fonte] ?? []), d.id_origem].join(',');
  }
  console.log(`  ${'produto'.padEnd(28)} ${'SAL'.padStart(5)} ${'ITA'.padStart(6)} ${'FEI'.padStart(5)}`);
  for (const p of c.catalogo) {
    const e = porId.get(p.id_produto);
    if (!e) continue;
    console.log(`  ${p.produto.padEnd(28)} ${String(e.salvador ?? '—').padStart(5)} ` +
                `${String(e.itabuna ?? '—').padStart(6)} ${String(e.feira ?? '—').padStart(5)}`);
  }

  if (c.rejeitos.length) {
    titulo('5. Quarentena');
    const agrupado = new Map();
    for (const rj of c.rejeitos) {
      const k = `${rj.fonte} | ${rj.motivo.replace(/\d+/g, 'N')}`;
      agrupado.set(k, (agrupado.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...agrupado].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${k}`);
    }
  }

  if (c.avisos.length) {
    titulo('6. Avisos');
    for (const a of c.avisos) console.log(`  • ${a}`);
  }

  const arquivos = {
    '10_stg_raw.sql': emitirRaw(fontes, contexto),
    '20_stg_map.sql': emitirMap(c, contexto),
    '30_stg_cln.sql': emitirCln(c, contexto),
    '40_load_dw.sql': emitirCarga(contexto),
  };

  titulo(dry ? '7. Geração (--dry: nada escrito)' : '7. Geração');
  if (!dry) mkdirSync(saida, { recursive: true });
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const kb = (Buffer.byteLength(conteudo, 'utf8') / 1024).toFixed(1);
    if (!dry) writeFileSync(join(saida, nome), conteudo, 'utf8');
    console.log(`  ${nome.padEnd(18)} ${kb.padStart(8)} KB`);
  }
  if (!dry) {
    writeFileSync(join(saida, 'manifest.json'), JSON.stringify({
      ...contexto,
      resumo: c.resumo,
      avisos: c.avisos,
    }, null, 2) + '\n', 'utf8');
    console.log(`  ${'manifest.json'.padEnd(18)} ${'auditoria'.padStart(8)}`);
  }
  if (!dry) console.log(`\ndestino: ${saida}`);

  titulo('Próximo passo');
  console.log('  Rode no banco, nesta ordem:');
  console.log('    sql/00_preflight.sql         (corrige e valida o DW existente)');
  console.log('    sql/02_stg_ddl.sql           (cria/atualiza o schema stg)');
  console.log('    sql/generated/10_stg_raw.sql');
  console.log('    sql/generated/20_stg_map.sql');
  console.log('    sql/generated/30_stg_cln.sql');
  console.log('    sql/generated/40_load_dw.sql');
  console.log('\n  Use a string Session pooler sem senha e valide primeiro:');
  console.log('  npm run deploy -- --project-ref <REF> --database-url "<URL>" --check');
  console.log('  Depois repita com --yes para aplicar a carga.\n');
}

try {
  main();
} catch (e) {
  console.error(`\nERRO: ${e.message}\n`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
}
