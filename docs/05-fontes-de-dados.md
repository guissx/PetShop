# 05 — Fontes de dados

Quatro fontes heterogêneas em [`data/`](../data), em três formatos e dois
dialetos SQL. Tudo abaixo foi verificado lendo os arquivos por completo — as
contagens são exatas, não amostras.

## Panorama

| Fonte | Arquivos | Formato | Vendas | Itens | Período |
|---|---|---|---:|---:|---|
| **Salvador** | `01_salvador_ddl.sql`, `02_salvador_dml.sql` | Oracle SQL | 900 | 3.166 | 2024-01-01 → 2025-12-28 |
| **Itabuna** | `03_Itabuna_ddl.sql`, `04_itabuna_dml.sql` | PostgreSQL SQL | 500 | 1.757 | 2024-01-01 → 2025-12-28 |
| **Feira de Santana** | `05_Feira_Clientes.json`, `06_Feira_Produtos.json`, `07_Feira_pedidos.json` | JSON | 500 | 1.698 | 2024-01-07 → 2025-12-28 |
| **Concorrente** | `08_Vendas_Concorrente.xlsx` | XLSX | — | 24 | 2024-01 → 2025-12 |

**Total no grão de item: 6.621 linhas.** Volume irrelevante para performance —
as decisões de arquitetura aqui são sobre correção e auditabilidade, não escala.

Esse é o grão da **origem**, e ele sobrevive em `stg.cln_fat_vendas`.
`public.fat_vendas` agrega essas linhas no grão das próprias dimensões — 1.382
linhas, ver [07](07-bloqueios-de-modelagem.md#1-fat_vendas--pk-incompatível-com-o-grão).

Nenhuma fonte traz a **loja** como coluna. A loja é implícita no arquivo de
origem, e o ETL precisa atribuí-la ao popular `fat_vendas.sk_loja`.

---

## Salvador — Oracle

### Estrutura

```
categorias   (id_categoria PK, nome_categoria)                       8 linhas
clientes     (id_cliente PK, nome, email, telefone, sexo,
              estado_civil, data_nascimento, data_cadastro)         200 linhas
produtos     (id_produto PK, nome, preco, id_categoria FK)           17 linhas
vendas       (id_venda PK, id_cliente FK, data_venda)               900 linhas
itens_venda  (id_item PK, id_venda FK, id_produto FK,
              quantidade, valor_unitario)                         3.166 linhas
```

Única fonte com **`categorias` normalizada** em tabela própria. As outras duas
trazem categoria como texto no produto.

### Particularidades

| Item | Detalhe |
|---|---|
| **Encoding** | `02_salvador_dml.sql` **não é UTF-8** — falha no byte 8 (`0xe7`, o `ç` de `Rações` em cp1252). É a única fonte com esse problema. O DDL (`01`) é UTF-8 válido |
| **Dialeto Oracle** | `VARCHAR2`, `TO_DATE('15/01/2025','DD/MM/YYYY')`, `SYSDATE`. **Não executa no PostgreSQL** sem reescrita |
| **Sem `valor_total`** | `vendas` tem só `id_venda, id_cliente, data_venda`. O valor sai de `itens_venda` |
| **`data_cadastro DEFAULT SYSDATE`** | Todos os 200 clientes ficam com a data de execução do script — o campo não carrega informação real |
| **DDD** | `(71)` — coerente com Salvador |
| **IDs explícitos** | `INSERT INTO ... VALUES (1, ...)` — as chaves estão no arquivo, não dependem de ordem |

### Qualidade

| Verificação | Resultado |
|---|---|
| `estado_civil` | **200/200 preenchidos**, como código de 1 letra: `S` 45, `V` 45, `U` 40, `D` 36, `C` 34 |
| `sexo` | 200/200: `M` 104, `F` 96 |
| `email` | 0 nulos (padrão `cliente<N>@aumigo.com`) |
| `quantidade` | min 1, max 4 — **0 violações** de `quantidade > 0` |
| Itens órfãos (`id_venda` inexistente) | **0** |
| Itens com produto inexistente | **0** |
| Datas distintas | 473 |

> ⚠️ **5 produtos com `id_categoria` NULL** — ids 13 a 17 (`Tapete Higienico
> Premium`, `Osso Mastigavel Natural`, `Bebedouro Automatico`, `Escova para
> Pelos`, `Caixa de Transporte`). Como `dim_produto.categoria` é `NOT NULL`,
> isso precisa ser resolvido. Quatro desses cinco **têm categoria nas outras
> fontes** — o staging permite herdar em vez de marcar "Não informado".

---

## Itabuna — PostgreSQL

### Estrutura

```
clientes            (id_cliente SERIAL PK, nome, email, telefone, sexo,
                     estado_civil, data_nascimento, data_cadastro)   100 linhas
produtos            (id_produto SERIAL PK, nome, categoria, preco)    15 linhas
vendas              (id_venda SERIAL PK, id_cliente FK, data_venda,
                     valor_total)                                    500 linhas
itens_venda         (id_item SERIAL PK, id_venda FK, id_produto FK,
                     quantidade, valor_unitario)                   1.757 linhas
servicos            (id_servico SERIAL PK, descricao, valor)           7 linhas
atendimento_servico (id_atendimento SERIAL PK, id_cliente FK,
                     id_servico FK, data_atendimento, valor_cobrado)  300 linhas
```

Única fonte com **serviços**. Os 7 serviços: Banho Simples (40), Banho Premium
(60), Tosa Higiênica (55), Tosa Completa (80), Consulta Veterinária (120),
Vacinação (90), Exame Laboratorial (180).

### Particularidades

| Item | Detalhe |
|---|---|
| **Encoding** | UTF-8 válido nos dois arquivos |
| **`SERIAL` sem ID explícito** | Os `INSERT` não informam a PK — os IDs vêm da **ordem de inserção**. Reordenar o arquivo muda as chaves. O ETL tem que preservar a ordem ou reproduzir a numeração |
| **Tipos frouxos** | `sexo CHAR(20)` guardando `'Masculino'`/`'Feminino'`; `estado_civil VARCHAR(20)` guardando texto livre |
| **Categoria desnormalizada** | `produtos.categoria VARCHAR(50)`, sem tabela de categorias |
| **DDD** | `(73)` — coerente com Itabuna |

### Qualidade

| Verificação | Resultado |
|---|---|
| `estado_civil` | **100/100 preenchidos**, texto: `Solteiro` 25, `Viúvo` 21, `Casado` 16, `Divorciado` 19, `União Estável` 19 |
| `sexo` | 100/100: `Feminino` 55, `Masculino` 45 |
| `email` | **16 nulos** |
| `quantidade` | min 1, max 4 — **0 violações** |
| Itens órfãos | 0 (`id_venda` máximo referenciado = 500 = total de vendas) |
| Itens com produto inexistente | 0 (`id_produto` máximo = 15 = total de produtos) |

> ⚠️ **`valor_total` é inutilizável: 500 de 500 vendas divergem** da soma dos
> próprios itens.
>
> | `id_venda` | `valor_total` | soma dos itens |
> |---|---:|---:|
> | 1 | 34,93 | 711,76 |
> | 2 | 484,89 | 673,75 |
> | 3 | 43,95 | 1.149,66 |
>
> A coluna precisa ser **descartada** e o valor derivado de
> `quantidade × valor_unitario`.

> ⚠️ **Produtos duplicados no próprio cadastro.** 15 linhas, apenas 13 nomes
> distintos:
> - `Tapete Higienico Premium` → ids **1 e 10**
> - `Corda Mordedor` → ids **3 e 13**
>
> Com preços diferentes entre as duplicatas. Deduplicar exige decidir qual
> linha vale — e um lugar para fazer isso.

> ⚠️ **Os 300 atendimentos de serviço não têm destino no DW.** Não existe fato
> de serviços. Ou se cria um, ou 300 transações (com receita real) são
> descartadas. Ver [07](07-bloqueios-de-modelagem.md#5-serviços-sem-destino).

---

## Feira de Santana — JSON

### Estrutura

```jsonc
// 06_Feira_Produtos.json — 15 produtos
{ "id_produto": 1, "nome_produto": "Ração Premium Cães",
  "categoria": "Rações", "preco": 129.90 }

// 05_Feira_Clientes.json — 130 clientes
{ "id_cliente": 1, "nome": "João Costa", "email": null,
  "telefone": "(75)981967819", "sexo": "Feminino",
  "estado_civil": "Solteiro", "data_nascimento": "2008-01-13" }

// 07_Feira_pedidos.json — 500 pedidos, 1.698 itens ANINHADOS
{ "id_pedido": 1, "id_cliente": 3, "data_pedido": "2025-05-04",
  "itens": [
    { "id_produto": 7, "nome_produto": "Bola Borracha",
      "categoria": "Brinquedos", "preco_unitario": 19.9, "quantidade": 3 }
  ],
  "valor_total": 125.6 }
```

### Particularidades

| Item | Detalhe |
|---|---|
| **Encoding** | UTF-8 válido nos três arquivos |
| **Itens aninhados** | Os itens estão dentro do pedido — é preciso **achatar** o array para chegar ao grão de fato |
| **Redundância** | Cada item repete `nome_produto` e `categoria`, que já estão no catálogo |
| **Nomenclatura própria** | `id_pedido`/`data_pedido` (não `id_venda`/`data_venda`), `nome_produto` (não `nome`), `preco_unitario` (não `valor_unitario`) |
| **DDD** | `(75)` — coerente com Feira de Santana |

### Qualidade — é a fonte mais limpa

| Verificação | Resultado |
|---|---|
| `valor_total` vs. soma dos itens | **0 de 500 divergem** — totalmente consistente |
| `preco_unitario` vs. preço do catálogo | **0 de 1.698 divergem** — totalmente consistente |
| Pedidos com `id_cliente` inexistente | **0** |
| Itens com `id_produto` inexistente | **0** |
| `quantidade` | min 1, max 4 — **0 violações** |
| `telefone`, `sexo`, `data_nascimento` | 0 nulos |
| `email` | 17 nulos |
| Datas distintas | 341 |

> ⚠️ **10 clientes com `estado_civil` nulo.** Como `fat_vendas.id_estado_civil`
> é `NOT NULL` e não existe membro "desconhecido" em `dim_estado_civil`, isso
> propaga: **55 pedidos afetados → 193 linhas de fato** que não podem ser
> inseridas sem uma decisão. O caminho normal é criar o membro `Não informado`
> na dimensão.

Observação sobre dado sintético: `sexo` não tem correlação com o nome (o
cliente 1, `João Costa`, está marcado como `Feminino`). Irrelevante para o DW —
`sexo` é descartado, já que não existe `dim_cliente` — mas é sinal de que os
dados são gerados, e conclusões demográficas do trabalho devem ser lidas nesse
contexto.

---

## Concorrente — XLSX

**24 linhas de dados** (mais o cabeçalho), uma planilha, **três colunas**:

| Ano | Mês | Vendas (R$) |
|---|---|---:|
| 2024 | Jan | 185.000 |
| 2024 | Fev | 178.000 |
| … | … | … |
| 2024 | Dez | 345.000 |
| 2025 | Jan | 212.000 |
| … | … | … |
| 2025 | Dez | 415.000 |

Série completa: 2024 = 185, 178, 192, 205, 198, 215, 221, 228, 235, 248, 295,
345 (milhares de R$); 2025 = 212, 206, 225, 238, 231, 252, 261, 269, 281, 296,
352, 415. O padrão é claro — crescimento ano a ano e pico em novembro/dezembro.

`Mês` vem como abreviação em português (`Jan`…`Dez`), não como número.

> ⚠️ **Esta fonte é incompatível com `fat_concorrente` como a tabela está
> modelada hoje.** Não tem produto, não tem quantidade e não tem dia — as três
> coisas que a tabela exige `NOT NULL`. Ver
> [07](07-bloqueios-de-modelagem.md#2-fat_concorrente--fonte-incompatível-com-o-modelo).

---

## Colisão de chaves naturais de produto

Este é o achado mais importante do levantamento.

Cruzando os três catálogos por nome normalizado (sem acento, minúsculas), são
**17 produtos distintos** — e cada fonte usa IDs diferentes para os mesmos itens:

| Produto | Salvador | Itabuna | Feira |
|---|---:|---:|---:|
| Antipulgas | 3 | 5 | 3 |
| Bebedouro Automático | 15 | 11 | — |
| Bola Borracha | 7 | — | 7 |
| **Caixa de Transporte** | **17** | **7** | **15** |
| Cama Luxo | 11 | 4 | 11 |
| Coleira Nylon | 5 | — | 5 |
| Comedouro Inox | 12 | — | 12 |
| **Corda Mordedor** | 8 | **3 e 13** | 8 |
| Escova para Pelos | 16 | 15 | — |
| Guia Retrátil | 6 | 9 | 6 |
| Osso Mastigável Natural | 14 | 12 | 14 |
| Petisco Bifinho | 10 | 8 | 10 |
| **Ração Premium Cães** | **1** | **14** | **1** |
| Ração Premium Gatos | 2 | — | 2 |
| Shampoo Pet | 9 | 2 | 9 |
| **Tapete Higiênico Premium** | 13 | **1 e 10** | 13 |
| Vermífugo | 4 | 6 | 4 |
| **linhas na fonte** | **17** | **15** | **15** |

Leia a linha `id_produto = 15`: é **Bebedouro Automático** em Salvador,
**Escova para Pelos** em Itabuna e **Caixa de Transporte** na Feira. Três
produtos diferentes, mesma chave.

E `dim_produto` tem:

```sql
CREATE UNIQUE INDEX ux_produto_atual ON dim_produto (id_produto) WHERE flag_atual;
```

Chave natural **global**, sem coluna de fonte ou loja. Consequência direta:
**carregar a segunda fonte viola o índice único**. Não existe ordem de carga que
resolva isso — é preciso conformar os produtos num catálogo único de 17 itens e
manter um de-para `(fonte, id_origem) → id_conformado`. Esse de-para não cabe em
lugar nenhum do modelo atual, o que é a justificativa central para a área de
staging ([06](06-ingestao-e-staging.md)).

Detalhes que a tabela revela de passagem:

- **Salvador e Feira compartilham a numeração 1–12** para os mesmos produtos, e
  divergem só a partir de 13. Sugere um catálogo comum de origem que foi
  estendido de forma independente.
- **Itabuna tem numeração completamente própria**, consequência do `SERIAL`.
- **Nenhuma fonte tem os 17 produtos.** Itabuna e Feira têm 15 cada (e Itabuna
  só 13 distintos), Salvador tem 17. Salvador é a única com o catálogo completo.
- Os **preços divergem** entre fontes para o mesmo produto (`Shampoo Pet`: 34,90
  em Salvador e Feira, 43,24 em Itabuna). Como preço não é atributo de
  `dim_produto`, isso não gera conflito de SCD2 — mas confirma que os catálogos
  são independentes.

---

## `estado_civil` — três domínios diferentes

| Fonte | Tipo na origem | Valores |
|---|---|---|
| Salvador | `VARCHAR(1)` | `C` 34, `D` 36, `S` 45, `U` 40, `V` 45 |
| Itabuna | `VARCHAR(20)` | `Casado` 16, `Divorciado` 19, `Solteiro` 25, `União Estável` 19, `Viúvo` 21 |
| Feira | JSON string | `Casado` 30, `Divorciado` 23, `Solteiro` 21, `União Estável` 27, `Viúvo` 19, **`null` 10** |

O domínio conformado tem **5 valores** (mais provavelmente um sexto,
`Não informado`, para os 10 nulos da Feira). O de-para de Salvador é direto pela
inicial:

| Código | Rótulo conformado |
|---|---|
| `C` | Casado |
| `D` | Divorciado |
| `S` | Solteiro |
| `U` | União Estável |
| `V` | Viúvo |

O mapeamento é inequívoco — as 5 iniciais são distintas e cobrem exatamente os 5
rótulos textuais das outras fontes. Ainda assim é uma **interpretação**, não um
dado: nenhuma fonte documenta a legenda. Vale registrar como premissa.

## Resumo das transformações necessárias

| # | Transformação | Fonte afetada |
|---|---|---|
| 1 | Transcodificar cp1252 → UTF-8 | Salvador (`02`) |
| 2 | Traduzir dialeto Oracle (`TO_DATE`, `SYSDATE`, `VARCHAR2`) | Salvador |
| 3 | Reproduzir a numeração `SERIAL` pela ordem de inserção | Itabuna |
| 4 | Achatar `itens[]` aninhado | Feira |
| 5 | Conformar catálogo de produtos (17 itens) + de-para por fonte | todas |
| 6 | Deduplicar produtos repetidos no cadastro | Itabuna |
| 7 | Conformar `estado_civil` (código → rótulo) | Salvador |
| 8 | Criar membro `Não informado` para `estado_civil` nulo | Feira |
| 9 | Herdar categoria dos produtos sem categoria | Salvador |
| 10 | Descartar `valor_total` e derivar de `quantidade × valor_unitario` | Itabuna |
| 11 | Atribuir a loja (não existe nas fontes) | todas |
| 12 | Gerar chave de fato globalmente única (os `id_venda` colidem) | todas |
| 13 | Converter `Ano` + `Mês` abreviado para data | Concorrente |

Onde e como fazer isso: [06 — Ingestão e staging](06-ingestao-e-staging.md).
