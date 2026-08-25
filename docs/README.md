# Documentação — Data Warehouse PetShop

Documentação do banco OLAP e das fontes de dados do projeto. Os documentos 01–05
preservam o diagnóstico estrutural inicial; o estado executável atual está nos
SQLs e no ETL versionados no repositório. Nenhum projeto Supabase remoto foi
alterado durante esta preparação.

## Índice

| Documento | Conteúdo |
|---|---|
| [01-modelo-dimensional.md](01-modelo-dimensional.md) | Star schema, grão dos fatos, estratégia de SCD, diagrama ER |
| [02-dicionario-de-dados.md](02-dicionario-de-dados.md) | Tabela por tabela, coluna por coluna, tipos e regras |
| [03-objetos-do-banco.md](03-objetos-do-banco.md) | Índices, constraints, views, extensões, event trigger |
| [04-seguranca-e-acesso.md](04-seguranca-e-acesso.md) | RLS, grants, roles, achados do linter, acesso via MCP |
| [05-fontes-de-dados.md](05-fontes-de-dados.md) | As 4 fontes: estrutura, volume, qualidade e divergências |
| [06-ingestao-e-staging.md](06-ingestao-e-staging.md) | Decisão sobre staging, schema proposto, ordem de carga |
| [07-bloqueios-de-modelagem.md](07-bloqueios-de-modelagem.md) | Incompatibilidades entre modelo e fonte que exigem decisão |

## Estado local preparado

| Item | Valor |
|---|---|
| Plataforma | Supabase (PostgreSQL **17.6**) |
| Projeto remoto | identificado; API disponível, conexão PostgreSQL aguardando liberação/string exata do Session pooler |
| Schemas de aplicação | `public` + staging privado `stg` |
| Tabelas | 6 — 4 dimensões, 2 fatos |
| Views | 2 (`vw_dim_produto_atual`, `vw_dim_loja_atual`) |
| Artefatos locais | preflight, staging, ETL SCD2, testes e executor `etl/deploy.mjs` |
| Histórico remoto | pendente de aplicação no projeto correto |
| Schema de staging | implementado em [`sql/02_stg_ddl.sql`](../sql/02_stg_ddl.sql) |
| Fontes a carregar | 4 (Salvador, Itabuna, Feira de Santana, Concorrente) |
| Volume no grão de item | **6.621 linhas** + 24 linhas de concorrente |

## Decisões aplicadas

Os bloqueios do diagnóstico foram tratados sem mudar o conjunto de colunas do
OLAP informado:

1. **`fat_vendas.id_venda`** recebe uma chave determinística por loja, pedido e
   sequência do item, preservando as 6.621 linhas.
2. **Concorrente** usa produto sentinela e quantidade zero documentada como
   “não medido”; somente a comparação de valores é válida.
3. **Produtos** passam por catálogo conformado e de-para por fonte.
4. **Produto e loja** usam SCD2 com lookup temporal na carga dos fatos.
5. **Segurança** é aplicada por `00_preflight.sql`: RLS, índices de FK,
   `security_invoker` na instalação limpa e ausência de função privilegiada em
   `public`.

As alternativas ideais de remodelagem continuam discutidas em
[07-bloqueios-de-modelagem.md](07-bloqueios-de-modelagem.md), mas não são
pré-requisito para executar o ETL atual.
