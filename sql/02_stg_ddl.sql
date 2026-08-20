-- =============================================================================
-- Data Warehouse PetShop — Schema de staging (stg)
-- =============================================================================
-- As tabelas de destino em `public` NÃO mudam. Portanto TODA normalização
-- acontece aqui: nome, id, nulo, encoding, domínio, dedup e grão.
--
-- Quatro camadas:
--   raw_*  espelho fiel da fonte. Tudo `text`. Zero constraint. Nada interpretado.
--   map_*  de-para mantido à mão. É onde vivem as decisões de conformação.
--   cln_*  tipado e conformado, com os MESMOS tipos do destino. Pronto para carga.
--   rej_*  quarentena: linhas que não entram, com o motivo.
--
-- Fluxo:  arquivos -> raw (Python) -> cln + rej (SQL, usando map) -> public (SQL)
--
-- NOTA: o event trigger `ensure_rls` tem a lista de schemas fixa em ('public'),
-- então este schema NÃO recebe RLS automático. Ele também não está na lista de
-- schemas expostos do PostgREST, então não é alcançável pela API REST.
-- Não exponha `stg` na API.
--
-- Documentação: ../docs/06-ingestao-e-staging.md
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS stg;

-- fecha o schema para os papéis da API, por precaução
REVOKE ALL ON SCHEMA stg FROM anon, authenticated;


-- #############################################################################
-- CAMADA RAW — espelho da fonte, sem interpretação
-- #############################################################################
-- Regras desta camada:
--   1. TODA coluna é `text`. '15/01/2025' e '2025-01-15' entram como vieram.
--   2. Nenhuma constraint além de NOT NULL em `fonte`. Nada pode rejeitar aqui.
--   3. `ordem_arquivo` é OBRIGATÓRIO e não é decorativo: Itabuna usa SERIAL sem
--      informar a PK, então o id da entidade É a posição no arquivo. Perder a
--      ordem faz os itens de venda apontarem para os produtos errados.

-- -----------------------------------------------------------------------------
CREATE TABLE stg.raw_produto (
    fonte          text NOT NULL,     -- 'salvador' | 'itabuna' | 'feira'
    ordem_arquivo  int  NOT NULL,     -- 1-based; reconstrói o SERIAL do Itabuna
    id_origem      text,              -- NULL no Itabuna (SERIAL implícito)
    nome           text,
    categoria      text,              -- Salvador: já resolvida via join em categorias
    preco          text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

-- Salvador é a única fonte com categorias normalizada em tabela própria.
CREATE TABLE stg.raw_categoria (
    fonte          text NOT NULL,
    ordem_arquivo  int  NOT NULL,
    id_origem      text,
    nome           text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Só `estado_civil` sobrevive ao modelo (não existe dim_cliente). As outras
-- colunas ficam aqui de propósito: documentam o que foi descartado e permitem
-- justificar a decisão sem reler os arquivos.
CREATE TABLE stg.raw_cliente (
    fonte            text NOT NULL,
    ordem_arquivo    int  NOT NULL,
    id_origem        text,
    nome             text,
    email            text,
    telefone         text,
    sexo             text,   -- 'M'/'F' (Salvador) vs 'Masculino'/'Feminino' (outras)
    estado_civil     text,   -- 'C'/'D'/'S'/'U'/'V' (Salvador) vs texto (outras)
    data_nascimento  text,
    data_cadastro    text,   -- Salvador: SYSDATE, sem informação real
    carregado_em     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
CREATE TABLE stg.raw_venda (
    fonte          text NOT NULL,
    ordem_arquivo  int  NOT NULL,
    id_origem      text,
    id_cliente     text,
    data_venda     text,   -- '15/01/2025' (Salvador) vs '2025-01-15' (outras)
    valor_total    text,   -- ausente no Salvador; INUTILIZÁVEL no Itabuna
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Grão de fato. `seq_item` é a posição do item DENTRO da venda (1-based) e é
-- indispensável: existem 592 casos de (venda, produto) repetido no mesmo pedido
-- (296 Salvador + 158 Itabuna + 138 Feira), então (venda, produto) não
-- identifica a linha.
CREATE TABLE stg.raw_item_venda (
    fonte          text NOT NULL,
    ordem_arquivo  int  NOT NULL,
    id_origem      text,          -- id_item; NULL na Feira (itens aninhados)
    id_venda       text,
    seq_item       int  NOT NULL,
    id_produto     text,
    quantidade     text,
    valor_unitario text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Serviços: só Itabuna. NÃO têm destino no DW (não existe fato de serviços).
-- Ficam aqui para que os 300 atendimentos sejam rastreáveis e a exclusão seja
-- demonstrável, em vez de silenciosa.
CREATE TABLE stg.raw_servico (
    fonte          text NOT NULL,
    ordem_arquivo  int  NOT NULL,
    id_origem      text,
    descricao      text,
    valor          text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stg.raw_atendimento (
    fonte             text NOT NULL,
    ordem_arquivo     int  NOT NULL,
    id_origem         text,
    id_cliente        text,
    id_servico        text,
    data_atendimento  text,
    valor_cobrado     text,
    carregado_em      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Concorrente: 24 linhas, Ano / Mês abreviado / Vendas (R$).
CREATE TABLE stg.raw_concorrente (
    fonte          text NOT NULL DEFAULT 'concorrente',
    ordem_arquivo  int  NOT NULL,
    ano            text,
    mes            text,   -- 'Jan'..'Dez', abreviação em português
    valor_venda    text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);


-- #############################################################################
-- CAMADA MAP — as decisões de conformação
-- #############################################################################
-- Esta camada é o motivo pelo qual o staging é obrigatório: nada disso tem lugar
-- no modelo dimensional. Populada em 03_stg_seed.sql.

-- -----------------------------------------------------------------------------
-- Catálogo conformado de produtos: 17 itens, a fonte da verdade.
-- id_conformado é o que vai para dim_produto.id_produto.
CREATE TABLE stg.map_produto (
    id_conformado  int         PRIMARY KEY,
    nome           varchar(120) NOT NULL UNIQUE,
    categoria      varchar(60)  NOT NULL,
    observacao     text
);

-- Resolve a colisão de chaves entre as fontes.
-- Exemplo do problema: id_origem = 15 é 'Bebedouro Automático' em Salvador,
-- 'Escova para Pelos' em Itabuna e 'Caixa de Transporte' na Feira.
-- Também resolve as duplicatas internas do Itabuna: os ids 1 e 10 apontam
-- ambos para 'Tapete Higiênico Premium'.
CREATE TABLE stg.map_produto_origem (
    fonte          text NOT NULL,
    id_origem      int  NOT NULL,
    id_conformado  int  NOT NULL REFERENCES stg.map_produto(id_conformado),
    CONSTRAINT pk_map_produto_origem PRIMARY KEY (fonte, id_origem)
);

-- -----------------------------------------------------------------------------
-- Domínio de estado civil: 5 valores reais + 'Não informado' para os nulos.
-- id_conformado é o que vai para dim_estado_civil.id_estado_civil (que não é
-- identity — o ETL fornece o valor).
CREATE TABLE stg.map_estado_civil (
    id_conformado  int         PRIMARY KEY,
    rotulo         varchar(30) NOT NULL UNIQUE
);

-- Aceita os três domínios de origem apontando para o mesmo rótulo:
--   'C' e 'Casado' -> Casado
-- A entrada para NULL é tratada no ETL (não dá para ter NULL em PK), via
-- COALESCE para a chave literal '(nulo)'.
CREATE TABLE stg.map_estado_civil_origem (
    valor_origem   text NOT NULL,   -- 'C','U','Casado','União Estável','(nulo)'
    id_conformado  int  NOT NULL REFERENCES stg.map_estado_civil(id_conformado),
    CONSTRAINT pk_map_estado_civil_origem PRIMARY KEY (valor_origem)
);

-- -----------------------------------------------------------------------------
-- Lojas: NÃO existem como coluna em nenhuma fonte. A loja é implícita no
-- arquivo de origem, e é aqui que a atribuição fica explícita.
CREATE TABLE stg.map_loja (
    fonte    text        PRIMARY KEY,   -- 'salvador' | 'itabuna' | 'feira'
    id_loja  int         NOT NULL UNIQUE,
    loja     varchar(120) NOT NULL,
    cidade   varchar(80)  NOT NULL,
    estado   char(2)      NOT NULL
);


-- #############################################################################
-- CAMADA CLN — tipado, conformado, pronto para carga
-- #############################################################################
-- Mesmos tipos do destino. As constraints do destino são REPLICADAS aqui de
-- propósito: é melhor falhar no staging, onde a linha pode ser inspecionada,
-- do que no INSERT final, onde uma linha ruim aborta a carga inteira.

-- -----------------------------------------------------------------------------
CREATE TABLE stg.cln_dim_produto (
    id_produto  integer      NOT NULL PRIMARY KEY,
    produto     varchar(120) NOT NULL,
    categoria   varchar(60)  NOT NULL
);

CREATE TABLE stg.cln_dim_loja (
    id_loja  integer      NOT NULL PRIMARY KEY,
    loja     varchar(120) NOT NULL,
    cidade   varchar(80)  NOT NULL,
    estado   char(2)      NOT NULL
);

CREATE TABLE stg.cln_dim_estado_civil (
    id_estado_civil  integer     NOT NULL PRIMARY KEY,
    estado_civil     varchar(30) NOT NULL UNIQUE
);

CREATE TABLE stg.cln_dim_data (
    data          date     NOT NULL PRIMARY KEY,
    ano           smallint NOT NULL,
    quadrimestre  smallint NOT NULL CHECK (quadrimestre BETWEEN 1 AND 3)
);

-- -----------------------------------------------------------------------------
-- Já com id_venda no formato final. As colunas de rastreio (fonte, *_origem)
-- não vão para o destino: existem para auditar a carga e reconciliar com a fonte.
CREATE TABLE stg.cln_fat_vendas (
    id_venda          bigint        NOT NULL PRIMARY KEY,
    sk_produto        bigint        NOT NULL,
    sk_loja           bigint        NOT NULL,
    data              date          NOT NULL,
    quantidade        integer       NOT NULL CHECK (quantidade > 0),
    valor_venda       numeric(14,2) NOT NULL CHECK (valor_venda >= 0),
    id_estado_civil   integer       NOT NULL,
    -- rastreio
    fonte             text          NOT NULL,
    id_venda_origem   int           NOT NULL,
    seq_item          int           NOT NULL,
    id_produto_origem int           NOT NULL
);

CREATE TABLE stg.cln_fat_concorrente (
    id_concorrente  bigint        NOT NULL PRIMARY KEY,
    data            date          NOT NULL,
    sk_produto      bigint        NOT NULL,
    quantidade      integer       NOT NULL CHECK (quantidade >= 0),
    valor_venda     numeric(14,2) NOT NULL CHECK (valor_venda >= 0),
    -- rastreio
    ano             smallint      NOT NULL,
    mes             smallint      NOT NULL CHECK (mes BETWEEN 1 AND 12)
);


-- #############################################################################
-- CAMADA REJ — quarentena
-- #############################################################################
-- Uma tabela por destino. `linha_original` guarda a linha raw inteira em jsonb,
-- para que o diagnóstico não dependa de reler o arquivo.
--
-- Consulta de fechamento da carga:
--   SELECT destino, motivo, count(*) FROM stg.rej_carga GROUP BY 1,2 ORDER BY 3 DESC;

CREATE TABLE stg.rej_carga (
    id              bigint      GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    destino         text        NOT NULL,   -- 'fat_vendas', 'dim_produto', ...
    fonte           text        NOT NULL,
    motivo          text        NOT NULL,   -- texto livre, legível
    linha_original  jsonb       NOT NULL,
    rejeitado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_rej_destino_motivo ON stg.rej_carga (destino, motivo);


-- #############################################################################
-- VALIDAÇÃO — views de conferência
-- #############################################################################
-- Rodar DEPOIS de popular raw e ANTES de carregar public. Se qualquer uma
-- devolver linha, a carga não deve prosseguir.

-- Produto de origem sem de-para: significa que map_produto_origem está incompleto
-- e a carga produziria fato órfão.
CREATE VIEW stg.vw_check_produto_sem_mapa AS
SELECT DISTINCT r.fonte, r.id_produto AS id_origem
FROM stg.raw_item_venda r
LEFT JOIN stg.map_produto_origem m
       ON m.fonte = r.fonte AND m.id_origem = r.id_produto::int
WHERE m.id_conformado IS NULL;

-- Estado civil de origem sem de-para (inclui o caso NULL como '(nulo)').
CREATE VIEW stg.vw_check_estado_civil_sem_mapa AS
SELECT DISTINCT c.fonte, COALESCE(c.estado_civil, '(nulo)') AS valor_origem
FROM stg.raw_cliente c
LEFT JOIN stg.map_estado_civil_origem m
       ON m.valor_origem = COALESCE(c.estado_civil, '(nulo)')
WHERE m.id_conformado IS NULL;

-- Datas da fonte fora do calendário carregado em dim_data: violariam a FK.
CREATE VIEW stg.vw_check_data_fora_calendario AS
SELECT DISTINCT f.data
FROM stg.cln_fat_vendas f
LEFT JOIN stg.cln_dim_data d ON d.data = f.data
WHERE d.data IS NULL;

-- Reconciliação de volume: o que saiu da fonte tem que fechar com cln + rej.
-- Esperado: 6.621 itens no total (3.166 Salvador + 1.757 Itabuna + 1.698 Feira).
CREATE VIEW stg.vw_check_reconciliacao AS
SELECT r.fonte,
       count(*)                                             AS itens_raw,
       (SELECT count(*) FROM stg.cln_fat_vendas c WHERE c.fonte = r.fonte) AS itens_limpos,
       (SELECT count(*) FROM stg.rej_carga j
         WHERE j.fonte = r.fonte AND j.destino = 'fat_vendas')             AS itens_rejeitados,
       count(*) - (SELECT count(*) FROM stg.cln_fat_vendas c WHERE c.fonte = r.fonte)
                - (SELECT count(*) FROM stg.rej_carga j
                    WHERE j.fonte = r.fonte AND j.destino = 'fat_vendas')  AS diferenca
FROM stg.raw_item_venda r
GROUP BY r.fonte;
-- `diferenca` DEVE ser 0 em todas as linhas. Diferente de 0 = linha sumiu sem
-- ninguém registrar o motivo, que é o pior modo de falha de um ETL.
