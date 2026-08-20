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

import { FATOR_LOJA, FATOR_VENDA, CALENDARIO, PRODUTO_SENTINELA } from './config.mjs';

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
export function emitirRaw(fontes) {
  const p = [];
  p.push(cabecalho('stg.raw_* — espelho fiel das fontes',
    'Tudo text, nada interpretado. As datas do Salvador continuam em DD/MM/YYYY.\n' +
    '`ordem_arquivo` é a posição no arquivo de origem e NÃO é decorativa: no\n' +
    'Itabuna as chaves são SERIAL, logo o id da entidade É a posição.'));

  p.push('BEGIN;\n');
  p.push('TRUNCATE stg.raw_produto, stg.raw_categoria, stg.raw_cliente,');
  p.push('         stg.raw_venda, stg.raw_item_venda, stg.raw_servico,');
  p.push('         stg.raw_atendimento, stg.raw_concorrente;\n');

  const todas = k => ['salvador', 'itabuna', 'feira'].flatMap(f => fontes[f][k]);

  p.push('-- categorias (só Salvador tem tabela própria)');
  p.push(inserts('stg.raw_categoria', ['fonte', 'ordem_arquivo', 'id_origem', 'nome'],
    todas('categorias').map(c => ({ ...c, ordem_arquivo: c.ordem }))));

  p.push('-- produtos');
  p.push(inserts('stg.raw_produto',
    ['fonte', 'ordem_arquivo', 'id_origem', 'nome', 'categoria', 'preco'],
    todas('produtos').map(x => ({ ...x, ordem_arquivo: x.ordem }))));

  p.push('-- clientes (só estado_civil chega ao DW; o resto fica para auditoria)');
  p.push(inserts('stg.raw_cliente',
    ['fonte', 'ordem_arquivo', 'id_origem', 'nome', 'email', 'telefone', 'sexo',
     'estado_civil', 'data_nascimento', 'data_cadastro'],
    todas('clientes').map(x => ({ ...x, ordem_arquivo: x.ordem }))));

  p.push('-- vendas (valor_total do Itabuna preservado aqui, mas NÃO usado)');
  p.push(inserts('stg.raw_venda',
    ['fonte', 'ordem_arquivo', 'id_origem', 'id_cliente', 'data_venda', 'valor_total'],
    todas('vendas').map(x => ({ ...x, ordem_arquivo: x.ordem }))));

  p.push('-- itens de venda (grão de fato)');
  p.push(inserts('stg.raw_item_venda',
    ['fonte', 'ordem_arquivo', 'id_origem', 'id_venda', 'seq_item', 'id_produto',
     'quantidade', 'valor_unitario'],
    todas('itens').map(x => ({ ...x, ordem_arquivo: x.ordem }))));

  p.push('-- serviços do Itabuna: SEM destino no DW, guardados para rastreio');
  p.push(inserts('stg.raw_servico', ['fonte', 'ordem_arquivo', 'id_origem', 'descricao', 'valor'],
    fontes.itabuna.servicos.map(x => ({ ...x, ordem_arquivo: x.ordem }))));
  p.push(inserts('stg.raw_atendimento',
    ['fonte', 'ordem_arquivo', 'id_origem', 'id_cliente', 'id_servico',
     'data_atendimento', 'valor_cobrado'],
    fontes.itabuna.atendimentos.map(x => ({ ...x, ordem_arquivo: x.ordem }))));

  p.push('-- concorrente');
  p.push(inserts('stg.raw_concorrente', ['fonte', 'ordem_arquivo', 'ano', 'mes', 'valor_venda'],
    fontes.concorrente.map(x => ({ ...x, ordem_arquivo: x.ordem, mes: x.mes_abrev }))));

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 20 — camada map (derivada, não digitada)
// =============================================================================
export function emitirMap(c) {
  const p = [];
  p.push(cabecalho('stg.map_* — catálogo conformado e de-para',
    'DERIVADO dos arquivos de origem por etl/conform.mjs, não digitado à mão.\n' +
    'Resolve a colisão de chaves naturais: o mesmo id_produto significa produtos\n' +
    'diferentes em cada fonte, e dim_produto tem chave natural global.'));

  p.push('BEGIN;\n');
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

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 30 — camada cln
// =============================================================================
export function emitirCln(c) {
  const p = [];
  p.push(cabecalho('stg.cln_* — tipado e conformado, pronto para carga',
    'As chaves de fato já vêm calculadas:\n' +
    `  id_venda = id_loja * ${FATOR_LOJA} + id_venda_origem * ${FATOR_VENDA} + seq_item\n` +
    'Formato decodificável de propósito: (id_venda / 100) reagrupa os itens do\n' +
    'mesmo pedido original, informação que uma PK em id_venda pareceria destruir.\n' +
    '\n' +
    'sk_produto e sk_loja ficam como id_produto/id_loja aqui e só viram surrogate\n' +
    'no 40_load_dw.sql, porque as SKs são IDENTITY e só existem depois da carga\n' +
    'das dimensões.'));

  p.push('BEGIN;\n');
  p.push('TRUNCATE stg.cln_dim_produto, stg.cln_dim_loja, stg.cln_dim_estado_civil,');
  p.push('         stg.cln_dim_data, stg.cln_fat_vendas, stg.cln_fat_concorrente;\n');

  p.push('-- dimensões');
  p.push(inserts('stg.cln_dim_produto', ['id_produto', 'produto', 'categoria'], c.catalogo));
  p.push(inserts('stg.cln_dim_loja', ['id_loja', 'loja', 'cidade', 'estado'], c.lojas));
  p.push(inserts('stg.cln_dim_estado_civil', ['id_estado_civil', 'estado_civil'],
    c.estadoCivil.dominio.map(x => ({ id_estado_civil: x.id, estado_civil: x.rotulo }))));

  p.push(`-- calendário completo ${CALENDARIO.inicio} .. ${CALENDARIO.fim}`);
  p.push(inserts('stg.cln_dim_data', ['data', 'ano', 'quadrimestre'], c.calendario));

  p.push('-- fatos de venda (sk_produto/sk_loja ainda como ids conformados)');
  p.push(inserts('stg.cln_fat_vendas',
    ['id_venda', 'sk_produto', 'sk_loja', 'data', 'quantidade', 'valor_venda',
     'id_estado_civil', 'fonte', 'id_venda_origem', 'seq_item', 'id_produto_origem'],
    c.fatos.map(f => ({ ...f, sk_produto: f.id_produto, sk_loja: f.id_loja }))));

  p.push('-- fato do concorrente (produto sentinela, quantidade 0)');
  p.push(inserts('stg.cln_fat_concorrente',
    ['id_concorrente', 'data', 'sk_produto', 'quantidade', 'valor_venda', 'ano', 'mes'],
    c.concorrente.map(f => ({ ...f, sk_produto: f.id_produto }))));

  if (c.rejeitos.length) {
    p.push('-- quarentena: linhas que não entram, com o motivo');
    p.push(inserts('stg.rej_carga', ['destino', 'fonte', 'motivo', 'linha_original'],
      c.rejeitos.map(r => ({
        destino: r.destino, fonte: r.fonte, motivo: r.motivo,
        linha_original: JSON.stringify(r.linha),
      }))));
  } else {
    p.push('-- nenhuma linha rejeitada nesta extração');
  }

  p.push('COMMIT;\n');
  return p.join('\n');
}

// =============================================================================
// 40 — carga no DW
// =============================================================================
// Escrito como SQL fixo (não depende dos dados), mas gerado aqui para que as
// constantes venham de config.mjs em vez de serem repetidas à mão.
export function emitirCarga() {
  return cabecalho('Carga stg.cln_* -> public',
    'Resolve as surrogate keys e carrega o DW. As dimensões SCD2 entram na\n' +
    'versão 1, com data_inicio no começo do calendário para que a vigência\n' +
    'cubra todos os fatos (com now() os fatos de 2024 ficariam fora da vigência\n' +
    'e qualquer consulta point-in-time daria errado).\n' +
    '\n' +
    'Idempotente: rode quantas vezes quiser. As dimensões usam ON CONFLICT e os\n' +
    'fatos são truncados antes.') + `
BEGIN;

-- ordem imposta pelas FKs: dimensões antes dos fatos
TRUNCATE public.fat_vendas, public.fat_concorrente;

-- ---------------------------------------------------------------------------
-- dim_data
-- ---------------------------------------------------------------------------
INSERT INTO public.dim_data (data, ano, quadrimestre)
SELECT data, ano, quadrimestre FROM stg.cln_dim_data
ON CONFLICT (data) DO NOTHING;

-- ---------------------------------------------------------------------------
-- dim_estado_civil
-- ---------------------------------------------------------------------------
INSERT INTO public.dim_estado_civil (id_estado_civil, estado_civil)
SELECT id_estado_civil, estado_civil FROM stg.cln_dim_estado_civil
ON CONFLICT (id_estado_civil) DO UPDATE SET estado_civil = EXCLUDED.estado_civil;

-- ---------------------------------------------------------------------------
-- dim_produto — SCD2, carga inicial (versão 1)
-- ---------------------------------------------------------------------------
-- ux_produto_atual impede duas versões correntes da mesma chave natural, e
-- ex_produto_per impede vigências sobrepostas. Na carga inicial não há versão
-- anterior para fechar, então basta inserir.
INSERT INTO public.dim_produto (id_produto, produto, categoria, data_inicio)
SELECT id_produto, produto, categoria, '${CALENDARIO.inicio} 00:00:00'::timestamp
FROM stg.cln_dim_produto
WHERE NOT EXISTS (
    SELECT 1 FROM public.dim_produto d
    WHERE d.id_produto = stg.cln_dim_produto.id_produto AND d.flag_atual
);

-- ---------------------------------------------------------------------------
-- dim_loja — SCD2, carga inicial (versão 1)
-- ---------------------------------------------------------------------------
INSERT INTO public.dim_loja (id_loja, loja, cidade, estado, data_inicio)
SELECT id_loja, loja, cidade, estado, '${CALENDARIO.inicio} 00:00:00'::timestamp
FROM stg.cln_dim_loja
WHERE NOT EXISTS (
    SELECT 1 FROM public.dim_loja d
    WHERE d.id_loja = stg.cln_dim_loja.id_loja AND d.flag_atual
);

-- ---------------------------------------------------------------------------
-- fat_vendas — resolve as surrogate keys
-- ---------------------------------------------------------------------------
-- Em stg.cln_fat_vendas, sk_produto/sk_loja ainda guardam o id CONFORMADO.
-- O join com a versão corrente da dimensão troca pelo surrogate real.
INSERT INTO public.fat_vendas
    (id_venda, sk_produto, sk_loja, data, quantidade, valor_venda, id_estado_civil)
SELECT c.id_venda, p.sk_produto, l.sk_loja, c.data, c.quantidade,
       c.valor_venda, c.id_estado_civil
FROM stg.cln_fat_vendas c
JOIN public.dim_produto p ON p.id_produto = c.sk_produto AND p.flag_atual
JOIN public.dim_loja    l ON l.id_loja    = c.sk_loja    AND l.flag_atual;

-- ---------------------------------------------------------------------------
-- fat_concorrente
-- ---------------------------------------------------------------------------
-- ATENÇÃO: quantidade é sempre 0 — a fonte é faturamento mensal agregado e não
-- mede unidades. SUM(quantidade) aqui NÃO significa "vendeu zero".
INSERT INTO public.fat_concorrente
    (id_concorrente, data, sk_produto, quantidade, valor_venda)
SELECT c.id_concorrente, c.data, p.sk_produto, c.quantidade, c.valor_venda
FROM stg.cln_fat_concorrente c
JOIN public.dim_produto p ON p.id_produto = c.sk_produto AND p.flag_atual;

COMMIT;


-- ===========================================================================
-- Conferência pós-carga
-- ===========================================================================
-- Toda linha limpa tem que ter chegado ao destino. Se alguma some no join de
-- surrogate key, é de-para incompleto — e some em silêncio, que é o pior modo
-- de falha possível numa carga.
DO $$
DECLARE
    esperado_vendas int;
    obtido_vendas   int;
    esperado_conc   int;
    obtido_conc     int;
BEGIN
    SELECT count(*) INTO esperado_vendas FROM stg.cln_fat_vendas;
    SELECT count(*) INTO obtido_vendas   FROM public.fat_vendas;
    SELECT count(*) INTO esperado_conc   FROM stg.cln_fat_concorrente;
    SELECT count(*) INTO obtido_conc     FROM public.fat_concorrente;

    IF esperado_vendas <> obtido_vendas THEN
        RAISE EXCEPTION 'fat_vendas: % linhas limpas, % carregadas (% perdidas no join de SK)',
                        esperado_vendas, obtido_vendas, esperado_vendas - obtido_vendas;
    END IF;
    IF esperado_conc <> obtido_conc THEN
        RAISE EXCEPTION 'fat_concorrente: % linhas limpas, % carregadas',
                        esperado_conc, obtido_conc;
    END IF;

    RAISE NOTICE 'carga conferida: % vendas, % concorrente', obtido_vendas, obtido_conc;
END $$;

-- Panorama do que entrou.
SELECT 'dim_produto'      AS tabela, count(*) FROM public.dim_produto
UNION ALL SELECT 'dim_loja',         count(*) FROM public.dim_loja
UNION ALL SELECT 'dim_estado_civil', count(*) FROM public.dim_estado_civil
UNION ALL SELECT 'dim_data',         count(*) FROM public.dim_data
UNION ALL SELECT 'fat_vendas',       count(*) FROM public.fat_vendas
UNION ALL SELECT 'fat_concorrente',  count(*) FROM public.fat_concorrente
ORDER BY 1;

-- O que ficou de fora, e por quê.
SELECT destino, fonte, motivo, count(*) AS linhas
FROM stg.rej_carga
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

-- Sanidade da chave decodificável: o id_venda tem que devolver a loja certa.
SELECT (f.id_venda / ${FATOR_LOJA})::int AS id_loja_decodificado,
       l.id_loja AS id_loja_dimensao,
       count(*)  AS linhas
FROM public.fat_vendas f
JOIN public.dim_loja l ON l.sk_loja = f.sk_loja
GROUP BY 1, 2
ORDER BY 1;
-- as duas primeiras colunas TÊM que ser iguais em toda linha do resultado.

-- Produto sentinela: confirme que ele só aparece em fat_concorrente.
SELECT count(*) AS vendas_com_sentinela_deve_ser_zero
FROM public.fat_vendas f
JOIN public.dim_produto p ON p.sk_produto = f.sk_produto
WHERE p.id_produto = ${PRODUTO_SENTINELA.id_produto};
`;
}
