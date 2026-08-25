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
    ON public.fat_vendas (data);
CREATE INDEX IF NOT EXISTS ix_vendas_produto
    ON public.fat_vendas (sk_produto);
CREATE INDEX IF NOT EXISTS ix_vendas_loja
    ON public.fat_vendas (sk_loja);
CREATE INDEX IF NOT EXISTS ix_vendas_estcivil
    ON public.fat_vendas (id_estado_civil);
CREATE INDEX IF NOT EXISTS ix_conc_data
    ON public.fat_concorrente (data);
CREATE INDEX IF NOT EXISTS ix_conc_produto
    ON public.fat_concorrente (sk_produto);
CREATE UNIQUE INDEX IF NOT EXISTS ux_conc_grao
    ON public.fat_concorrente (data, sk_produto);

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

COMMENT ON COLUMN public.dim_loja.estado IS 'UF com duas posições, por exemplo BA.';
COMMENT ON COLUMN public.dim_produto.id_produto IS
    'Chave natural do catálogo conformado; o de-para por fonte fica em stg.';
COMMENT ON COLUMN public.fat_vendas.valor_venda IS
    'Valor total da linha: quantidade multiplicada pelo valor unitário da origem.';
COMMENT ON COLUMN public.fat_concorrente.quantidade IS
    '0 significa não medido na fonte; não representa zero unidades vendidas.';

COMMIT;

-- Resultado esperado: estado_max = 2 e nenhuma coluna FK em falta.
SELECT character_maximum_length AS estado_max
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'dim_loja' AND column_name = 'estado';

