#!/usr/bin/env node
// =============================================================================
// Gera um script único para colar no SQL Editor do Supabase
// =============================================================================
//   node scripts/gerar-migracao-supabase.mjs
//
// Emite sql/migracao_fat_vendas_agregado.sql: migra public.fat_vendas do grão
// de item (6.621 linhas) para o grão agregado (1.382) e recria as views de BI.
//
// POR QUE ESTE ARQUIVO EXISTE, se já há um pipeline completo em sql/generated/:
// aquele pipeline reconstrói tudo a partir das fontes e passa de 1,5 MB — o
// editor do navegador não é lugar para isso. Este script carrega só o que muda,
// com as 1.382 linhas já agregadas como literais, e cabe folgado no editor.
//
// A agregação continua sendo feita pelo conformador (etl/conform.mjs), não por
// GROUP BY no SQL: este arquivo apenas TRANSPORTA o resultado, exatamente como
// 30_stg_cln.sql faz. As mesmas invariantes valem, e o bloco de validação as
// reafirma dentro da transação, antes do COMMIT.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extrairTudo } from '../etl/extract.mjs';
import { conformarTudo } from '../etl/conform.mjs';
import { lit } from '../etl/emit.mjs';
import { FATOR_FATO } from '../etl/config.mjs';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOTE = 500;

const c = conformarTudo(extrairTudo(resolve(RAIZ, 'data')));
const fatos = c.fatosAgregados;

// Totais esperados, derivados dos dados — nunca digitados.
const totalQuantidade = fatos.reduce((t, f) => t + f.quantidade, 0);
const totalCentavos = fatos.reduce((t, f) => t + Math.round(Number(f.valor_venda) * 100), 0);
const totalValor = (totalCentavos / 100).toFixed(2);
const totalItens = fatos.reduce((t, f) => t + f.itens_agregados, 0);

const colunas = ['id_venda', 'sk_produto', 'sk_loja', 'id_data', 'id_estado_civil',
                 'quantidade', 'valor_venda', 'itens_agregados', 'data_referencia'];

function insertsDoFato() {
  const out = [];
  for (let i = 0; i < fatos.length; i += LOTE) {
    const tuplas = fatos.slice(i, i + LOTE)
      .map(f => '  (' + colunas
        .map(col => lit(col === 'sk_produto' ? f.id_produto
                      : col === 'sk_loja' ? f.id_loja
                      : f[col]))
        .join(', ') + ')')
      .join(',\n');
    out.push(`INSERT INTO stg.cln_fat_vendas_dw (${colunas.join(', ')}) VALUES\n${tuplas};`);
  }
  return out.join('\n\n');
}

// As views de BI vêm do arquivo de verdade, sem cópia manual: só o controle de
// transação sai, porque aqui elas entram na transação deste script.
async function viewsDeBi() {
  const sql = await readFile(resolve(RAIZ, 'sql/03_dashboard_views.sql'), 'utf8');
  return sql
    .replace(/^-- Somente views.*\n/m, '')
    .replace(/^BEGIN;\n/m, '')
    .replace(/^COMMIT;\s*$/m, '')
    .trim();
}

const cabecalho = `-- =============================================================================
-- Migração de grão de public.fat_vendas — item -> agregado
-- =============================================================================
-- ARQUIVO GERADO por scripts/gerar-migracao-supabase.mjs — NÃO EDITE À MÃO.
--
-- Cole inteiro no SQL Editor do Supabase e execute uma vez. Tudo roda numa
-- transação só: se qualquer conferência falhar, nada é aplicado.
--
-- O QUE MUDA
--   public.fat_vendas deixa o grão de item e passa ao grão das próprias
--   dimensões — produto x loja x quadrimestre x estado civil.
--   ${String(totalItens).padEnd(6)} itens de venda  ->  ${fatos.length} linhas de fato
--   Unidades e receita NÃO mudam: ${totalQuantidade} unidades, R$ ${totalValor}.
--
--   id_venda deixa de ser o número do pedido (que no grão agregado não existe)
--   e passa a codificar a combinação dimensional:
--     id_venda = id_data * ${FATOR_FATO.data} + id_loja * ${FATOR_FATO.loja}
--              + id_produto * ${FATOR_FATO.produto} + id_estado_civil
--   Com isso a PK declara o grão: duas linhas da mesma combinação colidem na
--   chave em vez de duplicar medida em silêncio.
--
-- O QUE NÃO MUDA
--   Nenhum DDL de public. As dimensões não são tocadas — este script depende
--   delas já estarem carregadas, e falha se não estiverem.
--   stg.cln_fat_vendas continua no grão de item, com a data real da venda e o
--   número do pedido de origem. É lá que vivem contagem de pedidos, itens por
--   pedido e ticket médio, que deixam de ser deriváveis do schema public.
--
-- O QUE ESTE SCRIPT NÃO FAZ
--   Não recarrega as camadas raw/map/cln a partir das fontes. Para isso existe
--   o pipeline completo (sql/generated/, via npm run deploy), que é o caminho
--   auditável de ponta a ponta. Este arquivo é o atalho para aplicar só a
--   mudança de grão sem subir 1,5 MB pelo navegador.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('petshop_etl_dw'));
`;

const precondicoes = `
-- -----------------------------------------------------------------------------
-- 1. Precondições
-- -----------------------------------------------------------------------------
-- Falhar aqui é muito melhor do que truncar o fato e descobrir depois que uma
-- dimensão estava vazia: o INSERT seguinte simplesmente não acharia sk nenhum
-- e deixaria fat_vendas zerado, sem erro nenhum.
DO $$
DECLARE
    faltando text;
BEGIN
    SELECT string_agg(t, ', ') INTO faltando FROM (
        SELECT 'dim_produto'      AS t WHERE (SELECT count(*) FROM public.dim_produto WHERE flag_atual) = 0
        UNION ALL
        SELECT 'dim_loja'              WHERE (SELECT count(*) FROM public.dim_loja WHERE flag_atual) = 0
        UNION ALL
        SELECT 'dim_estado_civil'      WHERE (SELECT count(*) FROM public.dim_estado_civil) = 0
        UNION ALL
        SELECT 'dim_data'              WHERE (SELECT count(*) FROM public.dim_data) = 0
    ) f;
    IF faltando IS NOT NULL THEN
        RAISE EXCEPTION 'dimensão vazia: % — rode a carga completa antes', faltando;
    END IF;

    IF EXISTS (SELECT 1 FROM public.dim_data WHERE quadrimestre NOT BETWEEN 1 AND 3) THEN
        RAISE EXCEPTION 'dim_data não está no grão quadrimestral — rode sql/00_preflight.sql antes';
    END IF;
END $$;
`;

const tabelaStg = `
-- -----------------------------------------------------------------------------
-- 2. stg.cln_fat_vendas_dw — o grão do DW, no staging
-- -----------------------------------------------------------------------------
-- Mesma estrutura de sql/02_stg_ddl.sql. O UNIQUE DECLARA o grão: sem ele, uma
-- agregação malfeita duplicaria medida em silêncio.
--
-- stg.cln_fat_vendas NÃO é tocada. Ela continua no grão de item, e é o que
-- permite conferir esta migração contra o que já estava carregado.
CREATE SCHEMA IF NOT EXISTS stg;

CREATE TABLE IF NOT EXISTS stg.cln_fat_vendas_dw (
    id_venda         bigint        NOT NULL PRIMARY KEY,
    sk_produto       bigint        NOT NULL,
    sk_loja          bigint        NOT NULL,
    id_data          integer       NOT NULL,
    id_estado_civil  integer       NOT NULL,
    quantidade       integer       NOT NULL CHECK (quantidade > 0),
    valor_venda      numeric(14,2) NOT NULL CHECK (valor_venda >= 0),
    itens_agregados  integer       NOT NULL CHECK (itens_agregados > 0),
    data_referencia  date          NOT NULL,
    CONSTRAINT uq_cln_vendas_dw_grao UNIQUE (sk_produto, sk_loja, id_data, id_estado_civil)
);

REVOKE ALL ON stg.cln_fat_vendas_dw FROM anon, authenticated;

-- A view de conferência só existe se o grão de item estiver no banco; num
-- destino recém-criado ela é dispensável, e exigi-la aqui quebraria o script
-- por um motivo que não é erro.
DO $$
BEGIN
    IF to_regclass('stg.cln_fat_vendas') IS NULL THEN
        RAISE NOTICE 'stg.cln_fat_vendas ausente: vw_check_agregacao_vendas não criada';
        RETURN;
    END IF;
    EXECUTE $v$
        CREATE OR REPLACE VIEW stg.vw_check_agregacao_vendas
        WITH (security_invoker = true) AS
        SELECT i.itens                          AS itens_cln,
               a.itens_contabilizados,
               a.linhas_dw,
               i.itens - a.itens_contabilizados AS diferenca_itens,
               i.quantidade - a.quantidade      AS diferenca_quantidade,
               i.valor_venda - a.valor_venda    AS diferenca_valor
        FROM (SELECT count(*)                      AS itens,
                     coalesce(sum(quantidade), 0)  AS quantidade,
                     coalesce(sum(valor_venda), 0) AS valor_venda
                FROM stg.cln_fat_vendas) i
        CROSS JOIN (SELECT coalesce(sum(itens_agregados), 0) AS itens_contabilizados,
                           count(*)                          AS linhas_dw,
                           coalesce(sum(quantidade), 0)      AS quantidade,
                           coalesce(sum(valor_venda), 0)     AS valor_venda
                      FROM stg.cln_fat_vendas_dw) a
    $v$;
END $$;

TRUNCATE stg.cln_fat_vendas_dw;
`;

const carga = `
-- -----------------------------------------------------------------------------
-- 4. public.fat_vendas
-- -----------------------------------------------------------------------------
-- Snapshot completo, igual ao 40_load_dw.sql: o TRUNCATE e a recarga ficam na
-- mesma transação, então uma falha adiante devolve a tabela ao estado anterior.
TRUNCATE public.fat_vendas;

-- data_referencia (1º dia do quadrimestre) ancora o lookup SCD2. No grão
-- agregado não existe data real do fato, e dim_data é quadrimestral: a
-- resolução de versão de produto e loja é quadrimestral também.
INSERT INTO public.fat_vendas
    (id_venda, sk_produto, sk_loja, id_data, quantidade, valor_venda, id_estado_civil)
SELECT c.id_venda, p.sk_produto, l.sk_loja, c.id_data, c.quantidade,
       c.valor_venda, c.id_estado_civil
FROM stg.cln_fat_vendas_dw c
JOIN public.dim_produto p
  ON p.id_produto = c.sk_produto
 AND c.data_referencia::timestamp >= p.data_inicio
 AND c.data_referencia::timestamp <  p.data_fim
JOIN public.dim_loja l
  ON l.id_loja = c.sk_loja
 AND c.data_referencia::timestamp >= l.data_inicio
 AND c.data_referencia::timestamp <  l.data_fim;

-- -----------------------------------------------------------------------------
-- 5. Validação — falhar aqui desfaz o TRUNCATE junto
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    linhas integer;
    unidades bigint;
    receita numeric;
BEGIN
    SELECT count(*), sum(quantidade), sum(valor_venda)
      INTO linhas, unidades, receita
      FROM public.fat_vendas;

    IF linhas <> ${fatos.length} THEN
        RAISE EXCEPTION 'fat_vendas: % linhas esperadas, % carregadas — algum lookup SCD2 não resolveu',
                        ${fatos.length}, linhas;
    END IF;
    -- Contagem sozinha não basta: ela fecharia mesmo se as medidas viessem
    -- erradas. Unidade e dinheiro são o que o dashboard mostra.
    IF unidades <> ${totalQuantidade} OR receita <> ${totalValor} THEN
        RAISE EXCEPTION 'fat_vendas: esperado % unidades / R$ %, obtido % / R$ %',
                        ${totalQuantidade}, ${totalValor}, unidades, receita;
    END IF;
    -- O grão, afirmado no destino. A PK codificada já deveria garantir isto,
    -- mas quem decide o sk é o lookup SCD2: se ele devolvesse duas versões para
    -- a mesma combinação, a medida seria dividida em duas linhas.
    IF EXISTS (
        SELECT 1 FROM public.fat_vendas
        GROUP BY sk_produto, sk_loja, id_data, id_estado_civil
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'fat_vendas: grão violado — combinação dimensional repetida';
    END IF;
    -- O produto sentinela existe só para fat_concorrente.
    IF EXISTS (
        SELECT 1 FROM public.fat_vendas f
        JOIN public.dim_produto p ON p.sk_produto = f.sk_produto
        WHERE p.id_produto = 999
    ) THEN
        RAISE EXCEPTION 'produto sentinela apareceu em fat_vendas';
    END IF;
    -- Se o grão de item estiver no banco, confere a agregação contra ele.
    IF to_regclass('stg.cln_fat_vendas') IS NOT NULL
       AND (SELECT count(*) FROM stg.cln_fat_vendas) > 0
       AND EXISTS (SELECT 1 FROM stg.vw_check_agregacao_vendas
                    WHERE diferenca_itens <> 0
                       OR diferenca_quantidade <> 0
                       OR diferenca_valor <> 0) THEN
        RAISE EXCEPTION 'agregação não fecha com os itens em stg.cln_fat_vendas';
    END IF;

    RAISE NOTICE 'fat_vendas: % linhas, % unidades, R$ %', linhas, unidades, receita;
END $$;
`;

const conferencia = `
-- -----------------------------------------------------------------------------
-- Conferência (roda depois do COMMIT; nada aqui altera dado)
-- -----------------------------------------------------------------------------
SELECT 'fat_vendas' AS objeto, count(*)::bigint AS linhas,
       sum(quantidade)::bigint AS unidades, sum(valor_venda)::numeric AS receita
FROM public.fat_vendas
UNION ALL
SELECT 'vw_bi_vendas', count(*), sum(quantidade), sum(receita) FROM public.vw_bi_vendas
UNION ALL
SELECT 'stg.cln_fat_vendas (grão de item)', count(*), sum(quantidade), sum(valor_venda)
FROM stg.cln_fat_vendas;

-- As três diferenças DEVEM ser 0.
SELECT * FROM stg.vw_check_agregacao_vendas;

-- A chave codificada tem que reproduzir a combinação que a linha declara.
-- Qualquer linha com confere = false significa PK inconsistente com as FKs.
SELECT (f.id_venda / ${FATOR_FATO.data})::int AS id_data_decodificado,
       ((f.id_venda / ${FATOR_FATO.loja}) % ${FATOR_FATO.data / FATOR_FATO.loja})::int AS id_loja_decodificado,
       count(*) AS linhas,
       bool_and(
           (f.id_venda / ${FATOR_FATO.data})::int = f.id_data
       AND ((f.id_venda / ${FATOR_FATO.loja}) % ${FATOR_FATO.data / FATOR_FATO.loja})::int = l.id_loja
       AND ((f.id_venda / ${FATOR_FATO.produto}) % ${FATOR_FATO.loja / FATOR_FATO.produto})::int = p.id_produto
       AND (f.id_venda % ${FATOR_FATO.produto})::int = f.id_estado_civil
       ) AS confere
FROM public.fat_vendas f
JOIN public.dim_loja l ON l.sk_loja = f.sk_loja
JOIN public.dim_produto p ON p.sk_produto = f.sk_produto
GROUP BY 1, 2
ORDER BY 1, 2;
`;

const sql = [
  cabecalho,
  precondicoes,
  tabelaStg,
  `
-- -----------------------------------------------------------------------------
-- 3. As ${fatos.length} linhas agregadas
-- -----------------------------------------------------------------------------
-- Derivadas por etl/conform.mjs a partir dos ${totalItens} itens das fontes, com as
-- somas conferidas em centavos inteiros antes de virarem literal aqui.
${insertsDoFato()}
`,
  carga,
  `
-- -----------------------------------------------------------------------------
-- 6. Views de BI
-- -----------------------------------------------------------------------------
-- Conteúdo de sql/03_dashboard_views.sql. A medida de itens deixou de existir
-- (no grão agregado o DW não sabe quantas linhas de pedido formaram cada fato),
-- e CREATE OR REPLACE VIEW não remove coluna — daí o DROP ordenado.
${await viewsDeBi()}
`,
  '\nCOMMIT;\n',
  conferencia,
].join('\n');

const destino = resolve(RAIZ, 'sql/migracao_fat_vendas_agregado.sql');
await writeFile(destino, sql, 'utf8');
console.log(`${destino}`);
console.log(`  ${fatos.length} linhas de fato, ${totalQuantidade} unidades, R$ ${totalValor}`);
console.log(`  ${(Buffer.byteLength(sql, 'utf8') / 1024).toFixed(1)} KB`);
