-- =============================================================================
-- PetShop DW — preflight idempotente para o esquema OLAP existente
-- =============================================================================
-- Execute antes do staging. Corrige incompatibilidades que impedem a carga e
-- adiciona as garantias mínimas de integridade, desempenho e segurança.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SELECT pg_advisory_xact_lock(hashtext('petshop_dw_schema'));

DO $$
DECLARE
    nome text;
BEGIN
    FOREACH nome IN ARRAY ARRAY[
        'dim_produto', 'dim_loja', 'dim_estado_civil', 'dim_data',
        'fat_vendas', 'fat_concorrente'
    ] LOOP
        IF to_regclass('public.' || nome) IS NULL THEN
            RAISE EXCEPTION 'tabela obrigatória ausente: public.%', nome;
        END IF;
    END LOOP;
END $$;

-- As views dependem das colunas alteradas abaixo, e `ALTER COLUMN ... TYPE` é
-- recusado mesmo quando o tipo já está correto:
--   ERROR: cannot alter type of a column used by a view or rule
-- Derrubar aqui e recriar no fim é o que torna este script realmente idempotente.
-- A recriação também é a oportunidade de corrigir o `security_invoker` (ver o
-- bloco no fim do arquivo).
DROP VIEW IF EXISTS public.vw_dim_produto_atual;
DROP VIEW IF EXISTS public.vw_dim_loja_atual;

-- ---------------------------------------------------------------------------
-- MIGRAÇÃO DE GRÃO: dim_data diária -> quadrimestral
-- ---------------------------------------------------------------------------
-- A regra de negócio pede análise por quadrimestre e/ou ano. dim_data deixa de
-- ter uma linha por dia (731) e passa a ter uma por (ano, quadrimestre) — 6.
-- A PK deixa de ser `data date` e passa a ser `id_data integer` sequencial,
-- e os dois fatos trocam a coluna `data` por `id_data`.
--
-- ATENÇÃO: este bloco APAGA DADO. É a única operação destrutiva do preflight.
-- É seguro porque a carga é snapshot completo — 40_load_dw.sql já faz
-- TRUNCATE nos dois fatos e recarrega tudo na mesma transação. Rodar o
-- preflight sem rodar a carga em seguida deixa o DW vazio.
--
-- Guardado por IF EXISTS na coluna antiga: depois da primeira execução vira
-- no-op, e o script continua idempotente.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dim_data'
          AND column_name = 'data'
    ) THEN
        RAISE NOTICE 'migrando dim_data para grão quadrimestral (apaga os fatos)';

        TRUNCATE public.fat_vendas, public.fat_concorrente;

        ALTER TABLE public.fat_vendas      DROP CONSTRAINT IF EXISTS fk_vendas_data;
        ALTER TABLE public.fat_concorrente DROP CONSTRAINT IF EXISTS fk_conc_data;
        DROP INDEX IF EXISTS public.ix_vendas_data;
        DROP INDEX IF EXISTS public.ix_conc_data;
        DROP INDEX IF EXISTS public.ux_conc_grao;

        ALTER TABLE public.fat_vendas      DROP COLUMN IF EXISTS data;
        ALTER TABLE public.fat_concorrente DROP COLUMN IF EXISTS data;
        -- NOT NULL sem DEFAULT só passa porque as tabelas acabaram de ser truncadas.
        ALTER TABLE public.fat_vendas      ADD COLUMN id_data integer NOT NULL;
        ALTER TABLE public.fat_concorrente ADD COLUMN id_data integer NOT NULL;

        DELETE FROM public.dim_data;
        ALTER TABLE public.dim_data DROP CONSTRAINT IF EXISTS pk_dim_data;
        ALTER TABLE public.dim_data DROP COLUMN data;
        ALTER TABLE public.dim_data ADD COLUMN id_data integer NOT NULL;
        ALTER TABLE public.dim_data ADD CONSTRAINT pk_dim_data PRIMARY KEY (id_data);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- DERIVA DE ESQUEMA: fat_concorrente.quantidade ausente no banco remoto
-- ---------------------------------------------------------------------------
-- Verificado no projeto Supabase de destino: a tabela tem apenas
-- (id_concorrente, data, sk_produto, valor_venda). A coluna `quantidade`, que
-- o 01_dw_ddl.sql declara NOT NULL e que a carga insere, NÃO existe lá — o
-- INSERT do 40_load_dw.sql falharia com 42703.
--
-- Adicionada como anulável, preenchida com 0 e só então marcada NOT NULL, para
-- funcionar tanto com a tabela vazia quanto populada.
--
-- O 0 aqui significa "não medido na origem", nunca "vendeu zero unidades":
-- a fonte do concorrente é faturamento agregado e não traz quantidade.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fat_concorrente'
          AND column_name = 'quantidade'
    ) THEN
        RAISE NOTICE 'adicionando fat_concorrente.quantidade (ausente no destino)';
        ALTER TABLE public.fat_concorrente ADD COLUMN quantidade integer;
        UPDATE public.fat_concorrente SET quantidade = 0 WHERE quantidade IS NULL;
        ALTER TABLE public.fat_concorrente ALTER COLUMN quantidade SET NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.fat_concorrente'::regclass
          AND conname = 'fat_concorrente_quantidade_check'
    ) THEN
        ALTER TABLE public.fat_concorrente
            ADD CONSTRAINT fat_concorrente_quantidade_check CHECK (quantidade >= 0);
    END IF;
END $$;

-- Garantias do novo grão, idempotentes.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.dim_data'::regclass
                     AND conname = 'uq_dim_data_ano_quad') THEN
        ALTER TABLE public.dim_data
            ADD CONSTRAINT uq_dim_data_ano_quad UNIQUE (ano, quadrimestre);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.fat_vendas'::regclass
                     AND conname = 'fk_vendas_data') THEN
        ALTER TABLE public.fat_vendas ADD CONSTRAINT fk_vendas_data
            FOREIGN KEY (id_data) REFERENCES public.dim_data(id_data);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.fat_concorrente'::regclass
                     AND conname = 'fk_conc_data') THEN
        ALTER TABLE public.fat_concorrente ADD CONSTRAINT fk_conc_data
            FOREIGN KEY (id_data) REFERENCES public.dim_data(id_data);
    END IF;
END $$;

-- `character` sem tamanho é char(1), mas o ETL carrega a UF `BA`.
ALTER TABLE public.dim_loja
    ALTER COLUMN estado TYPE character(2) USING btrim(estado)::character(2);

-- Medidas monetárias aditivas e estáveis para o Power BI.
ALTER TABLE public.fat_vendas
    ALTER COLUMN valor_venda TYPE numeric(14,2) USING valor_venda::numeric(14,2);
ALTER TABLE public.fat_concorrente
    ALTER COLUMN valor_venda TYPE numeric(14,2) USING valor_venda::numeric(14,2);

-- Integridade SCD2. Sem versão explícita da extensão: Supabase usa a default.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.dim_produto'::regclass
          AND conname = 'ck_dim_produto_per'
    ) THEN
        ALTER TABLE public.dim_produto
            ADD CONSTRAINT ck_dim_produto_per CHECK (data_fim > data_inicio);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.dim_loja'::regclass
          AND conname = 'ck_dim_loja_per'
    ) THEN
        ALTER TABLE public.dim_loja
            ADD CONSTRAINT ck_dim_loja_per CHECK (data_fim > data_inicio);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.dim_produto'::regclass
          AND conname = 'ex_produto_per'
    ) THEN
        ALTER TABLE public.dim_produto
            ADD CONSTRAINT ex_produto_per EXCLUDE USING gist (
                id_produto WITH =,
                tsrange(data_inicio, data_fim, '[)') WITH &&
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.dim_loja'::regclass
          AND conname = 'ex_loja_per'
    ) THEN
        ALTER TABLE public.dim_loja
            ADD CONSTRAINT ex_loja_per EXCLUDE USING gist (
                id_loja WITH =,
                tsrange(data_inicio, data_fim, '[)') WITH &&
            );
    END IF;
END $$;

-- Uma única versão corrente por chave natural.
CREATE UNIQUE INDEX IF NOT EXISTS ux_produto_atual
    ON public.dim_produto (id_produto) WHERE flag_atual;
CREATE UNIQUE INDEX IF NOT EXISTS ux_loja_atual
    ON public.dim_loja (id_loja) WHERE flag_atual;

-- Lookups temporais e todas as colunas do lado filho das FKs.
CREATE INDEX IF NOT EXISTS ix_produto_bk
    ON public.dim_produto (id_produto, data_inicio, data_fim);
CREATE INDEX IF NOT EXISTS ix_loja_bk
    ON public.dim_loja (id_loja, data_inicio, data_fim);
CREATE INDEX IF NOT EXISTS ix_vendas_data
    ON public.fat_vendas (id_data);
CREATE INDEX IF NOT EXISTS ix_vendas_produto
    ON public.fat_vendas (sk_produto);
CREATE INDEX IF NOT EXISTS ix_vendas_loja
    ON public.fat_vendas (sk_loja);
CREATE INDEX IF NOT EXISTS ix_vendas_estcivil
    ON public.fat_vendas (id_estado_civil);
CREATE INDEX IF NOT EXISTS ix_conc_data
    ON public.fat_concorrente (id_data, sk_produto);
CREATE INDEX IF NOT EXISTS ix_conc_produto
    ON public.fat_concorrente (sk_produto);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conc_grao
    ON public.fat_concorrente (id_data, sk_produto);

-- O schema public pode ser exposto pela Data API. A carga é administrativa;
-- anon/authenticated não recebem escrita direta nessas tabelas.
ALTER TABLE public.dim_produto      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_loja         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_estado_civil ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dim_data         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fat_vendas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fat_concorrente  ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON public.dim_produto, public.dim_loja, public.dim_estado_civil,
   public.dim_data, public.fat_vendas, public.fat_concorrente
FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recriação das views derrubadas no início
-- ---------------------------------------------------------------------------
-- `security_invoker = true` é obrigatório aqui. Sem ele a view executa com os
-- privilégios do dono (postgres), que ignora o RLS das tabelas — nenhuma delas
-- tem FORCE ROW LEVEL SECURITY. Como as views são auto-atualizáveis (SELECT
-- simples de uma tabela só) e anon tinha UPDATE/DELETE nelas, existia um
-- caminho de escrita anônimo para dim_produto e dim_loja pela Data API,
-- contornando tanto o RLS quanto o REVOKE acima, que só cobre as tabelas.
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

-- Recriar a view zera a ACL, e o ALTER DEFAULT PRIVILEGES do Supabase volta a
-- conceder para anon/authenticated. O REVOKE tem que vir depois do CREATE.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON public.vw_dim_produto_atual, public.vw_dim_loja_atual
FROM anon, authenticated;

COMMENT ON COLUMN public.dim_loja.estado IS 'UF com duas posições, por exemplo BA.';
COMMENT ON COLUMN public.dim_produto.id_produto IS
    'Chave natural do catálogo conformado; o de-para por fonte fica em stg.';
COMMENT ON COLUMN public.fat_vendas.valor_venda IS
    'Valor total da linha: quantidade multiplicada pelo valor unitário da origem.';
COMMENT ON COLUMN public.fat_concorrente.quantidade IS
    '0 significa não medido na fonte; não representa zero unidades vendidas.';
COMMENT ON TABLE public.dim_data IS
    'Grão quadrimestral (ano, quadrimestre): 1 = Jan-Abr, 2 = Mai-Ago, 3 = Set-Dez. '
    'Não é trimestre. id_data é surrogate sequencial sem significado — ordenar '
    'cronologicamente exige ORDER BY ano, quadrimestre.';
COMMENT ON COLUMN public.fat_concorrente.valor_venda IS
    'Soma dos meses do quadrimestre: a fonte é mensal e foi agregada pelo ETL. '
    'O detalhe mensal existe apenas em stg.raw_concorrente.';

COMMIT;

-- Resultado esperado: estado_max = 2 e nenhuma coluna FK em falta.
SELECT character_maximum_length AS estado_max
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'dim_loja' AND column_name = 'estado';
