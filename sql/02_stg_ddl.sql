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
-- Fluxo: arquivos -> raw (Node.js) -> cln + rej -> public
--
-- NOTA: o event trigger `ensure_rls` tem a lista de schemas fixa em ('public'),
-- então este schema NÃO recebe RLS automático. Ele também não está na lista de
-- schemas expostos do PostgREST, então não é alcançável pela API REST.
-- Não exponha `stg` na API.
--
-- Documentação: ../docs/06-ingestao-e-staging.md
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtext('petshop_etl_staging_ddl'));

CREATE SCHEMA IF NOT EXISTS stg;

-- fecha o schema para os papéis da API, por precaução
REVOKE ALL ON SCHEMA stg FROM anon, authenticated;

-- Uma linha por execução. O manifesto contém nome, tamanho e SHA-256 de cada
-- arquivo, permitindo provar exatamente quais fontes produziram o lote.
CREATE TABLE IF NOT EXISTS stg.etl_carga (
    id_carga       uuid        PRIMARY KEY,
    status         text        NOT NULL CHECK (status IN (
        'iniciada', 'extraida', 'mapeada', 'transformada', 'concluida', 'falhou'
    )),
    origem         text        NOT NULL,
    data_efetiva   timestamptz NOT NULL,
    manifesto      jsonb       NOT NULL,
    resumo         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    iniciado_em    timestamptz NOT NULL DEFAULT clock_timestamp(),
    finalizado_em  timestamptz,
    erro           text
);

REVOKE ALL ON ALL TABLES IN SCHEMA stg FROM anon, authenticated;


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
CREATE TABLE IF NOT EXISTS stg.raw_produto (
    id_carga       uuid NOT NULL,
    fonte          text NOT NULL,     -- 'salvador' | 'itabuna' | 'feira'
    ordem_arquivo  int  NOT NULL,     -- 1-based; reconstrói o SERIAL do Itabuna
    id_origem      text,              -- NULL no Itabuna (SERIAL implícito)
    nome           text,
    categoria      text,              -- Salvador: já resolvida via join em categorias
    preco          text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

-- Salvador é a única fonte com categorias normalizada em tabela própria.
CREATE TABLE IF NOT EXISTS stg.raw_categoria (
    id_carga       uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.raw_cliente (
    id_carga         uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.raw_venda (
    id_carga       uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.raw_item_venda (
    id_carga       uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.raw_servico (
    id_carga       uuid NOT NULL,
    fonte          text NOT NULL,
    ordem_arquivo  int  NOT NULL,
    id_origem      text,
    descricao      text,
    valor          text,
    carregado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stg.raw_atendimento (
    id_carga          uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.raw_concorrente (
    id_carga       uuid NOT NULL,
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
CREATE TABLE IF NOT EXISTS stg.map_produto (
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
CREATE TABLE IF NOT EXISTS stg.map_produto_origem (
    fonte          text NOT NULL,
    id_origem      int  NOT NULL,
    id_conformado  int  NOT NULL REFERENCES stg.map_produto(id_conformado),
    CONSTRAINT pk_map_produto_origem PRIMARY KEY (fonte, id_origem)
);

-- -----------------------------------------------------------------------------
-- Domínio de estado civil: 5 valores reais + 'Não informado' para os nulos.
-- id_conformado é o que vai para dim_estado_civil.id_estado_civil (que não é
-- identity — o ETL fornece o valor).
CREATE TABLE IF NOT EXISTS stg.map_estado_civil (
    id_conformado  int         PRIMARY KEY,
    rotulo         varchar(30) NOT NULL UNIQUE
);

-- Aceita os três domínios de origem apontando para o mesmo rótulo:
--   'C' e 'Casado' -> Casado
-- A entrada para NULL é tratada no ETL (não dá para ter NULL em PK), via
-- COALESCE para a chave literal '(nulo)'.
CREATE TABLE IF NOT EXISTS stg.map_estado_civil_origem (
    valor_origem   text NOT NULL,   -- 'C','U','Casado','União Estável','(nulo)'
    id_conformado  int  NOT NULL REFERENCES stg.map_estado_civil(id_conformado),
    CONSTRAINT pk_map_estado_civil_origem PRIMARY KEY (valor_origem)
);

-- -----------------------------------------------------------------------------
-- Lojas: NÃO existem como coluna em nenhuma fonte. A loja é implícita no
-- arquivo de origem, e é aqui que a atribuição fica explícita.
CREATE TABLE IF NOT EXISTS stg.map_loja (
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
CREATE TABLE IF NOT EXISTS stg.cln_dim_produto (
    id_produto  integer      NOT NULL PRIMARY KEY,
    produto     varchar(120) NOT NULL,
    categoria   varchar(60)  NOT NULL
);

CREATE TABLE IF NOT EXISTS stg.cln_dim_loja (
    id_loja  integer      NOT NULL PRIMARY KEY,
    loja     varchar(120) NOT NULL,
    cidade   varchar(80)  NOT NULL,
    estado   char(2)      NOT NULL
);

CREATE TABLE IF NOT EXISTS stg.cln_dim_estado_civil (
    id_estado_civil  integer     NOT NULL PRIMARY KEY,
    estado_civil     varchar(30) NOT NULL UNIQUE
);

-- MIGRACAO: a camada cln mudou de grao (data diaria -> id_data quadrimestral).
-- `CREATE TABLE IF NOT EXISTS` nao altera tabela existente, entao as tres
-- tabelas afetadas sao derrubadas e recriadas. Nao ha perda: cln_* e 100%
-- derivada de raw_* + map_* e e TRUNCADA a cada carga de qualquer forma.
DROP TABLE IF EXISTS stg.cln_dim_data;
DROP TABLE IF EXISTS stg.cln_fat_vendas;
DROP TABLE IF EXISTS stg.cln_fat_concorrente;

-- Grao QUADRIMESTRAL, igual ao destino: 6 linhas para 2024-2025.
-- id_data e surrogate sequencial 1..N fornecido pelo ETL.
CREATE TABLE IF NOT EXISTS stg.cln_dim_data (
    id_data       integer  NOT NULL PRIMARY KEY,
    ano           smallint NOT NULL,
    quadrimestre  smallint NOT NULL CHECK (quadrimestre BETWEEN 1 AND 3),
    CONSTRAINT uq_cln_dim_data_ano_quad UNIQUE (ano, quadrimestre)
);

-- -----------------------------------------------------------------------------
-- Já com id_venda no formato final. As colunas de rastreio (fonte, *_origem)
-- não vão para o destino: existem para auditar a carga e reconciliar com a fonte.
CREATE TABLE IF NOT EXISTS stg.cln_fat_vendas (
    id_venda          bigint        NOT NULL PRIMARY KEY,
    sk_produto        bigint        NOT NULL,
    sk_loja           bigint        NOT NULL,
    id_data           integer       NOT NULL,
    -- `data` NAO vai para o destino: public e quadrimestral. Ela fica aqui
    -- porque o lookup SCD2 precisa da data REAL do fato para achar a versao
    -- vigente de produto e loja — e porque e o que permite reconciliar a carga
    -- com a origem. E o unico lugar do pipeline onde a data da venda sobrevive
    -- de forma consultavel.
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

-- A fonte e MENSAL (24 linhas) e o destino e QUADRIMESTRAL (6 linhas): esta
-- camada ja recebe o dado AGREGADO pelo conformador. O detalhe mensal existe
-- somente em stg.raw_concorrente.
CREATE TABLE IF NOT EXISTS stg.cln_fat_concorrente (
    id_concorrente  bigint        NOT NULL PRIMARY KEY,
    id_data         integer       NOT NULL,
    sk_produto      bigint        NOT NULL,
    quantidade      integer       NOT NULL CHECK (quantidade >= 0),
    valor_venda     numeric(14,2) NOT NULL CHECK (valor_venda >= 0),
    -- rastreio
    ano             smallint      NOT NULL,
    quadrimestre    smallint      NOT NULL CHECK (quadrimestre BETWEEN 1 AND 3),
    -- quantos meses da origem entraram nesta linha; a soma tem que dar 24
    meses_agregados smallint      NOT NULL CHECK (meses_agregados > 0),
    -- primeiro dia do quadrimestre; existe SO para ancorar o lookup SCD2 do
    -- produto sentinela. Nao vai para o destino.
    data_referencia date          NOT NULL,
    CONSTRAINT uq_cln_conc_grao UNIQUE (id_data, sk_produto)
);


-- #############################################################################
-- CAMADA REJ — quarentena
-- #############################################################################
-- Uma tabela por destino. `linha_original` guarda a linha raw inteira em jsonb,
-- para que o diagnóstico não dependa de reler o arquivo.
--
-- Consulta de fechamento da carga:
--   SELECT destino, motivo, count(*) FROM stg.rej_carga GROUP BY 1,2 ORDER BY 3 DESC;

CREATE TABLE IF NOT EXISTS stg.rej_carga (
    id              bigint      GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    id_carga        uuid        NOT NULL,
    destino         text        NOT NULL,   -- 'fat_vendas', 'dim_produto', ...
    fonte           text        NOT NULL,
    motivo          text        NOT NULL,   -- texto livre, legível
    linha_original  jsonb       NOT NULL,
    rejeitado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rej_carga_destino_motivo
    ON stg.rej_carga (id_carga, destino, motivo);

-- Upgrade seguro de uma versão anterior do staging. O staging é descartável;
-- os fatos publicados em public não são tocados aqui.
TRUNCATE stg.raw_produto, stg.raw_categoria, stg.raw_cliente, stg.raw_venda,
         stg.raw_item_venda, stg.raw_servico, stg.raw_atendimento,
         stg.raw_concorrente, stg.rej_carga;

ALTER TABLE stg.raw_produto      ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_categoria    ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_cliente      ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_venda        ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_item_venda   ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_servico      ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_atendimento  ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.raw_concorrente  ADD COLUMN IF NOT EXISTS id_carga uuid;
ALTER TABLE stg.rej_carga        ADD COLUMN IF NOT EXISTS id_carga uuid;

ALTER TABLE stg.raw_produto      ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_categoria    ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_cliente      ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_venda        ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_item_venda   ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_servico      ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_atendimento  ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.raw_concorrente  ALTER COLUMN id_carga SET NOT NULL;
ALTER TABLE stg.rej_carga        ALTER COLUMN id_carga SET NOT NULL;

DO $$
DECLARE
    tabela text;
    nome_constraint text;
BEGIN
    FOREACH tabela IN ARRAY ARRAY[
        'raw_produto', 'raw_categoria', 'raw_cliente', 'raw_venda',
        'raw_item_venda', 'raw_servico', 'raw_atendimento',
        'raw_concorrente', 'rej_carga'
    ] LOOP
        nome_constraint := 'fk_' || tabela || '_carga';
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = ('stg.' || tabela)::regclass
              AND conname = nome_constraint
        ) THEN
            EXECUTE format(
                'ALTER TABLE stg.%I ADD CONSTRAINT %I FOREIGN KEY (id_carga) REFERENCES stg.etl_carga(id_carga)',
                tabela, nome_constraint
            );
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA stg FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA stg FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA stg REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA stg REVOKE ALL ON SEQUENCES FROM anon, authenticated;


-- #############################################################################
-- VALIDAÇÃO — views de conferência
-- #############################################################################
-- Rodar DEPOIS de popular raw e ANTES de carregar public. Se qualquer uma
-- devolver linha, a carga não deve prosseguir.

-- Produto de origem sem de-para: significa que map_produto_origem está incompleto
-- e a carga produziria fato órfão.
CREATE OR REPLACE VIEW stg.vw_check_produto_sem_mapa
WITH (security_invoker = true) AS
SELECT DISTINCT r.fonte, r.id_produto AS id_origem, r.id_carga
FROM stg.raw_item_venda r
LEFT JOIN stg.map_produto_origem m
       ON m.fonte = r.fonte AND m.id_origem = r.id_produto::int
WHERE m.id_conformado IS NULL;

-- Estado civil de origem sem de-para (inclui o caso NULL como '(nulo)').
CREATE OR REPLACE VIEW stg.vw_check_estado_civil_sem_mapa
WITH (security_invoker = true) AS
SELECT DISTINCT c.fonte,
       COALESCE(c.estado_civil, '(nulo)') AS valor_origem,
       c.id_carga
FROM stg.raw_cliente c
LEFT JOIN stg.map_estado_civil_origem m
       ON m.valor_origem = COALESCE(c.estado_civil, '(nulo)')
WHERE m.id_conformado IS NULL;

-- Fatos apontando para quadrimestre inexistente em dim_data: violariam a FK.
CREATE OR REPLACE VIEW stg.vw_check_data_fora_calendario
WITH (security_invoker = true) AS
SELECT DISTINCT f.id_data, f.data
FROM stg.cln_fat_vendas f
LEFT JOIN stg.cln_dim_data d ON d.id_data = f.id_data
WHERE d.id_data IS NULL
UNION
SELECT DISTINCT c.id_data, c.data_referencia
FROM stg.cln_fat_concorrente c
LEFT JOIN stg.cln_dim_data d ON d.id_data = c.id_data
WHERE d.id_data IS NULL;

-- Coerencia do id_data derivado: o quadrimestre gravado no fato tem que bater
-- com o que a data real diz. Pega erro de derivacao no conformador.
CREATE OR REPLACE VIEW stg.vw_check_quadrimestre_derivado
WITH (security_invoker = true) AS
SELECT f.id_data, f.data, d.ano, d.quadrimestre, count(*) AS linhas
FROM stg.cln_fat_vendas f
JOIN stg.cln_dim_data d ON d.id_data = f.id_data
WHERE d.ano <> EXTRACT(YEAR FROM f.data)::smallint
   OR d.quadrimestre <> CEIL(EXTRACT(MONTH FROM f.data) / 4.0)::smallint
GROUP BY 1, 2, 3, 4;

-- Agregacao do concorrente: 24 meses da origem tem que virar 6 quadrimestres
-- sem perder linha nem dinheiro. E o unico ponto do pipeline onde N vira 1.
CREATE OR REPLACE VIEW stg.vw_check_agregacao_concorrente
WITH (security_invoker = true) AS
SELECT r.id_carga,
       count(*)                                                    AS meses_raw,
       (SELECT sum(meses_agregados) FROM stg.cln_fat_concorrente)  AS meses_contabilizados,
       (SELECT count(*) FROM stg.cln_fat_concorrente)              AS quadrimestres_cln,
       count(*) - (SELECT sum(meses_agregados) FROM stg.cln_fat_concorrente) AS diferenca
FROM stg.raw_concorrente r
GROUP BY r.id_carga;
-- `diferenca` DEVE ser 0.

-- Reconciliação de volume: o que saiu da fonte tem que fechar com cln + rej.
-- Esperado: 6.621 itens no total (3.166 Salvador + 1.757 Itabuna + 1.698 Feira).
CREATE OR REPLACE VIEW stg.vw_check_reconciliacao
WITH (security_invoker = true) AS
SELECT r.fonte,
       count(*)                                             AS itens_raw,
       (SELECT count(*) FROM stg.cln_fat_vendas c WHERE c.fonte = r.fonte) AS itens_limpos,
       (SELECT count(*) FROM stg.rej_carga j
         WHERE j.id_carga = r.id_carga
           AND j.fonte = r.fonte AND j.destino = 'fat_vendas')             AS itens_rejeitados,
       count(*) - (SELECT count(*) FROM stg.cln_fat_vendas c WHERE c.fonte = r.fonte)
                - (SELECT count(*) FROM stg.rej_carga j
                    WHERE j.id_carga = r.id_carga
                      AND j.fonte = r.fonte AND j.destino = 'fat_vendas')  AS diferenca,
       r.id_carga
FROM stg.raw_item_venda r
GROUP BY r.id_carga, r.fonte;
-- `diferenca` DEVE ser 0 em todas as linhas. Diferente de 0 = linha sumiu sem
-- ninguém registrar o motivo, que é o pior modo de falha de um ETL.

COMMIT;
