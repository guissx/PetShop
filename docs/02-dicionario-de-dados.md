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

Dimensão de calendário. Grão **diário**, mas com apenas dois atributos. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `data` | `date` | NN | — | **PK**. É a própria chave — não há surrogate |
| 2 | `ano` | `smallint` | NN | — | Ano |
| 4 | `quadrimestre` | `smallint` | NN | — | **CHECK entre 1 e 3**. Quadrimestre = 4 meses |

> A posição 3 foi removida — era provavelmente `mes` ou `trimestre`.

**Constraints**: `pk_dim_data PRIMARY KEY (data)`,
`dim_data_quadrimestre_check CHECK (quadrimestre >= 1 AND quadrimestre <= 3)`

**Índices**: `pk_dim_data`

**Conteúdo esperado**: as fontes cobrem **2024-01-01 a 2025-12-28**. O mais
simples é gerar o calendário completo `2024-01-01 .. 2025-12-31` (731 linhas),
já que os fatos têm FK obrigatória para cá.

Mapeamento de quadrimestre: `1` = Jan–Abr, `2` = Mai–Ago, `3` = Set–Dez
(`quadrimestre = CEIL(EXTRACT(MONTH FROM data) / 4.0)`).

> ⚠️ **Não há coluna de mês.** Análise mensal é impossível, e a fonte do
> concorrente é mensal. Ver [07](07-bloqueios-de-modelagem.md#3-dim_data--sem-mês).

---

## fat_vendas

Fato de vendas próprias. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `id_venda` | `bigint` | NN | — | **PK**. Sem identity — o ETL fornece |
| 2 | `sk_produto` | `bigint` | NN | — | **FK** → `dim_produto.sk_produto` |
| 4 | `sk_loja` | `bigint` | NN | — | **FK** → `dim_loja.sk_loja` |
| 5 | `data` | `date` | NN | — | **FK** → `dim_data.data` |
| 6 | `quantidade` | `integer` | NN | — | **CHECK > 0** (estritamente positivo) |
| 7 | `valor_venda` | `numeric(14,2)` | NN | — | **CHECK >= 0** |
| 8 | `id_estado_civil` | `integer` | NN | — | **FK** → `dim_estado_civil`. Atributo demográfico degenerado |

> As posições 3 e 9 foram removidas.

**Constraints**

- `pk_fat_vendas` — `PRIMARY KEY (id_venda)`
- `fk_vendas_produto` → `dim_produto(sk_produto)`
- `fk_vendas_loja` → `dim_loja(sk_loja)`
- `fk_vendas_data` → `dim_data(data)`
- `fk_vendas_estcivil` → `dim_estado_civil(id_estado_civil)`
- `fat_vendas_quantidade_check` — `CHECK (quantidade > 0)`
- `fat_vendas_valor_venda_check` — `CHECK (valor_venda >= 0)`

**Índices**: `pk_fat_vendas`, `ix_vendas_data (data)`,
`ix_vendas_produto (sk_produto)`, `ix_vendas_loja (sk_loja)`,
`ix_vendas_estcivil (id_estado_civil)` — todas as 4 FKs têm índice de cobertura.

> ⚠️ **A PK é incompatível com o grão.** Ver
> [07](07-bloqueios-de-modelagem.md#1-fat_vendas--pk-incompatível-com-o-grão).

Todas as 4 FKs são `NOT NULL`, sem membro "desconhecido" nas dimensões. Ou seja:
**toda linha de fato exige as 4 dimensões resolvidas**, sem exceção. Não há
`ON DELETE`/`ON UPDATE` declarado (default `NO ACTION`).

---

## fat_concorrente

Fato de vendas do concorrente. 0 linhas.

| # | Coluna | Tipo | Nulo | Default | Notas |
|---|---|---|---|---|---|
| 1 | `id_concorrente` | `bigint` | NN | — | **PK**. Sem identity |
| 2 | `data` | `date` | NN | — | **FK** → `dim_data.data` |
| 3 | `sk_produto` | `bigint` | NN | — | **FK** → `dim_produto.sk_produto` |
| 4 | `quantidade` | `integer` | NN | — | **CHECK >= 0** (aceita zero, ao contrário de `fat_vendas`) |
| 5 | `valor_venda` | `numeric(14,2)` | NN | — | **CHECK >= 0** |

> A posição 6 foi removida.

**Constraints**: `pk_fat_concorrente`, `fk_conc_data` → `dim_data(data)`,
`fk_conc_produto` → `dim_produto(sk_produto)`,
`fat_concorrente_quantidade_check CHECK (quantidade >= 0)`,
`fat_concorrente_valor_venda_check CHECK (valor_venda >= 0)`

**Índices**: `pk_fat_concorrente`, `ix_conc_data (data, sk_produto)`

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
