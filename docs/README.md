# Documentação — Data Warehouse PetShop

Documentação do banco OLAP do projeto. Gerada por inspeção direta do banco
(`information_schema` / catálogos `pg_*`) em **2026-08-20**.

## Índice

| Documento | Conteúdo |
|---|---|
| [01-modelo-dimensional.md](01-modelo-dimensional.md) | Star schema, grão dos fatos, estratégia de SCD, diagrama ER |
| [02-dicionario-de-dados.md](02-dicionario-de-dados.md) | Tabela por tabela, coluna por coluna, tipos e regras |
| [03-objetos-do-banco.md](03-objetos-do-banco.md) | Índices, constraints, views, extensões, event trigger |
| [04-seguranca-e-acesso.md](04-seguranca-e-acesso.md) | RLS, grants, roles, achados do linter, acesso via MCP |
| [05-ingestao-e-staging.md](05-ingestao-e-staging.md) | Ordem de carga, decisão staging vs. direto, pendências |

## Resumo do estado atual

| Item | Valor |
|---|---|
| Plataforma | Supabase (PostgreSQL **17.6**) |
| Project ref | `ahoxobyduzludlgxtpsx` |
| API URL | `https://ahoxobyduzludlgxtpsx.supabase.co` |
| Schemas de aplicação | `public` (apenas) |
| Tabelas | 6 — 4 dimensões, 2 fatos |
| Views | 2 (`vw_dim_produto_atual`, `vw_dim_loja_atual`) |
| Linhas | **0 em todas as tabelas** — estrutura pronta, sem dados |
| Migrations versionadas | **nenhuma** (DDL aplicado ad-hoc, fora do controle de versão) |
| Schema de staging | **não existe** — decisão pendente, ver [05](05-ingestao-e-staging.md) |

## Pontos que exigem atenção antes da carga

1. **As duas views furam o RLS** e são legíveis pelo papel `anon`. Ver [04](04-seguranca-e-acesso.md#1-as-views-contornam-o-rls-erro).
2. **Nenhuma política RLS existe** — as tabelas estão fechadas hoje só por ausência de política, não por falta de grant. Ver [04](04-seguranca-e-acesso.md#2-grants-abertos-rls-como-única-barreira).
3. **O DDL não está no repositório.** Se o projeto Supabase for perdido, o modelo se perde. Ver [05](05-ingestao-e-staging.md#pendências).
4. **`fat_concorrente` aceita duplicatas** de `(data, sk_produto)`. Ver [02](02-dicionario-de-dados.md#fat_concorrente).
