-- =============================================================================
-- Data Warehouse PetShop — DDL do modelo dimensional (schema public)
-- =============================================================================
-- Instalação limpa para PostgreSQL 17/Supabase. Para o banco OLAP já existente,
-- não execute este arquivo: use 00_preflight.sql.
--
-- Ordem: extensão -> dimensões -> fatos -> views -> RLS.
-- As tabelas de destino NÃO devem ser alteradas. Toda normalização de nome, id,
-- nulo e domínio acontece no schema `stg` (ver 02_stg_ddl.sql).
--
-- Documentação: ../docs/02-dicionario-de-dados.md e ../docs/03-objetos-do-banco.md
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtext('petshop_dw_schema'));

-- -----------------------------------------------------------------------------
-- Extensões
-- -----------------------------------------------------------------------------
-- btree_gist habilita o operador `=` sobre integer dentro de índice gist, que é
-- o que permite as exclusion constraints de SCD2 abaixo. Sem ela, ex_produto_per
-- e ex_loja_per não podem ser criadas.
--
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
SET search_path = public, extensions;


-- =============================================================================
-- DIMENSÕES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dim_produto — SCD tipo 2
-- -----------------------------------------------------------------------------
-- id_produto é a chave natural do CATÁLOGO CONFORMADO (17 produtos), não o id de
-- nenhuma fonte: o mesmo id significa produtos diferentes em Salvador, Itabuna e
-- Feira. O de-para vive em stg.map_produto_origem.
CREATE TABLE public.dim_produto (
    sk_produto        bigint       GENERATED ALWAYS AS IDENTITY,
    id_produto        integer      NOT NULL,
    produto           varchar(120) NOT NULL,
    categoria         varchar(60)  NOT NULL,
    data_inicio       timestamp    NOT NULL,
    data_fim          timestamp    NOT NULL DEFAULT '9999-12-31 00:00:00'::timestamp,
    versao            integer      NOT NULL DEFAULT 1,
    flag_atual        boolean      NOT NULL DEFAULT true,
    data_insercao     timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_atualizacao  timestamp             NULL,

    CONSTRAINT pk_dim_produto  PRIMARY KEY (sk_produto),
    CONSTRAINT ck_dim_produto_per CHECK (data_fim > data_inicio),
    -- impede vigências sobrepostas para a mesma chave natural
    CONSTRAINT ex_produto_per EXCLUDE USING gist (
        id_produto WITH =,
        tsrange(data_inicio, data_fim) WITH &&
    )
);

-- no máximo UMA versão corrente por chave natural
CREATE UNIQUE INDEX ux_produto_atual ON public.dim_produto (id_produto)
    WHERE flag_atual;
-- lookup por chave natural + vigência (point-in-time)
CREATE INDEX ix_produto_bk ON public.dim_produto (id_produto, data_inicio, data_fim);


-- -----------------------------------------------------------------------------
-- dim_loja — SCD tipo 2
-- -----------------------------------------------------------------------------
-- A loja não existe como coluna em nenhuma fonte: é implícita no arquivo de
-- origem. O de-para fonte -> loja vive em stg.map_loja.
CREATE TABLE public.dim_loja (
    sk_loja           bigint       GENERATED ALWAYS AS IDENTITY,
    id_loja           integer      NOT NULL,
    loja              varchar(120) NOT NULL,
    cidade            varchar(80)  NOT NULL,
    estado            char(2)      NOT NULL,
    data_inicio       timestamp    NOT NULL,
    data_fim          timestamp    NOT NULL DEFAULT '9999-12-31 00:00:00'::timestamp,
    versao            integer      NOT NULL DEFAULT 1,
    flag_atual        boolean      NOT NULL DEFAULT true,
    data_insercao     timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_atualizacao  timestamp             NULL,

    CONSTRAINT pk_dim_loja PRIMARY KEY (sk_loja),
    CONSTRAINT ck_dim_loja_per CHECK (data_fim > data_inicio),
    CONSTRAINT ex_loja_per EXCLUDE USING gist (
        id_loja WITH =,
        tsrange(data_inicio, data_fim) WITH &&
    )
);

CREATE UNIQUE INDEX ux_loja_atual ON public.dim_loja (id_loja) WHERE flag_atual;
CREATE INDEX ix_loja_bk ON public.dim_loja (id_loja, data_inicio, data_fim);


-- -----------------------------------------------------------------------------
-- dim_estado_civil — estática (não é SCD2)
-- -----------------------------------------------------------------------------
-- id_estado_civil NÃO é identity: o ETL fornece o valor.
CREATE TABLE public.dim_estado_civil (
    id_estado_civil  integer     NOT NULL,
    estado_civil     varchar(30) NOT NULL,
    data_insercao    timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_dim_estado_civil PRIMARY KEY (id_estado_civil),
    CONSTRAINT uq_dim_estado_civil UNIQUE (estado_civil)
);


-- -----------------------------------------------------------------------------
-- dim_data — calendário, grão diário
-- -----------------------------------------------------------------------------
-- Só ano e quadrimestre. NÃO há coluna de mês: análise mensal exige
-- EXTRACT(MONTH FROM data) na query.
-- quadrimestre = período de 4 meses (1 = Jan-Abr, 2 = Mai-Ago, 3 = Set-Dez).
CREATE TABLE public.dim_data (
    data          date     NOT NULL,
    ano           smallint NOT NULL,
    quadrimestre  smallint NOT NULL,

    CONSTRAINT pk_dim_data PRIMARY KEY (data),
    CONSTRAINT dim_data_quadrimestre_check CHECK (quadrimestre >= 1 AND quadrimestre <= 3)
);


-- =============================================================================
-- FATOS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- fat_vendas — grão: item de venda
-- -----------------------------------------------------------------------------
-- ATENÇÃO à chave: o grão é ITEM (existe sk_produto), mas a PK é id_venda.
-- Como as três fontes numeram vendas a partir de 1 e uma venda tem até 5 itens
-- (com 592 casos de produto repetido dentro do mesmo pedido), id_venda NÃO pode
-- ser o número da venda na origem. O staging gera uma chave composta decodificável:
--
--     id_venda = sk_loja * 1000000000 + id_venda_origem * 100 + seq_item
--
-- Assim (id_venda / 100) reagrupa os itens do mesmo pedido original e
-- (id_venda / 1000000000) devolve a loja. Ver ../docs/06-ingestao-e-staging.md
CREATE TABLE public.fat_vendas (
    id_venda         bigint        NOT NULL,
    sk_produto       bigint        NOT NULL,
    sk_loja          bigint        NOT NULL,
    data             date          NOT NULL,
    quantidade       integer       NOT NULL,
    valor_venda      numeric(14,2) NOT NULL,
    id_estado_civil  integer       NOT NULL,

    CONSTRAINT pk_fat_vendas PRIMARY KEY (id_venda),
    CONSTRAINT fk_vendas_produto  FOREIGN KEY (sk_produto)      REFERENCES public.dim_produto(sk_produto),
    CONSTRAINT fk_vendas_loja     FOREIGN KEY (sk_loja)         REFERENCES public.dim_loja(sk_loja),
    CONSTRAINT fk_vendas_data     FOREIGN KEY (data)            REFERENCES public.dim_data(data),
    CONSTRAINT fk_vendas_estcivil FOREIGN KEY (id_estado_civil) REFERENCES public.dim_estado_civil(id_estado_civil),
    CONSTRAINT fat_vendas_quantidade_check  CHECK (quantidade > 0),
    CONSTRAINT fat_vendas_valor_venda_check CHECK (valor_venda >= 0)
);

CREATE INDEX ix_vendas_data     ON public.fat_vendas (data);
CREATE INDEX ix_vendas_produto  ON public.fat_vendas (sk_produto);
CREATE INDEX ix_vendas_loja     ON public.fat_vendas (sk_loja);
CREATE INDEX ix_vendas_estcivil ON public.fat_vendas (id_estado_civil);


-- -----------------------------------------------------------------------------
-- fat_concorrente — grão declarado: produto x data
-- -----------------------------------------------------------------------------
-- A fonte real (08_Vendas_Concorrente.xlsx) é faturamento MENSAL AGREGADO:
-- só Ano, Mês e Vendas (R$). Não tem produto, não tem quantidade, não tem dia.
--
-- Como o destino não muda, o staging carrega usando membros sentinela:
--   data       = primeiro dia do mês
--   sk_produto = membro 'Não aplicável' de dim_produto (id_produto = 999)
--   quantidade = 0   (permitido: o CHECK aqui é >= 0, ao contrário de fat_vendas)
--
-- CONSEQUÊNCIA: SUM(quantidade) nesta tabela é sempre 0 e NÃO significa
-- "vendeu zero unidades" — significa "não medido na origem". Nunca comparar
-- quantidade entre fat_vendas e fat_concorrente.
--
-- Não existe UNIQUE (data, sk_produto): a tabela aceita duplicata do grão.
CREATE TABLE public.fat_concorrente (
    id_concorrente  bigint        NOT NULL,
    data            date          NOT NULL,
    sk_produto      bigint        NOT NULL,
    quantidade      integer       NOT NULL,
    valor_venda     numeric(14,2) NOT NULL,

    CONSTRAINT pk_fat_concorrente PRIMARY KEY (id_concorrente),
    CONSTRAINT fk_conc_data    FOREIGN KEY (data)       REFERENCES public.dim_data(data),
    CONSTRAINT fk_conc_produto FOREIGN KEY (sk_produto) REFERENCES public.dim_produto(sk_produto),
    CONSTRAINT fat_concorrente_quantidade_check  CHECK (quantidade >= 0),
    CONSTRAINT fat_concorrente_valor_venda_check CHECK (valor_venda >= 0)
);

CREATE INDEX ix_conc_data ON public.fat_concorrente (data, sk_produto);
CREATE INDEX ix_conc_produto ON public.fat_concorrente (sk_produto);
CREATE UNIQUE INDEX ux_conc_grao ON public.fat_concorrente (data, sk_produto);


-- =============================================================================
-- VIEWS
-- =============================================================================
-- security_invoker faz as views respeitarem RLS e privilégios do chamador.
CREATE VIEW public.vw_dim_produto_atual
WITH (security_invoker = true) AS
SELECT sk_produto, id_produto, produto, categoria
FROM public.dim_produto
WHERE flag_atual;

CREATE VIEW public.vw_dim_loja_atual
WITH (security_invoker = true) AS
SELECT sk_loja, id_loja, loja, cidade, estado
FROM public.dim_loja
WHERE flag_atual;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Habilitado nas 6 tabelas, com ZERO políticas — o que nega tudo para anon e
-- authenticated. Note que os grants seguem totalmente abertos (arwdDxtm para
-- anon e authenticated): o RLS é a única barreira. Ver docs/04.
--
-- RLS é explícito em cada tabela; não há função SECURITY DEFINER nem event
-- trigger exposto no schema public.

ALTER TABLE public.dim_produto      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_loja         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_estado_civil ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_data         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fat_vendas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fat_concorrente  ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- O que NÃO existe no banco (verificado)
-- =============================================================================
--   * Políticas RLS — zero
--   * Triggers de tabela — nenhum. data_atualizacao NÃO é preenchida
--     automaticamente; é responsabilidade do ETL
--   * Materialized views, tabelas particionadas, cron jobs, edge functions
--   * Migrations versionadas — supabase_migrations.schema_migrations está vazia
--
-- Colunas removidas em versões anteriores do modelo (buracos em pg_attribute,
-- sem registro do que eram): dim_data #3, dim_estado_civil #1/#4/#5/#6/#7,
-- fat_vendas #3/#9, fat_concorrente #6.
-- Ver ../docs/01-modelo-dimensional.md

RESET search_path;
COMMIT;
