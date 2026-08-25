import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extrairTudo } from '../etl/extract.mjs';
import { conformarTudo, paraIso } from '../etl/conform.mjs';
import { emitirCarga, emitirCln, lit } from '../etl/emit.mjs';
import { validarDestino, validarRef } from '../etl/deploy.mjs';
import { extrairInserts } from '../etl/lib/sqlparse.mjs';

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
  assert.equal(c.resumo.rejeitos, 0);
  assert.equal(c.resumo.concorrente, 24);
  assert.equal(c.catalogo.length, 18);
  assert.equal(c.lojas.length, 3);
  assert.equal(c.calendario.length, 731);

  const valor = c.fatos.reduce((s, f) => s + Number(f.valor_venda), 0);
  assert.equal(Number(valor.toFixed(2)), 1309440.83);
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
  assert.match(sql, /c\.data::timestamp >= p\.data_inicio/);
  assert.match(sql, /status = 'concluida'/);

  const validacao = sql.indexOf('Falhar aqui desfaz');
  const commit = sql.lastIndexOf('COMMIT;');
  assert.ok(validacao >= 0 && validacao < commit, 'a validação deve ocorrer antes do COMMIT');
});
