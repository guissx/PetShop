# 02 — Dicionário de dados

Todas as tabelas em `public`. **Nenhuma tabela tem `COMMENT`** — as descrições
abaixo são inferidas do nome, do tipo e das constraints. PostgreSQL 17.6.

Legenda: `PK` chave primária · `FK` chave estrangeira · `UK` único ·
`NN` not null · `SCD2` coluna de controle de versão

---

## dim_produto

Dimensão de produto, **SCD tipo 2**. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `sk_produto` | `bigint` | NN | *identity BY DEFAULT* | **PK**. Surrogate key |
| 2 | `id_produto` | `integer` | NN | — | Chave natural do produto. **Global** — sem coluna de fonte |
| 3 | `produto` | `varchar(120)` | NN | — | Nome do produto |
| 4 | `categoria` | `varchar(60)` | NN | — | Categoria desnormalizada. **NN** — a fonte tem nulos |
| 5 | `data_inicio` | `timestamp` | NN | — | SCD2. Início da vigência. **Sem default** |
| 6 | `data_fim` | `timestamp` | NN | `9999-12-31 00:00:00` | SCD2. Fim da vigência (exclusivo) |
| 7 | `versao` | `integer` | NN | `1` | SCD2. Número da versão |
| 8 | `flag_atual` | `boolean` | NN | `true` | SCD2. Versão corrente |
| 9 | `data_insercao` | `timestamp` | NN | `CURRENT_TIMESTAMP` | Auditoria |
| 10 | `data_atualizacao` | `timestamp` | **NULL** | — | Auditoria. Único campo nulável da tabela |

**Constraints**

- `pk_dim_produto` — `PRIMARY KEY (sk_produto)`
- `ck_dim_produto_per` — `CHECK (data_fim > data_inicio)`
- `ex_produto_per` — `EXCLUDE USING gist (id_produto WITH =, tsrange(data_inicio, data_fim) WITH &&)`

**Índices**

- `pk_dim_produto` — unique btree `(sk_produto)`
- `ux_produto_atual` — **unique** btree `(id_produto) WHERE flag_atual` — no máximo uma versão corrente por chave natural
- `ix_produto_bk` — btree `(id_produto, data_inicio, data_fim)` — lookup por chave natural + vigência
- `ex_produto_per` — gist `(id_produto, tsrange(...))` — suporta a exclusion constraint

**Sequência**: `dim_produto_sk_produto_seq` (start 1, increment 1)

> ⚠️ `categoria` é `NOT NULL`, mas 5 produtos da fonte Salvador têm categoria
> nula. Ver [05](05-fontes-de-dados.md#salvador--oracle).

---

## dim_loja

Dimensão de loja, **SCD tipo 2**. Estrutura idêntica a `dim_produto`, com
atributos geográficos. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `sk_loja` | `bigint` | NN | *identity BY DEFAULT* | **PK**. Surrogate key |
| 2 | `id_loja` | `integer` | NN | — | Chave natural. **Global** |
| 3 | `loja` | `varchar(120)` | NN | — | Nome da loja |
| 4 | `cidade` | `varchar(80)` | NN | — | Cidade |
| 5 | `estado` | `char(2)` | NN | — | UF. Tipo `char` — preenche com espaços à direita |
| 6 | `data_inicio` | `timestamp` | NN | — | SCD2 |
| 7 | `data_fim` | `timestamp` | NN | `9999-12-31 00:00:00` | SCD2 |
| 8 | `versao` | `integer` | NN | `1` | SCD2 |
| 9 | `flag_atual` | `boolean` | NN | `true` | SCD2 |
| 10 | `data_insercao` | `timestamp` | NN | `CURRENT_TIMESTAMP` | Auditoria |
| 11 | `data_atualizacao` | `timestamp` | **NULL** | — | Auditoria |

**Constraints**: `pk_dim_loja`, `ck_dim_loja_per CHECK (data_fim > data_inicio)`,
`ex_loja_per EXCLUDE USING gist (id_loja WITH =, tsrange(data_inicio, data_fim) WITH &&)`

**Índices**: `pk_dim_loja`, `ux_loja_atual` unique `(id_loja) WHERE flag_atual`,
`ix_loja_bk (id_loja, data_inicio, data_fim)`, `ex_loja_per` gist

**Sequência**: `dim_loja_sk_loja_seq`

**Conteúdo esperado**: 3 lojas — Salvador (BA), Itabuna (BA), Feira de Santana (BA).
A loja **não existe como coluna nas fontes** — é implícita no arquivo de origem,
e o ETL precisa atribuí-la.

---

## dim_estado_civil

Dimensão estática de estado civil. **Não é SCD2** (foi rebaixada — ver
[rastros](01-modelo-dimensional.md#rastros-de-versões-anteriores-do-modelo)).
0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 2 | `id_estado_civil` | `integer` | NN | — | **PK**. Não é identity — **o ETL fornece o valor** |
| 3 | `estado_civil` | `varchar(30)` | NN | — | **UK**. Rótulo |
| 8 | `data_insercao` | `timestamp` | NN | `CURRENT_TIMESTAMP` | Auditoria |

> As posições 1, 4, 5, 6 e 7 foram removidas (eram as colunas de SCD2).

**Constraints**: `pk_dim_estado_civil PRIMARY KEY (id_estado_civil)`,
`uq_dim_estado_civil UNIQUE (estado_civil)`

**Índices**: `pk_dim_estado_civil`, `uq_dim_estado_civil`

**Conteúdo esperado**: 5 valores conformados, presentes nas três fontes —
`Casado`, `Divorciado`, `Solteiro`, `União Estável`, `Viúvo`.
Provavelmente **6**, com um membro `Não informado`: 10 clientes da Feira têm
`estado_civil` nulo, afetando 193 linhas de fato, e `fat_vendas.id_estado_civil`
é `NOT NULL`. Ver [05](05-fontes-de-dados.md#estado_civil--três-domínios-diferentes).

`varchar(30)` acomoda o maior rótulo (`União Estável`, 13 caracteres) com folga.

---

## dim_data

Dimensão de calendário. Grão **quadrimestral** — `(ano, quadrimestre)`. **6 linhas**.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `id_data` | `integer` | NN | — | **PK**. Surrogate **sequencial** (1..6) fornecido pelo ETL |
| 2 | `ano` | `smallint` | NN | — | Ano |
| 3 | `quadrimestre` | `smallint` | NN | — | **CHECK entre 1 e 3**. Quadrimestre = 4 meses |

**Constraints**: `pk_dim_data PRIMARY KEY (id_data)`,
`uq_dim_data_ano_quad UNIQUE (ano, quadrimestre)`,
`dim_data_quadrimestre_check CHECK (quadrimestre >= 1 AND quadrimestre <= 3)`

**Índices**: `pk_dim_data`, `uq_dim_data_ano_quad`

**Conteúdo**: 3 quadrimestres por ano nos anos cobertos pelas fontes
(2024 e 2025), gerados completos — os fatos têm FK obrigatória para cá.

| `id_data` | `ano` | `quadrimestre` | Meses |
|---:|---:|---:|---|
| 1 | 2024 | 1 | Jan–Abr |
| 2 | 2024 | 2 | Mai–Ago |
| 3 | 2024 | 3 | Set–Dez |
| 4 | 2025 | 1 | Jan–Abr |
| 5 | 2025 | 2 | Mai–Ago |
| 6 | 2025 | 3 | Set–Dez |

Derivação no ETL: `quadrimestre = CEIL(mes / 4)`, e `id_data` é atribuído
sequencialmente na ordem `(ano, quadrimestre)`.

> ⚠️ **`id_data` não carrega significado.** Ordenar cronologicamente exige
> `ORDER BY ano, quadrimestre` — nunca `ORDER BY id_data`. Hoje as duas ordens
> coincidem, mas isso é acidente da ordem de geração, não garantia do modelo.

> ⚠️ **Não existe data em lugar nenhum do schema `public`.** Análise mensal ou
> diária é impossível no DW. A data da venda sobrevive em `stg.cln_fat_vendas`
> e `stg.raw_venda`; o mês do concorrente, em `stg.raw_concorrente`.
> Ver [07](07-bloqueios-de-modelagem.md#3-dim_data--grão-quadrimestral).

---

## fat_vendas

Fato de vendas próprias, **agregado**: uma linha por produto x loja x
quadrimestre x estado civil. 1.382 linhas, derivadas de 6.621 itens de origem.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `id_venda` | `bigint` | NN | — | **PK**. Sem identity — o ETL fornece. **Não é o número da venda na origem**: codifica a combinação dimensional (`id_data`, `id_loja`, `id_produto`, `id_estado_civil`) |
| 2 | `sk_produto` | `bigint` | NN | — | **FK** → `dim_produto.sk_produto` |
| 4 | `sk_loja` | `bigint` | NN | — | **FK** → `dim_loja.sk_loja` |
| 5 | `id_data` | `integer` | NN | — | **FK** → `dim_data.id_data` (grão quadrimestral) |
| 6 | `quantidade` | `integer` | NN | — | **CHECK > 0**. Soma das unidades de todos os itens da combinação |
| 7 | `valor_venda` | `numeric(14,2)` | NN | — | **CHECK >= 0**. Soma do valor de todos os itens da combinação |
| 8 | `id_estado_civil` | `integer` | NN | — | **FK** → `dim_estado_civil`. Atributo demográfico degenerado |

> As posições 3 e 9 foram removidas.

**Constraints**

- `pk_fat_vendas` — `PRIMARY KEY (id_venda)`
- `fk_vendas_produto` → `dim_produto(sk_produto)`
- `fk_vendas_loja` → `dim_loja(sk_loja)`
- `fk_vendas_data` → `dim_data(id_data)`
- `fk_vendas_estcivil` → `dim_estado_civil(id_estado_civil)`
- `fat_vendas_quantidade_check` — `CHECK (quantidade > 0)`
- `fat_vendas_valor_venda_check` — `CHECK (valor_venda >= 0)`

**Índices**: `pk_fat_vendas`, `ix_vendas_data (data)`,
`ix_vendas_produto (sk_produto)`, `ix_vendas_loja (sk_loja)`,
`ix_vendas_estcivil (id_estado_civil)` — todas as 4 FKs têm índice de cobertura.

> ✅ **A PK declara o grão.** Como `id_venda` codifica a combinação das quatro
> dimensões, duas linhas do mesmo grão colidem na PK em vez de duplicar medida
> em silêncio. Foi assim que o conflito PK vs. grão foi resolvido — ver
> [07](07-bloqueios-de-modelagem.md#1-fat_vendas--pk-incompatível-com-o-grão).
>
> ⚠️ **Não conte linhas para contar vendas.** `count(*)` aqui é o número de
> combinações dimensionais, não de pedidos nem de itens. Pedidos e itens vivem
> em `stg.cln_fat_vendas`.

Todas as 4 FKs são `NOT NULL`, sem membro "desconhecido" nas dimensões. Ou seja:
**toda linha de fato exige as 4 dimensões resolvidas**, sem exceção. Não há
`ON DELETE`/`ON UPDATE` declarado (default `NO ACTION`).

---

## fat_concorrente

Fato de vendas do concorrente. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `id_concorrente` | `bigint` | NN | — | **PK**. Sem identity |
| 2 | `id_data` | `integer` | NN | — | **FK** → `dim_data.id_data` (grão quadrimestral) |
| 3 | `sk_produto` | `bigint` | NN | — | **FK** → `dim_produto.sk_produto` |
| 4 | `quantidade` | `integer` | NN | — | **CHECK >= 0** (aceita zero, ao contrário de `fat_vendas`) |
| 5 | `valor_venda` | `numeric(14,2)` | NN | — | **CHECK >= 0** |

> A posição 6 foi removida.

**Constraints**: `pk_fat_concorrente`, `fk_conc_data` → `dim_data(id_data)`,
`fk_conc_produto` → `dim_produto(sk_produto)`,
`fat_concorrente_quantidade_check CHECK (quantidade >= 0)`,
`fat_concorrente_valor_venda_check CHECK (valor_venda >= 0)`

**Índices**: `pk_fat_concorrente`, `ix_conc_data (id_data, sk_produto)`,
`ux_conc_grao UNIQUE (id_data, sk_produto)`

### Duas observações

1. **Aceita duplicatas do grão.** Não existe `UNIQUE (data, sk_produto)`. Como
   `id_concorrente` é um surrogate fornecido pelo ETL, nada impede duas linhas
   para o mesmo produto na mesma data. Se o grão pretendido é produto × data,
   falta a constraint.
2. **`fk_conc_produto` não tem índice de cobertura.** `ix_conc_data` é
   `(data, sk_produto)` — a coluna líder é `data`, então buscas e verificações
   de FK só por `sk_produto` não usam o índice. Apontado pelo linter do
   Supabase. Ver [04](04-seguranca-e-acesso.md#performance).

> ⚠️ **A fonte não tem produto nem quantidade.** Ver
> [07](07-bloqueios-de-modelagem.md#2-fat_concorrente--fonte-incompatível-com-o-modelo).

---

## Views

### vw_dim_produto_atual

```sql
SELECT sk_produto, id_produto, produto, categoria
FROM dim_produto
WHERE flag_atual;
```

Atalho para a versão corrente do produto. Omite as colunas de SCD2 e auditoria.

### vw_dim_loja_atual

```sql
SELECT sk_loja, id_loja, loja, cidade, estado
FROM dim_loja
WHERE flag_atual;
```

> ⚠️ **Ambas contornam o RLS** — não foram criadas com `security_invoker`.
> Ver [04](04-seguranca-e-acesso.md#1-as-views-contornam-o-rls-erro).
