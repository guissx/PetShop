# 03 — Objetos do banco

Inventário histórico levantado do modelo original em PostgreSQL 17.6. Para a
estrutura executável atual, prevalecem `sql/00_preflight.sql`,
`sql/01_dw_ddl.sql` e `sql/02_stg_ddl.sql`.

## Schemas

| Schema | Origem | Uso no projeto |
|---|---|---|
| `public` | aplicação | **Todo o DW** — 6 tabelas, 2 views |
| `auth`, `storage`, `realtime`, `graphql`, `graphql_public`, `vault`, `extensions` | Supabase | Infraestrutura da plataforma, não usados pelo projeto |

Não existe schema de staging. Proposta em [06](06-ingestao-e-staging.md).

## Tabelas e views

| Objeto | Tipo | Linhas | RLS | Dono |
|---|---|---:|---|---|
| `dim_produto` | tabela | 0 | habilitado | `postgres` |
| `dim_loja` | tabela | 0 | habilitado | `postgres` |
| `dim_estado_civil` | tabela | 0 | habilitado | `postgres` |
| `dim_data` | tabela | 0 | habilitado | `postgres` |
| `fat_vendas` | tabela | 0 | habilitado | `postgres` |
| `fat_concorrente` | tabela | 0 | habilitado | `postgres` |
| `vw_dim_produto_atual` | view | — | n/a | `postgres` |
| `vw_dim_loja_atual` | view | — | n/a | `postgres` |

Nenhuma tabela tem `FORCE ROW LEVEL SECURITY` (`relforcerowsecurity = false`) —
o que tem consequência de segurança, ver [04](04-seguranca-e-acesso.md).

Nenhuma materialized view, nenhuma tabela particionada, nenhum trigger de tabela.

## Índices (18 no total)

| Tabela | Índice | Tipo | Definição |
|---|---|---|---|
| `dim_data` | `pk_dim_data` | btree unique | `(id_data)` |
| | `uq_dim_data_ano_quad` | btree unique | `(ano, quadrimestre)` — declara o grão |
| `dim_estado_civil` | `pk_dim_estado_civil` | btree unique | `(id_estado_civil)` |
| | `uq_dim_estado_civil` | btree unique | `(estado_civil)` |
| `dim_loja` | `pk_dim_loja` | btree unique | `(sk_loja)` |
| | `ux_loja_atual` | btree unique **parcial** | `(id_loja) WHERE flag_atual` |
| | `ix_loja_bk` | btree | `(id_loja, data_inicio, data_fim)` |
| | `ex_loja_per` | **gist** | `(id_loja, tsrange(data_inicio, data_fim))` |
| `dim_produto` | `pk_dim_produto` | btree unique | `(sk_produto)` |
| | `ux_produto_atual` | btree unique **parcial** | `(id_produto) WHERE flag_atual` |
| | `ix_produto_bk` | btree | `(id_produto, data_inicio, data_fim)` |
| | `ex_produto_per` | **gist** | `(id_produto, tsrange(data_inicio, data_fim))` |
| `fat_vendas` | `pk_fat_vendas` | btree unique | `(id_venda)` |
| | `ix_vendas_data` | btree | `(id_data)` |
| | `ix_vendas_produto` | btree | `(sk_produto)` |
| | `ix_vendas_loja` | btree | `(sk_loja)` |
| | `ix_vendas_estcivil` | btree | `(id_estado_civil)` |
| `fat_concorrente` | `pk_fat_concorrente` | btree unique | `(id_concorrente)` |
| | `ix_conc_data` | btree | `(id_data, sk_produto)` |

Os dois índices gist não são escolha de tuning — eles **implementam** as
exclusion constraints do SCD2. Não podem ser removidos sem derrubar a constraint.

O linter reporta 9 índices como "não utilizados", o que é esperado num banco com
zero linhas e zero consultas. Não é sinal de problema neste momento.

## Constraints (22 no total)

### Chaves primárias (6)

Uma por tabela: `pk_dim_data`, `pk_dim_estado_civil`, `pk_dim_loja`,
`pk_dim_produto`, `pk_fat_vendas`, `pk_fat_concorrente`.

### Chaves estrangeiras (6)

| Constraint | De | Para |
|---|---|---|
| `fk_vendas_produto` | `fat_vendas(sk_produto)` | `dim_produto(sk_produto)` |
| `fk_vendas_loja` | `fat_vendas(sk_loja)` | `dim_loja(sk_loja)` |
| `fk_vendas_data` | `fat_vendas(id_data)` | `dim_data(id_data)` |
| `fk_vendas_estcivil` | `fat_vendas(id_estado_civil)` | `dim_estado_civil(id_estado_civil)` |
| `fk_conc_produto` | `fat_concorrente(sk_produto)` | `dim_produto(sk_produto)` |
| `fk_conc_data` | `fat_concorrente(id_data)` | `dim_data(id_data)` |

Todas sem `ON DELETE`/`ON UPDATE` explícito → `NO ACTION`.
Todas sobre colunas `NOT NULL` → não há membro "desconhecido" possível.

### Unique (1)

`uq_dim_estado_civil UNIQUE (estado_civil)`

Note que as garantias de "uma versão corrente por chave natural" em
`dim_produto`/`dim_loja` **não** são constraints — são índices únicos parciais
(`ux_produto_atual`, `ux_loja_atual`). Funcionam igual na prática, mas não
aparecem em `pg_constraint`.

### Check (7)

| Constraint | Tabela | Regra |
|---|---|---|
| `ck_dim_produto_per` | `dim_produto` | `data_fim > data_inicio` |
| `ck_dim_loja_per` | `dim_loja` | `data_fim > data_inicio` |
| `dim_data_quadrimestre_check` | `dim_data` | `quadrimestre BETWEEN 1 AND 3` |
| `fat_vendas_quantidade_check` | `fat_vendas` | `quantidade > 0` |
| `fat_vendas_valor_venda_check` | `fat_vendas` | `valor_venda >= 0` |
| `fat_concorrente_quantidade_check` | `fat_concorrente` | `quantidade >= 0` |
| `fat_concorrente_valor_venda_check` | `fat_concorrente` | `valor_venda >= 0` |

Os nomes gerados automaticamente (`*_check`) revelam quais foram declarados
inline na coluna; os prefixados `ck_` foram nomeados à mão.

### Exclusion (2)

```sql
ex_produto_per  EXCLUDE USING gist (id_produto WITH =, tsrange(data_inicio, data_fim) WITH &&)
ex_loja_per     EXCLUDE USING gist (id_loja    WITH =, tsrange(data_inicio, data_fim) WITH &&)
```

Impedem que duas versões da mesma chave natural tenham vigências sobrepostas.
São o coração da garantia de integridade do SCD2 — ver
[01](01-modelo-dimensional.md#como-o-scd2-é-garantido-pelo-banco).

Dependem da extensão `btree_gist` (o operador `=` sobre `integer` dentro de um
índice gist só existe por causa dela).

## Sequências (2)

| Sequência | Vinculada a | Start | Increment |
|---|---|---:|---:|
| `dim_produto_sk_produto_seq` | `dim_produto.sk_produto` | 1 | 1 |
| `dim_loja_sk_loja_seq` | `dim_loja.sk_loja` | 1 | 1 |

Ambas são sequências de `IDENTITY` **`GENERATED BY DEFAULT`** (não `ALWAYS`).
Isso significa que o ETL **pode** fornecer o `sk` explicitamente — útil para
carga controlada, mas exige `setval` depois para não colidir com inserções
futuras.

`dim_estado_civil.id_estado_civil`, `fat_vendas.id_venda` e
`fat_concorrente.id_concorrente` **não** têm sequência — o ETL é obrigado a
gerar esses valores.

## Extensões instaladas (6)

| Extensão | Versão | Schema | Papel no projeto |
|---|---|---|---|
| `plpgsql` | 1.0 | `pg_catalog` | Padrão do PostgreSQL |
| `btree_gist` | 1.7 | **`public`** | **Necessária** — habilita as exclusion constraints do SCD2 |
| `pgcrypto` | 1.3 | `extensions` | Padrão Supabase, não usada |
| `pg_stat_statements` | 1.11 | `extensions` | Padrão Supabase, telemetria |
| `supabase_vault` | 0.3.1 | `vault` | Padrão Supabase, não usada |
| `uuid-ossp` | 1.1 | `extensions` | Padrão Supabase, não usada |

> ⚠️ `btree_gist` está instalada em `public`, e o linter do Supabase sinaliza
> isso como `extension_in_public` (WARN). Mover para `extensions` é o
> recomendado, mas **exige recriar as duas exclusion constraints**, que dependem
> dela. Enquanto o banco está vazio, o custo de mover é mínimo — depois de
> carregado, é uma operação com lock. Ver
> [04](04-seguranca-e-acesso.md#4-btree_gist-em-public-warn).

## Event triggers

Além dos 6 event triggers padrão do Supabase (PostgREST schema reload, pg_cron,
pg_net, pg_graphql), existe **um criado pelo projeto**:

| Nome | Evento | Função |
|---|---|---|
| `ensure_rls` | `ddl_command_end` | `public.rls_auto_enable()` |

```sql
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND ... THEN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
     ...
```

É isso que explica por que as 6 tabelas têm RLS habilitado sem nenhuma política:
**o RLS foi ligado automaticamente na criação**, não por decisão explícita de
modelagem de acesso.

Duas implicações práticas:

1. **A lista de schemas é fixa em `('public')`.** Um schema `stg` novo **não**
   receberá RLS automático. Como `stg` também não seria exposto no PostgREST,
   isso é aceitável — mas é bom saber que a proteção não se estende sozinha.
2. **A função é `SECURITY DEFINER` e está exposta na API REST.** Ver
   [04](04-seguranca-e-acesso.md#3-função-security-definer-exposta-warn).

## O que não existe

Para deixar explícito o que foi verificado e está ausente:

- **Migrations versionadas** — `supabase_migrations.schema_migrations` está vazia.
  Todo o DDL foi aplicado ad-hoc (SQL editor ou psql). **O modelo não está no
  repositório.**
- **`COMMENT`** — nenhuma tabela, coluna ou view tem comentário. Toda a semântica
  está implícita nos nomes.
- **Triggers de tabela** — nenhum. Em particular, `data_atualizacao` não é
  preenchida automaticamente; é responsabilidade do ETL.
- **Funções de negócio** — só `rls_auto_enable()`. As outras ~190 funções em
  `public` pertencem à extensão `btree_gist` (`gbt_*`, `*_dist`).
- **Políticas RLS** — zero.
- **Edge Functions, cron jobs, realtime publications** — nada configurado.
