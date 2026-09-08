import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extrairTudo } from '../etl/extract.mjs';
import { conformarTudo, paraIso } from '../etl/conform.mjs';
import { emitirCarga, emitirCln, lit } from '../etl/emit.mjs';
import { validarDestino, validarRef } from '../etl/deploy.mjs';
import { extrairInserts } from '../etl/lib/sqlparse.mjs';
import { FATOR_FATO } from '../etl/config.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DADOS = resolve(AQUI, '..', 'data');
const CONTEXTO = {
  idCarga: '11111111-1111-4111-8111-111111111111',
  dataEfetiva: '2026-08-25T12:00:00.000Z',
  origem: DADOS,
  manifest: [],
};

test('deploy aceita somente o projeto Supabase explicitamente declarado', () => {
  const ref = validarRef('abcdefghijklmnopqrst');
  assert.equal(
    validarDestino(`postgresql://postgres@db.${ref}.supabase.co:5432/postgres`, ref).hostname,
    `db.${ref}.supabase.co`,
  );
  assert.throws(
    () => validarDestino('postgresql://postgres@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres', ref),
    /Destino bloqueado/,
  );
  assert.throws(() => validarRef('ref-incorreta'), /20 caracteres/);
});

test('parser preserva vírgula e aspas dentro de strings SQL', () => {
  const linhas = extrairInserts(
    "INSERT INTO produtos (nome, preco) VALUES ('Racao, Caes'' Adultos', 12.50);"
  );
  assert.equal(linhas.length, 1);
  assert.deepEqual(linhas[0].valores, ["Racao, Caes' Adultos", '12.50']);
});

test('datas das três representações viram ISO e datas inválidas são rejeitadas', () => {
  assert.equal(paraIso('15/01/2025'), '2025-01-15');
  assert.equal(paraIso('2025-01-15'), '2025-01-15');
  assert.equal(paraIso('31/02/2025'), null);
  assert.equal(paraIso('texto'), null);
});

test('literal SQL escapa aspas e rejeita números não finitos', () => {
  assert.equal(lit("d'Ávila"), "'d''Ávila'");
  assert.throws(() => lit(Number.NaN), /não finito/);
});

test('fontes completas reconciliam exatamente com o fato', () => {
  const fontes = extrairTudo(DADOS);
  const c = conformarTudo(fontes);

  assert.equal(c.resumo.itensOrigem, 6621);
  assert.equal(c.resumo.fatos, 6621);
  // public.fat_vendas e agregado: uma linha por produto x loja x quadrimestre
  // x estado civil. O grao de item fica so em stg.cln_fat_vendas.
  assert.equal(c.resumo.fatosAgregados, 1382);
  assert.equal(c.resumo.rejeitos, 0);
  // 24 meses de origem agregados em 6 quadrimestres
  assert.equal(c.resumo.concorrente, 6);
  assert.equal(c.catalogo.length, 18);
  assert.equal(c.lojas.length, 3);
  // dim_data tem grão quadrimestral: 3 linhas por ano em 2024-2025
  assert.equal(c.calendario.length, 6);

  const valor = c.fatos.reduce((s, f) => s + Number(f.valor_venda), 0);
  assert.equal(Number(valor.toFixed(2)), 1309440.83);
});

test('agregação do fato preserva unidade e dinheiro e declara o grão na chave', () => {
  const c = conformarTudo(extrairTudo(DADOS));

  // Nada some entre o grão de item e o grão do DW.
  const soma = (linhas, campo) => linhas.reduce((t, l) => t + Number(l[campo]), 0);
  assert.equal(soma(c.fatosAgregados, 'quantidade'), soma(c.fatos, 'quantidade'));
  assert.equal(Number(soma(c.fatosAgregados, 'valor_venda').toFixed(2)), 1309440.83);
  assert.equal(soma(c.fatosAgregados, 'itens_agregados'), c.fatos.length);

  // Uma linha por combinação dimensional — é isso que o grão significa.
  const combinacoes = new Set(c.fatosAgregados.map(
    f => `${f.id_produto}|${f.id_loja}|${f.id_data}|${f.id_estado_civil}`));
  assert.equal(combinacoes.size, c.fatosAgregados.length);

  // E a chave codificada devolve a combinação que a linha declara.
  for (const f of c.fatosAgregados) {
    assert.equal(Math.floor(f.id_venda / FATOR_FATO.data), f.id_data);
    assert.equal(Math.floor(f.id_venda / FATOR_FATO.loja) % 10, f.id_loja);
    assert.equal(Math.floor(f.id_venda / FATOR_FATO.produto) % 1000, f.id_produto);
    assert.equal(f.id_venda % 1000, f.id_estado_civil);
  }

  // A âncora do lookup SCD2 é o primeiro dia do quadrimestre da própria linha.
  const periodoPor = new Map(c.calendario.map(d => [d.id_data, d]));
  for (const f of c.fatosAgregados) {
    const d = periodoPor.get(f.id_data);
    const mes = String((d.quadrimestre - 1) * 4 + 1).padStart(2, '0');
    assert.equal(f.data_referencia, `${d.ano}-${mes}-01`);
  }
});

test('dim_data é quadrimestral e id_data é sequencial na ordem cronológica', () => {
  const c = conformarTudo(extrairTudo(DADOS));

  assert.deepEqual(c.calendario, [
    { id_data: 1, ano: 2024, quadrimestre: 1 },
    { id_data: 2, ano: 2024, quadrimestre: 2 },
    { id_data: 3, ano: 2024, quadrimestre: 3 },
    { id_data: 4, ano: 2025, quadrimestre: 1 },
    { id_data: 5, ano: 2025, quadrimestre: 2 },
    { id_data: 6, ano: 2025, quadrimestre: 3 },
  ]);

  // Nenhum fato pode apontar para fora do calendário, e o id_data gravado tem
  // que bater com o quadrimestre da data real que ficou no staging.
  const porId = new Map(c.calendario.map(l => [l.id_data, l]));
  for (const f of c.fatos) {
    const linha = porId.get(f.id_data);
    assert.ok(linha, `fato ${f.id_venda} com id_data ${f.id_data} fora do calendário`);
    assert.equal(linha.ano, Number(f.data.slice(0, 4)));
    assert.equal(linha.quadrimestre, Math.ceil(Number(f.data.slice(5, 7)) / 4));
  }
});

test('agregação do concorrente preserva valor e contabiliza os 24 meses', () => {
  const fontes = extrairTudo(DADOS);
  const c = conformarTudo(fontes);

  const origem = fontes.concorrente.reduce((t, l) => t + Number(l.valor_venda), 0);
  const agregado = c.concorrente.reduce((t, f) => t + Number(f.valor_venda), 0);
  assert.equal(Number(agregado.toFixed(2)), Number(origem.toFixed(2)));

  const meses = c.concorrente.reduce((t, f) => t + f.meses_agregados, 0);
  assert.equal(meses, fontes.concorrente.length);
  assert.equal(meses, 24);

  // O grão é o quadrimestre: uma linha por id_data, sem duplicata.
  assert.equal(new Set(c.concorrente.map(f => f.id_data)).size, c.concorrente.length);
  // quantidade continua 0 e significa "não medido", nunca "vendeu zero".
  assert.ok(c.concorrente.every(f => f.quantidade === 0));
});

test('SQL de transformação isola rejeições pelo id da carga', () => {
  const c = conformarTudo(extrairTudo(DADOS));
  const sql = emitirCln(c, CONTEXTO);
  assert.match(sql, /DELETE FROM stg\.rej_carga WHERE id_carga =/);
  assert.match(sql, /status = 'transformada'/);
});

test('SQL final implementa SCD2, lock e valida antes do commit', () => {
  const sql = emitirCarga(CONTEXTO);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /UPDATE public\.dim_produto/);
  assert.match(sql, /ultima_versao \+ 1/);
  assert.match(sql, /c\.data_referencia::timestamp >= p\.data_inicio/);
  // o DW é quadrimestral: os fatos carregam id_data, nunca a data
  assert.match(sql, /INSERT INTO public\.fat_vendas\s*\n\s*\(id_venda, sk_produto, sk_loja, id_data,/);
  assert.match(sql, /INSERT INTO public\.dim_data \(id_data, ano, quadrimestre\)/);
  assert.match(sql, /agregação do concorrente: % meses na origem/);
  // fat_vendas vem pronto do conformador: projeção, nunca GROUP BY na carga
  assert.match(sql, /FROM stg\.cln_fat_vendas_dw c/);
  const insercao = sql.slice(sql.indexOf('INSERT INTO public.fat_vendas'));
  assert.doesNotMatch(insercao.slice(0, insercao.indexOf(';')), /GROUP BY/);
  // e a carga recusa commit se a agregação ou o grão não fecharem
  assert.match(sql, /stg\.vw_check_agregacao_vendas/);
  assert.match(sql, /grão violado — combinação dimensional repetida/);
  assert.match(sql, /status = 'concluida'/);

  const validacao = sql.indexOf('Falhar aqui desfaz');
  const commit = sql.lastIndexOf('COMMIT;');
  assert.ok(validacao >= 0 && validacao < commit, 'a validação deve ocorrer antes do COMMIT');
});
