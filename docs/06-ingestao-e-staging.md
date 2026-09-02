# 06 — Ingestão e staging

## Decisão: a área de staging é necessária

Não é uma otimização nem uma preferência de estilo. **Sem staging, o modelo
atual não recebe os dados.** Seguem os motivos, do mais bloqueante ao menos.

### 1. As chaves naturais colidem (bloqueante)

`dim_produto` tem chave natural **global**:

```sql
CREATE UNIQUE INDEX ux_produto_atual ON dim_produto (id_produto) WHERE flag_atual;
```

E `id_produto = 15` significa **três produtos diferentes** nas três fontes
(Bebedouro Automático / Escova para Pelos / Caixa de Transporte). Carregar a
segunda fonte viola o índice único. Nenhuma ordem de carga resolve.

É preciso conformar os 17 produtos num catálogo único e manter um de-para
`(fonte, id_origem) → id_conformado`. **Esse de-para não tem lugar no modelo
dimensional** — não é dimensão nem fato. Ele precisa morar em algum lugar, e
esse lugar é o staging. Ver
[05](05-fontes-de-dados.md#colisão-de-chaves-naturais-de-produto).

### 2. Os fatos precisam de SK que só existem depois das dimensões

`fat_vendas.sk_produto` e `.sk_loja` são surrogates gerados por `IDENTITY` na
dimensão. As fontes trazem o `id_produto` **delas**. Entre ler o arquivo e
inserir o fato existe obrigatoriamente um passo de lookup
`(fonte, id_origem) → id_conformado → sk_atual`. Esse passo intermediário **é**
a área de staging, chame-se como quiser.

### 3. O SCD2 é imposto pelo banco, não pelo ETL

```sql
ex_produto_per EXCLUDE USING gist (id_produto WITH =, tsrange(data_inicio, data_fim) WITH &&)
```

Inserir uma versão nova sem antes fechar a anterior é **rejeitado pelo banco**.
A carga de dimensão é obrigatoriamente dois comandos (fechar + inserir),
calculados a partir de um delta entre o que está na dimensão e o que veio da
fonte. Calcular delta exige as duas pontas materializadas em algum lugar.

### 4. Os CHECK abortam a carga inteira

`fat_vendas` tem `CHECK (quantidade > 0)`, `CHECK (valor_venda >= 0)` e **4 FKs
`NOT NULL`** sem membro "desconhecido" em nenhuma dimensão. Uma única linha
inválida derruba o `COPY`/`INSERT` completo.

Hoje as fontes estão limpas nesse aspecto (0 violações de `quantidade > 0` nas
três, 0 órfãos), então isso é sobre **robustez futura**, não sobre um problema
atual. Mas os 193 itens da Feira com `estado_civil` nulo já são um caso real de
linha que não entra sem tratamento — e sem área de quarentena o diagnóstico é
"a carga falhou", não "estas 193 linhas precisam de decisão".

### 5. Encoding e dialeto

`02_salvador_dml.sql` não é UTF-8 e usa `TO_DATE`/`SYSDATE`/`VARCHAR2` — não
executa no PostgreSQL. O arquivo precisa ser lido, transcodificado e reescrito
antes de qualquer coisa. Ver [05](05-fontes-de-dados.md#salvador--oracle).

### 6. Dados que não podem ser confiados como vêm

`valor_total` do Itabuna divergem em **500 de 500** vendas. A coluna tem que ser
descartada e o valor derivado. Decidir isso e aplicar a derivação é
transformação, e transformação precisa de destino intermediário.

### 7. O MCP é read-only de qualquer forma

A conexão MCP roda como `supabase_read_only_user` com `--read-only`. **A carga
não acontece pelo MCP.** Já existe, por força da infraestrutura, um passo
separado de escrita — então a questão não é "criar um passo a mais", é "onde
esse passo materializa o resultado".

---

## Onde rodar o staging

Duas opções viáveis. Recomendo a primeira.

### Opção A (recomendada) — schema `stg` no próprio Supabase

**A favor:** todo o ETL fica em SQL, auditável e reexecutável; o de-para vive no
banco, versionado junto com o DDL; validar a carga é uma query, não um script.
Para 6.621 linhas o custo de armazenamento e processamento é desprezível.

**Contra:** exige acesso de escrita (`DATABASE_URL` com psycopg, ou o SQL editor
do dashboard), já que o MCP é read-only.

### Opção B — processamento local, só o resultado sobe

**A favor:** o parsing do Oracle SQL, do JSON aninhado e do XLSX é mais natural
em código do que em SQL. Não precisa de escrita no Supabase até o fim.

**Contra:** o de-para e as regras de conformação ficam em código, não em dados
consultáveis — mais difícil de auditar e de justificar no trabalho.

### Recomendação híbrida

Foi implementado um híbrido auditável: Node.js sem dependências faz o parsing e
a conformação determinística, gera `raw/map/cln/rej` em SQL e registra manifesto,
hashes e decisões no banco. A publicação dimensional, o SCD2 e a reconciliação
final executam transacionalmente no PostgreSQL. Assim, as regras ficam
versionadas no repositório e cada lote continua consultável no Supabase.

---

## Schema de staging proposto

Quatro camadas, prefixadas por função:

```
stg.raw_*   -- espelho fiel da fonte. TODAS as colunas em text. ZERO constraint.
            -- Nada é interpretado aqui: se a fonte tem '15/01/2025', fica assim.
stg.map_*   -- de-para mantido à mão. É o coração da conformação.
stg.cln_*   -- tipado, conformado, validado. Pronto para UPSERT nas dims/fatos.
stg.rej_*   -- quarentena: linhas que falhariam, com o motivo.
```

### Camada raw

Uma tabela por entidade × fonte, mais uma coluna de controle:

```sql
CREATE SCHEMA IF NOT EXISTS stg;

-- exemplo: produtos de cada fonte
CREATE TABLE stg.raw_produto (
    fonte           text NOT NULL,   -- 'salvador' | 'itabuna' | 'feira'
    ordem_arquivo   int  NOT NULL,   -- posição no arquivo: reconstrói o SERIAL do Itabuna
    id_origem       text,            -- NULL no Itabuna (SERIAL implícito)
    nome            text,
    categoria       text,            -- já resolvida via categorias no Salvador
    preco           text,
    carregado_em    timestamptz NOT NULL DEFAULT now()
);
```

A coluna `ordem_arquivo` não é decorativa: o Itabuna usa `SERIAL` sem informar a
PK, então **o ID depende da ordem de inserção**. Sem preservar a ordem, os itens
de venda apontam para os produtos errados.

Tabelas equivalentes para `raw_cliente`, `raw_venda`, `raw_item_venda`,
`raw_servico`, `raw_atendimento`, `raw_concorrente`.

### Camada map

É aqui que vive a decisão humana:

```sql
-- catálogo conformado de produtos: 17 linhas, a fonte da verdade
CREATE TABLE stg.map_produto (
    id_conformado  int PRIMARY KEY,
    nome           text NOT NULL UNIQUE,
    categoria      text NOT NULL
);

-- de-para: resolve a colisão de chaves entre as fontes
CREATE TABLE stg.map_produto_origem (
    fonte          text NOT NULL,
    id_origem      int  NOT NULL,
    id_conformado  int  NOT NULL REFERENCES stg.map_produto,
    PRIMARY KEY (fonte, id_origem)
);
-- ex.: ('salvador',15,→Bebedouro), ('itabuna',15,→Escova), ('feira',15,→Caixa)
--      ('itabuna',1,→Tapete), ('itabuna',10,→Tapete)   <- dedup das duplicatas

-- de-para de estado civil: código de 1 letra -> rótulo
CREATE TABLE stg.map_estado_civil (
    valor_origem   text PRIMARY KEY,   -- 'C','D','S','U','V','Casado',...
    rotulo         text NOT NULL       -- 'Casado','Divorciado',...
);

-- lojas: não existem como coluna em nenhuma fonte
CREATE TABLE stg.map_loja (
    fonte    text PRIMARY KEY,   -- 'salvador' | 'itabuna' | 'feira'
    id_loja  int  NOT NULL,
    loja     text NOT NULL,
    cidade   text NOT NULL,
    estado   char(2) NOT NULL
);
```

`map_produto_origem` é exatamente o objeto que não existe no modelo dimensional
e sem o qual a carga é impossível.

### Camada cln e rej

`stg.cln_*` tem os mesmos tipos do destino, e é onde as validações rodam
**antes** de tocar o DW:

```sql
-- linhas que passariam
INSERT INTO stg.cln_fat_vendas (...)
SELECT ... FROM stg.raw_item_venda i
JOIN stg.map_produto_origem m ON ...
WHERE i.quantidade::int > 0 AND ...;

-- linhas que não passariam, com o motivo
INSERT INTO stg.rej_fat_vendas (fonte, id_origem, motivo, linha_original)
SELECT i.fonte, i.id_origem,
       CASE WHEN c.estado_civil IS NULL THEN 'estado_civil nulo na origem'
            WHEN i.quantidade::int <= 0 THEN 'quantidade <= 0'
            ... END,
       to_jsonb(i)
FROM stg.raw_item_venda i ... ;
```

Com isso, `SELECT motivo, count(*) FROM stg.rej_fat_vendas GROUP BY 1` responde
"o que ficou de fora e por quê" — que é a pergunta que um trabalho de ETL
precisa saber responder.

### Nota sobre RLS no schema `stg`

O event trigger `ensure_rls` tem a lista de schemas **fixa em `('public')`
— um schema `stg` novo não recebe RLS automático**. Como `stg` também não
estaria exposto no PostgREST (não está na lista de schemas expostos da API),
isso é aceitável. Mas é bom saber que a proteção não se estende sozinha; se
`stg` chegar a ser exposto, estará aberto. Ver
[03](03-objetos-do-banco.md#event-triggers).

---

## Ordem de carga

A ordem é imposta pelas FKs — nenhuma escolha aqui:

```
1. dim_data          -- gerar 3 quadrimestres por ano, 2024-2025 (6 linhas)
2. dim_estado_civil  -- 5 rótulos conformados (+ 'Não informado')
3. dim_produto       -- 17 produtos do catálogo conformado
4. dim_loja          -- 3 lojas
   ------------------ barreira: SKs precisam existir --------------------
5. fat_vendas        -- lookup (fonte, id_origem) -> id_conformado -> sk_atual
6. fat_concorrente   -- 24 meses agregados em 6 quadrimestres, ver 07
```

`dim_data` primeiro e completo: os fatos têm FK obrigatória para lá, e gerar
todos os quadrimestres dos anos cobertos é mais simples e mais robusto que
gerar só os observados.

O grão é **quadrimestral** e a PK é `id_data`, surrogate sequencial fornecido
pelo ETL — ver [07](07-bloqueios-de-modelagem.md#3-dim_data--grão-quadrimestral).
Quem gera é [`etl/conform.mjs`](../etl/conform.mjs) (`gerarCalendario`), não o
SQL, porque o `id_data` precisa ser atribuído no mesmo lugar em que os fatos o
resolvem:

```sql
INSERT INTO dim_data (id_data, ano, quadrimestre) VALUES
  (1, 2024, 1), (2, 2024, 2), (3, 2024, 3),
  (4, 2025, 1), (5, 2025, 2), (6, 2025, 3);
```

O fato guarda `id_data`; a data real da venda fica em `stg.cln_fat_vendas`,
onde ainda é necessária para o lookup temporal do SCD2.

Para a carga inicial das dimensões SCD2, `data_inicio` deve ser uma data de
corte única e explícita (ex.: `2024-01-01 00:00:00`), não `now()` — assim as
vigências cobrem todo o período dos fatos. Com `data_inicio = now()`, os fatos
de 2024 ficam fora da vigência da versão 1, o que não quebra FK (a FK é sobre
`sk`, não sobre o período) mas torna qualquer consulta point-in-time incorreta.

---

## Decisões implementadas

Decisões consolidadas no ETL local:

- [x] **Staging híbrido** — parsing/conformação em Node.js e camadas
      `raw/map/cln/rej` no schema privado `stg`.
- [x] **`valor_venda`** — total da linha (`quantidade × valor unitário`), para
      manter a medida aditiva.
- [x] **Membro `Não informado`** — criado para preservar os 193 itens da Feira.
- [x] **Categorias ausentes de Salvador** — herdadas das demais fontes.
- [x] **Duplicatas de produto no Itabuna** — os ids duplicados convergem no
      catálogo conformado para
      `Tapete Higiênico Premium` (ids 1 e 10) e `Corda Mordedor` (ids 3 e 13).
- [x] **Modelo de destino preservado** — a PK de item é codificada, e o fato
      concorrente usa membros sentinela documentados. As limitações analíticas
      permanecem registradas em [07](07-bloqueios-de-modelagem.md).

## Pendências de infraestrutura

- [x] **Versionar o DDL localmente.** O estado base está em `sql/01`, e a
      preparação idempotente do banco existente está em `sql/00_preflight.sql`.
- [ ] **Registrar no histórico remoto.** A aplicação ainda depende da conexão
      com o projeto Supabase correto; nenhum outro projeto deve ser usado.
- [x] **Adicionar `COMMENT`** nas tabelas e nas colunas ambíguas
      (`valor_venda`, `quadrimestre`, `id_produto` como chave natural global).
      O preflight deixa essas convenções explícitas no catálogo.
- [x] **Checklist de segurança local** de
      [04](04-seguranca-e-acesso.md#checklist-recomendado-antes-da-primeira-carga)
      — em especial mover `btree_gist` **enquanto as tabelas estão vazias**.
