# Documentação — Data Warehouse PetShop

Documentação do banco OLAP e das fontes de dados do projeto.
Gerada por inspeção direta do banco (catálogos `pg_*` / `information_schema`)
e leitura integral dos arquivos em [`data/`](../data), em **2026-08-20**.

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
| Schema de staging | **não existe** — proposta em [06](06-ingestao-e-staging.md) |
| Fontes a carregar | 4 (Salvador, Itabuna, Feira de Santana, Concorrente) |
| Volume no grão de item | **6.621 linhas** + 24 linhas de concorrente |

## Leia isto primeiro

Três coisas travam a carga hoje e **não** se resolvem no ETL — exigem mudança de DDL:

1. **`fat_vendas` tem PK em `id_venda`, mas grão de item.** As fontes têm 6.621 itens em 1.900 vendas, e `id_venda` colide entre as três lojas. Ver [07](07-bloqueios-de-modelagem.md#1-fat_vendas--pk-incompatível-com-o-grão).
2. **`fat_concorrente` não tem como receber a fonte.** O XLSX é faturamento mensal agregado, sem produto e sem quantidade — colunas que a tabela exige `NOT NULL`. Ver [07](07-bloqueios-de-modelagem.md#2-fat_concorrente--fonte-incompatível-com-o-modelo).
3. **`dim_produto` tem chave natural global**, mas o mesmo `id_produto` significa produtos diferentes em cada fonte. Ver [05](05-fontes-de-dados.md#colisão-de-chaves-naturais-de-produto).

E duas de segurança, relevantes assim que houver dado:

4. **As duas views furam o RLS** e são legíveis pelo papel `anon`. Ver [04](04-seguranca-e-acesso.md#1-as-views-contornam-o-rls-erro).
5. **Nenhuma política RLS existe.** As tabelas estão fechadas hoje por ausência de política, não por falta de grant — os grants estão totalmente abertos. Ver [04](04-seguranca-e-acesso.md#2-grants-abertos-rls-como-única-barreira).
