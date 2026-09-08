// =============================================================================
// Emissão — gera os arquivos SQL a partir do resultado da conformação
// =============================================================================
// O ETL não escreve no banco: ele GERA SQL. Três motivos:
//   1. o MCP configurado é --read-only, então a escrita não passa por ele;
//   2. SQL gerado é revisável antes de rodar, e roda no SQL editor sem instalar
//      nada (não há psycopg/driver no ambiente);
//   3. o arquivo gerado é o registro auditável do que foi carregado.
//
// Os arquivos saem em sql/generated/ e são REGERÁVEIS: apague e rode de novo.
// Não edite à mão — edite config.mjs ou conform.mjs.
// =============================================================================

import { FATOR_LOJA, FATOR_VENDA, FATOR_FATO, CALENDARIO, PRODUTO_SENTINELA } from './config.mjs';

const LOTE = 500;   // linhas por INSERT; mantém as instruções digeríveis

// -----------------------------------------------------------------------------
// Literais SQL
// -----------------------------------------------------------------------------
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`número não finito ao gerar SQL: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // Aspa simples dobrada. Barra invertida não precisa de escape: o PostgreSQL
  // usa standard_conforming_strings desde a 9.1.
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inserts(tabela, colunas, linhas) {
  if (!linhas.length) return `-- (sem linhas para ${tabela})\n`;
  const out = [];
  for (let i = 0; i < linhas.length; i += LOTE) {
    const lote = linhas.slice(i, i + LOTE);
    const tuplas = lote
      .map(l => '  (' + colunas.map(c => lit(l[c])).join(', ') + ')')
      .join(',\n');
    out.push(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES\n${tuplas};\n`);
  }
  return out.join('\n');
}

function cabecalho(titulo, descricao) {
  return [
    '-- ' + '='.repeat(77),
    `-- ${titulo}`,
    '-- ' + '='.repeat(77),
    '-- ARQUIVO GERADO por etl/main.mjs — NÃO EDITE À MÃO.',
    '-- Para mudar o conteúdo, edite etl/config.mjs ou etl/conform.mjs e rode',
    '-- de novo:  node etl/main.mjs',
    '--',
    ...descricao.split('\n').map(l => `-- ${l}`.trimEnd()),
    '-- ' + '='.repeat(77),
    '',
  ].join('\n');
}

// =============================================================================
// 10 — camada raw
// =============================================================================
export function emitirRaw(fontes, contexto) {
  const p = [];
  const idCarga = contexto.idCarga;
  p.push(cabecalho('stg.raw_* — espelho fiel das fontes',
    'Tudo text, nada interpretado. As datas do Salvador continuam em DD/MM/YYYY.\n' +
    '`ordem_arquivo` é a posição no arquivo de origem e NÃO é decorativa: no\n' +
    'Itabuna as chaves são SERIAL, logo o id da entidade É a posição.'));

  p.push('BEGIN;');
  p.push("SELECT pg_advisory_xact_lock(hashtext('petshop_etl_staging'));\n");
  p.push(`INSERT INTO stg.etl_carga
    (id_carga, status, origem, data_efetiva, manifesto, resumo, finalizado_em, erro)
VALUES
    (${lit(idCarga)}::uuid, 'iniciada', ${lit(contexto.origem)},
     ${lit(contexto.dataEfetiva)}::timestamptz, ${lit(JSON.stringify(contexto.manifest))}::jsonb,
     '{}'::jsonb, NULL, NULL)
ON CONFLICT (id_carga) DO UPDATE SET
    status = 'iniciada', origem = EXCLUDED.origem,
    data_efetiva = EXCLUDED.data_efetiva, manifesto = EXCLUDED.manifesto,
    resumo = '{}'::jsonb, finalizado_em = NULL, erro = NULL;\n`);
  p.push('TRUNCATE stg.raw_produto, stg.raw_categoria, stg.raw_cliente,');
  p.push('         stg.raw_venda, stg.raw_item_venda, stg.raw_servico,');
  p.push('         stg.raw_atendimento, stg.raw_concorrente;\n');

  const todas = k => ['salvador', 'itabuna', 'feira'].flatMap(f => fontes[f][k]);

  p.push('-- categorias (só Salvador tem tabela própria)');
  p.push(inserts('stg.raw_categoria', ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'nome'],
    todas('categorias').map(c => ({ ...c, id_carga: idCarga, ordem_arquivo: c.ordem }))));

  p.push('-- produtos');
  p.push(inserts('stg.raw_produto',
    ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'nome', 'categoria', 'preco'],
    todas('produtos').map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));

  p.push('-- clientes (só estado_civil chega ao DW; o resto fica para auditoria)');
  p.push(inserts('stg.raw_cliente',
    ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'nome', 'email', 'telefone', 'sexo',
     'estado_civil', 'data_nascimento', 'data_cadastro'],
    todas('clientes').map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));

  p.push('-- vendas (valor_total do Itabuna preservado aqui, mas NÃO usado)');
  p.push(inserts('stg.raw_venda',
    ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'id_cliente', 'data_venda', 'valor_total'],
    todas('vendas').map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));

  p.push('-- itens de venda (grão de fato)');
  p.push(inserts('stg.raw_item_venda',
    ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'id_venda', 'seq_item', 'id_produto',
     'quantidade', 'valor_unitario'],
    todas('itens').map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));

  p.push('-- serviços do Itabuna: SEM destino no DW, guardados para rastreio');
  p.push(inserts('stg.raw_servico', ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'descricao', 'valor'],
    fontes.itabuna.servicos.map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));
  p.push(inserts('stg.raw_atendimento',
    ['id_carga', 'fonte', 'ordem_arquivo', 'id_origem', 'id_cliente', 'id_servico',
     'data_atendimento', 'valor_cobrado'],
    fontes.itabuna.atendimentos.map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem }))));

  p.push('-- concorrente');
  p.push(inserts('stg.raw_concorrente', ['id_carga', 'fonte', 'ordem_arquivo', 'ano', 'mes', 'valor_venda'],
    fontes.concorrente.map(x => ({ ...x, id_carga: idCarga, ordem_arquivo: x.ordem, mes: x.mes_abrev }))));

  p.push(`UPDATE stg.etl_carga
SET status = 'extraida',
    resumo = jsonb_build_object('raw_itens_venda', ${todas('itens').length},
                                'raw_concorrente', ${fontes.concorrente.length})
WHERE id_carga = ${lit(idCarga)}::uuid;\n`);

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 20 — camada map (derivada, não digitada)
// =============================================================================
export function emitirMap(c, contexto) {
  const p = [];
  const idCarga = contexto.idCarga;
  p.push(cabecalho('stg.map_* — catálogo conformado e de-para',
    'DERIVADO dos arquivos de origem por etl/conform.mjs, não digitado à mão.\n' +
    'Resolve a colisão de chaves naturais: o mesmo id_produto significa produtos\n' +
    'diferentes em cada fonte, e dim_produto tem chave natural global.'));

  p.push('BEGIN;');
  p.push("SELECT pg_advisory_xact_lock(hashtext('petshop_etl_staging'));\n");
  p.push(`DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM stg.etl_carga
        WHERE id_carga = ${lit(idCarga)}::uuid AND status = 'extraida'
    ) THEN
        RAISE EXCEPTION 'lote ${idCarga} não está no estado extraida';
    END IF;
END $$;\n`);
  p.push('TRUNCATE stg.map_produto, stg.map_produto_origem,');
  p.push('         stg.map_estado_civil, stg.map_estado_civil_origem, stg.map_loja CASCADE;\n');

  p.push('-- catálogo conformado');
  p.push(inserts('stg.map_produto', ['id_conformado', 'nome', 'categoria', 'observacao'],
    c.catalogo.map(x => ({
      id_conformado: x.id_produto, nome: x.produto,
      categoria: x.categoria, observacao: x.observacao,
    }))));

  p.push('-- de-para por fonte (ids que colidem entre as origens)');
  p.push(inserts('stg.map_produto_origem', ['fonte', 'id_origem', 'id_conformado'],
    c.deparaProduto));

  p.push('-- domínio de estado civil');
  p.push(inserts('stg.map_estado_civil', ['id_conformado', 'rotulo'],
    c.estadoCivil.dominio.map(x => ({ id_conformado: x.id, rotulo: x.rotulo }))));
  p.push(inserts('stg.map_estado_civil_origem', ['valor_origem', 'id_conformado'],
    c.estadoCivil.depara));

  p.push('-- lojas (não existem como coluna em nenhuma fonte)');
  p.push(inserts('stg.map_loja', ['fonte', 'id_loja', 'loja', 'cidade', 'estado'],
    c.lojas));

  p.push(`UPDATE stg.etl_carga
SET status = 'mapeada',
    resumo = resumo || jsonb_build_object('produtos_conformados', ${c.catalogo.length},
                                          'depara_produto', ${c.deparaProduto.length})
WHERE id_carga = ${lit(idCarga)}::uuid;\n`);

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 30 — camada cln
// =============================================================================
export function emitirCln(c, contexto) {
  const p = [];
  const idCarga = contexto.idCarga;
  p.push(cabecalho('stg.cln_* — tipado e conformado, pronto para carga',
    'O fato de venda existe em DOIS grãos, e as duas chaves já vêm calculadas.\n' +
    '\n' +
    'cln_fat_vendas — grão de ITEM, uma linha por produto dentro de um pedido:\n' +
    `  id_venda = id_loja * ${FATOR_LOJA} + id_venda_origem * ${FATOR_VENDA} + seq_item\n` +
    'Decodificável de propósito: (id_venda / 100) reagrupa os itens do mesmo\n' +
    'pedido. É a única camada onde a data da venda e o número do pedido\n' +
    'sobrevivem, e é ela que reconcilia com a origem.\n' +
    '\n' +
    'cln_fat_vendas_dw — grão AGREGADO, o que public.fat_vendas recebe:\n' +
    `  id_venda = id_data * ${FATOR_FATO.data} + id_loja * ${FATOR_FATO.loja}` +
    ` + id_produto * ${FATOR_FATO.produto} + id_estado_civil\n` +
    'Uma linha por produto x loja x quadrimestre x estado civil. A chave É a\n' +
    'combinação dimensional, então a PK declara o grão.\n' +
    '\n' +
    'sk_produto e sk_loja ficam como id_produto/id_loja aqui e só viram surrogate\n' +
    'no 40_load_dw.sql, porque as SKs são IDENTITY e só existem depois da carga\n' +
    'das dimensões.'));

  p.push('BEGIN;');
  p.push("SELECT pg_advisory_xact_lock(hashtext('petshop_etl_staging'));\n");
  p.push(`DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM stg.etl_carga
        WHERE id_carga = ${lit(idCarga)}::uuid AND status = 'mapeada'
    ) THEN
        RAISE EXCEPTION 'lote ${idCarga} não está no estado mapeada';
    END IF;
END $$;\n`);
  p.push('TRUNCATE stg.cln_dim_produto, stg.cln_dim_loja, stg.cln_dim_estado_civil,');
  p.push('         stg.cln_dim_data, stg.cln_fat_vendas, stg.cln_fat_vendas_dw,');
  p.push('         stg.cln_fat_concorrente;\n');
  p.push(`DELETE FROM stg.rej_carga WHERE id_carga = ${lit(idCarga)}::uuid;\n`);

  p.push('-- dimensões');
  p.push(inserts('stg.cln_dim_produto', ['id_produto', 'produto', 'categoria'], c.catalogo));
  p.push(inserts('stg.cln_dim_loja', ['id_loja', 'loja', 'cidade', 'estado'], c.lojas));
  p.push(inserts('stg.cln_dim_estado_civil', ['id_estado_civil', 'estado_civil'],
    c.estadoCivil.dominio.map(x => ({ id_estado_civil: x.id, estado_civil: x.rotulo }))));

  p.push(`-- calendário quadrimestral cobrindo ${CALENDARIO.inicio} .. ${CALENDARIO.fim}`);
  p.push(inserts('stg.cln_dim_data', ['id_data', 'ano', 'quadrimestre'], c.calendario));

  p.push('-- fatos de venda (sk_produto/sk_loja ainda como ids conformados)');
  p.push(inserts('stg.cln_fat_vendas',
    ['id_venda', 'sk_produto', 'sk_loja', 'id_data', 'data', 'quantidade', 'valor_venda',
     'id_estado_civil', 'fonte', 'id_venda_origem', 'seq_item', 'id_produto_origem'],
    c.fatos.map(f => ({ ...f, sk_produto: f.id_produto, sk_loja: f.id_loja }))));

  p.push('-- fato de venda no grao do DW: itens ja agregados por combinacao dimensional');
  p.push(inserts('stg.cln_fat_vendas_dw',
    ['id_venda', 'sk_produto', 'sk_loja', 'id_data', 'id_estado_civil', 'quantidade',
     'valor_venda', 'itens_agregados', 'data_referencia'],
    c.fatosAgregados.map(f => ({ ...f, sk_produto: f.id_produto, sk_loja: f.id_loja }))));

  p.push('-- fato do concorrente (produto sentinela, quantidade 0, meses ja agregados)');
  p.push(inserts('stg.cln_fat_concorrente',
    ['id_concorrente', 'id_data', 'sk_produto', 'quantidade', 'valor_venda',
     'ano', 'quadrimestre', 'meses_agregados', 'data_referencia'],
    c.concorrente.map(f => ({ ...f, sk_produto: f.id_produto }))));

  if (c.rejeitos.length) {
    p.push('-- quarentena: linhas que não entram, com o motivo');
    p.push(inserts('stg.rej_carga', ['id_carga', 'destino', 'fonte', 'motivo', 'linha_original'],
      c.rejeitos.map(r => ({
        id_carga: idCarga, destino: r.destino, fonte: r.fonte, motivo: r.motivo,
        linha_original: JSON.stringify(r.linha),
      }))));
  } else {
    p.push('-- nenhuma linha rejeitada nesta extração');
  }

  p.push(`UPDATE stg.etl_carga
SET status = 'transformada',
    resumo = resumo || jsonb_build_object(
        'itens_venda', ${c.fatos.length},
        'fatos_venda', ${c.fatosAgregados.length},
        'fatos_concorrente', ${c.concorrente.length},
        'rejeitados', ${c.rejeitos.length},
        'itens_origem', ${c.resumo.itensOrigem}
    )
WHERE id_carga = ${lit(idCarga)}::uuid;\n`);

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 40 — carga no DW
// =============================================================================
// Escrito como SQL fixo (não depende dos dados), mas gerado aqui para que as
// constantes venham de config.mjs em vez de serem repetidas à mão.
export function emitirCarga(contexto) {
  const idCarga = contexto.idCarga;
  const corte = `(${lit(contexto.dataEfetiva)}::timestamptz AT TIME ZONE 'UTC')`;
  return cabecalho('Carga transacional stg.cln_* -> public',
    'Implementa SCD2 real para produto e loja, resolve as surrogate keys pela\n' +
    'vigência do fato e valida tudo ANTES do COMMIT. Um advisory lock impede\n' +
    'duas cargas concorrentes. Reexecutar o mesmo lote é idempotente.\n' +
    '\n' +
    'Os dois fatos chegam AGREGADOS do conformador e aqui são só projeção:\n' +
    'fat_vendas no grão produto x loja x quadrimestre x estado civil, e\n' +
    'fat_concorrente no grão quadrimestre. Nenhum GROUP BY neste arquivo — o\n' +
    'que ele faz é conferir que as agregações fecharam em linha, unidade e\n' +
    'dinheiro antes de deixar o COMMIT acontecer.') + `
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('petshop_etl_dw'));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM stg.etl_carga
        WHERE id_carga = ${lit(idCarga)}::uuid AND status IN ('transformada', 'concluida')
    ) THEN
        RAISE EXCEPTION 'lote ${idCarga} não está pronto para carga';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.dim_produto d
        JOIN stg.cln_dim_produto c USING (id_produto)
        WHERE d.flag_atual
          AND (d.produto, d.categoria) IS DISTINCT FROM (c.produto, c.categoria)
          AND d.data_inicio >= ${corte}
    ) OR EXISTS (
        SELECT 1
        FROM public.dim_loja d
        JOIN stg.cln_dim_loja c USING (id_loja)
        WHERE d.flag_atual
          AND (d.loja, d.cidade, btrim(d.estado))
              IS DISTINCT FROM (c.loja, c.cidade, btrim(c.estado))
          AND d.data_inicio >= ${corte}
    ) THEN
        RAISE EXCEPTION 'data efetiva do lote não é posterior à versão SCD2 atual';
    END IF;
END $$;

-- Dimensões estáticas.
INSERT INTO public.dim_data (id_data, ano, quadrimestre)
SELECT id_data, ano, quadrimestre FROM stg.cln_dim_data
ON CONFLICT (id_data) DO UPDATE SET
    ano = EXCLUDED.ano,
    quadrimestre = EXCLUDED.quadrimestre;

INSERT INTO public.dim_estado_civil (id_estado_civil, estado_civil)
SELECT id_estado_civil, estado_civil FROM stg.cln_dim_estado_civil
ON CONFLICT (id_estado_civil) DO UPDATE SET
    estado_civil = EXCLUDED.estado_civil;

-- SCD2 de produto: fecha alterados/removidos e abre a próxima versão.
UPDATE public.dim_produto d
SET data_fim = ${corte},
    flag_atual = false,
    data_atualizacao = clock_timestamp()
WHERE d.flag_atual
  AND (
      NOT EXISTS (
          SELECT 1 FROM stg.cln_dim_produto c WHERE c.id_produto = d.id_produto
      )
      OR EXISTS (
          SELECT 1 FROM stg.cln_dim_produto c
          WHERE c.id_produto = d.id_produto
            AND (d.produto, d.categoria) IS DISTINCT FROM (c.produto, c.categoria)
      )
  );

WITH versoes AS (
    SELECT id_produto, max(versao) AS ultima_versao
    FROM public.dim_produto
    GROUP BY id_produto
)
INSERT INTO public.dim_produto
    (id_produto, produto, categoria, data_inicio, versao, flag_atual)
SELECT c.id_produto, c.produto, c.categoria,
       CASE WHEN v.ultima_versao IS NULL
            THEN '${CALENDARIO.inicio} 00:00:00'::timestamp
            ELSE ${corte} END,
       COALESCE(v.ultima_versao + 1, 1), true
FROM stg.cln_dim_produto c
LEFT JOIN versoes v USING (id_produto)
WHERE NOT EXISTS (
    SELECT 1 FROM public.dim_produto d
    WHERE d.id_produto = c.id_produto AND d.flag_atual
);

-- SCD2 de loja.
UPDATE public.dim_loja d
SET data_fim = ${corte},
    flag_atual = false,
    data_atualizacao = clock_timestamp()
WHERE d.flag_atual
  AND (
      NOT EXISTS (
          SELECT 1 FROM stg.cln_dim_loja c WHERE c.id_loja = d.id_loja
      )
      OR EXISTS (
          SELECT 1 FROM stg.cln_dim_loja c
          WHERE c.id_loja = d.id_loja
            AND (d.loja, d.cidade, btrim(d.estado))
                IS DISTINCT FROM (c.loja, c.cidade, btrim(c.estado))
      )
  );

WITH versoes AS (
    SELECT id_loja, max(versao) AS ultima_versao
    FROM public.dim_loja
    GROUP BY id_loja
)
INSERT INTO public.dim_loja
    (id_loja, loja, cidade, estado, data_inicio, versao, flag_atual)
SELECT c.id_loja, c.loja, c.cidade, c.estado,
       CASE WHEN v.ultima_versao IS NULL
            THEN '${CALENDARIO.inicio} 00:00:00'::timestamp
            ELSE ${corte} END,
       COALESCE(v.ultima_versao + 1, 1), true
FROM stg.cln_dim_loja c
LEFT JOIN versoes v USING (id_loja)
WHERE NOT EXISTS (
    SELECT 1 FROM public.dim_loja d
    WHERE d.id_loja = c.id_loja AND d.flag_atual
);

-- Snapshot completo dos fatos. O TRUNCATE e a recarga ficam na mesma transação.
TRUNCATE public.fat_vendas, public.fat_concorrente;

-- public.fat_vendas e AGREGADO: uma linha por produto x loja x quadrimestre x
-- estado civil. O conformador ja entregou o grao pronto em cln_fat_vendas_dw,
-- entao aqui e projecao — nenhum GROUP BY. O grao de item fica em
-- stg.cln_fat_vendas, que e quem preserva a data da venda e o numero do pedido.
--
-- data_referencia (1o dia do quadrimestre) ancora o lookup SCD2. No grao
-- agregado nao existe uma data real do fato, e dim_data e quadrimestral: a
-- resolucao de versao de produto e loja e quadrimestral tambem.
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

-- A fonte concorrente é mensal e não mede produto nem quantidade. Os 24 meses
-- ja chegam agregados em 6 quadrimestres pelo conformador; aqui e so projecao.
-- data_referencia (1o dia do quadrimestre) ancora o lookup SCD2 do sentinela.
INSERT INTO public.fat_concorrente
    (id_concorrente, id_data, sk_produto, quantidade, valor_venda)
SELECT c.id_concorrente, c.id_data, p.sk_produto, c.quantidade, c.valor_venda
FROM stg.cln_fat_concorrente c
JOIN public.dim_produto p
  ON p.id_produto = c.sk_produto
 AND c.data_referencia::timestamp >= p.data_inicio
 AND c.data_referencia::timestamp <  p.data_fim;

-- Falhar aqui desfaz também o TRUNCATE e todas as alterações SCD2.
DO $$
DECLARE
    esperado_vendas integer;
    obtido_vendas integer;
    esperado_conc integer;
    obtido_conc integer;
    esperado_produtos integer;
    atual_produtos integer;
    esperado_lojas integer;
    atual_lojas integer;
    qtd_vendas_cln bigint;
    qtd_vendas_dw bigint;
    valor_vendas_cln numeric;
    valor_vendas_dw numeric;
    valor_conc_cln numeric;
    valor_conc_dw numeric;
    meses_conc integer;
    meses_raw integer;
BEGIN
    SELECT count(*) INTO esperado_vendas FROM stg.cln_fat_vendas_dw;
    SELECT count(*) INTO obtido_vendas FROM public.fat_vendas;
    SELECT sum(quantidade), sum(valor_venda) INTO qtd_vendas_cln, valor_vendas_cln
      FROM stg.cln_fat_vendas_dw;
    SELECT sum(quantidade), sum(valor_venda) INTO qtd_vendas_dw, valor_vendas_dw
      FROM public.fat_vendas;
    SELECT count(*) INTO esperado_conc FROM stg.cln_fat_concorrente;
    SELECT count(*) INTO obtido_conc FROM public.fat_concorrente;
    SELECT count(*) INTO esperado_produtos FROM stg.cln_dim_produto;
    SELECT count(*) INTO atual_produtos FROM public.dim_produto WHERE flag_atual;
    SELECT count(*) INTO esperado_lojas FROM stg.cln_dim_loja;
    SELECT count(*) INTO atual_lojas FROM public.dim_loja WHERE flag_atual;
    SELECT sum(valor_venda), sum(meses_agregados) INTO valor_conc_cln, meses_conc
      FROM stg.cln_fat_concorrente;
    SELECT sum(valor_venda) INTO valor_conc_dw FROM public.fat_concorrente;
    SELECT count(*) INTO meses_raw FROM stg.raw_concorrente
     WHERE id_carga = ${lit(idCarga)}::uuid;

    IF esperado_vendas <> obtido_vendas THEN
        RAISE EXCEPTION 'fat_vendas: % esperadas, % carregadas',
                        esperado_vendas, obtido_vendas;
    END IF;
    -- A agregacao item -> combinacao dimensional acontece no conformador; a
    -- view confere que ela fechou contra o grao de item ainda no staging.
    -- Contagem sozinha nao pega agregacao errada: ela preserva o numero de
    -- grupos e perde medida. Por isso linha, unidade e dinheiro, os tres.
    IF EXISTS (SELECT 1 FROM stg.vw_check_agregacao_vendas
                WHERE diferenca_itens <> 0
                   OR diferenca_quantidade <> 0
                   OR diferenca_valor <> 0) THEN
        RAISE EXCEPTION 'agregação de vendas não fecha com os itens conformados';
    END IF;
    IF qtd_vendas_cln IS DISTINCT FROM qtd_vendas_dw
       OR valor_vendas_cln IS DISTINCT FROM valor_vendas_dw THEN
        RAISE EXCEPTION 'fat_vendas: staging tem % unidades / %, destino tem % / %',
                        qtd_vendas_cln, valor_vendas_cln, qtd_vendas_dw, valor_vendas_dw;
    END IF;
    -- O grao do destino, afirmado no destino. A PK codificada ja deveria
    -- garantir isto, mas quem decide o sk e o lookup SCD2: se ele devolvesse
    -- duas versoes para a mesma combinacao, a medida seria dividida em duas
    -- linhas e todo indicador por produto passaria a depender de agregacao.
    IF EXISTS (
        SELECT 1 FROM public.fat_vendas
        GROUP BY sk_produto, sk_loja, id_data, id_estado_civil
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'fat_vendas: grão violado — combinação dimensional repetida';
    END IF;
    IF esperado_conc <> obtido_conc THEN
        RAISE EXCEPTION 'fat_concorrente: % esperadas, % carregadas',
                        esperado_conc, obtido_conc;
    END IF;
    IF esperado_produtos <> atual_produtos THEN
        RAISE EXCEPTION 'dim_produto: % correntes esperadas, % obtidas',
                        esperado_produtos, atual_produtos;
    END IF;
    IF esperado_lojas <> atual_lojas THEN
        RAISE EXCEPTION 'dim_loja: % correntes esperadas, % obtidas',
                        esperado_lojas, atual_lojas;
    END IF;
    IF EXISTS (SELECT 1 FROM stg.vw_check_reconciliacao WHERE diferenca <> 0) THEN
        RAISE EXCEPTION 'reconciliação raw = cln + rejeitados falhou';
    END IF;
    -- Mesma conferencia da agregacao de vendas, agora para o concorrente:
    -- mensal -> quadrimestral. Contagem nao basta: confere valor e meses.
    IF valor_conc_cln IS DISTINCT FROM valor_conc_dw THEN
        RAISE EXCEPTION 'fat_concorrente: valor % no staging, % no destino',
                        valor_conc_cln, valor_conc_dw;
    END IF;
    IF meses_conc <> meses_raw THEN
        RAISE EXCEPTION 'agregação do concorrente: % meses na origem, % contabilizados',
                        meses_raw, meses_conc;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.fat_vendas f
        JOIN public.dim_produto p ON p.sk_produto = f.sk_produto
        WHERE p.id_produto = ${PRODUTO_SENTINELA.id_produto}
    ) THEN
        RAISE EXCEPTION 'produto sentinela apareceu em fat_vendas';
    END IF;
END $$;

UPDATE stg.etl_carga
SET status = 'concluida',
    finalizado_em = clock_timestamp(),
    resumo = resumo || jsonb_build_object(
        'carregado_fat_vendas', (SELECT count(*) FROM public.fat_vendas),
        'itens_agregados', (SELECT sum(itens_agregados) FROM stg.cln_fat_vendas_dw),
        'carregado_fat_concorrente', (SELECT count(*) FROM public.fat_concorrente)
    )
WHERE id_carga = ${lit(idCarga)}::uuid;

COMMIT;

SELECT id_carga, status, iniciado_em, finalizado_em, resumo
FROM stg.etl_carga
WHERE id_carga = ${lit(idCarga)}::uuid;

SELECT 'dim_produto' AS tabela, count(*) AS linhas FROM public.dim_produto
UNION ALL SELECT 'dim_loja', count(*) FROM public.dim_loja
UNION ALL SELECT 'dim_estado_civil', count(*) FROM public.dim_estado_civil
UNION ALL SELECT 'dim_data', count(*) FROM public.dim_data
UNION ALL SELECT 'fat_vendas', count(*) FROM public.fat_vendas
UNION ALL SELECT 'fat_concorrente', count(*) FROM public.fat_concorrente
ORDER BY 1;

SELECT destino, fonte, motivo, count(*) AS linhas
FROM stg.rej_carga
WHERE id_carga = ${lit(idCarga)}::uuid
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

-- A chave codificada tem que reproduzir a combinacao que a linha declara.
-- Qualquer linha com confere = false significa PK inconsistente com as FKs.
SELECT (f.id_venda / ${FATOR_FATO.data})::int AS id_data_decodificado,
       ((f.id_venda / ${FATOR_FATO.loja}) % ${FATOR_FATO.data / FATOR_FATO.loja})::int
           AS id_loja_decodificado,
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
}
