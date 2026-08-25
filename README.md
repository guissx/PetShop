# PetShop Nosso Aumigo — Data Warehouse e ETL

Pipeline local para integrar as fontes Oracle, PostgreSQL/Supabase, MongoDB/JSON
e XLSX no modelo dimensional PostgreSQL do projeto.

## Verificar

```powershell
node --test --test-isolation=none
node etl/main.mjs --dry
```

## Gerar a carga

```powershell
node etl/main.mjs
```

São criados quatro SQLs e um `manifest.json` em `sql/generated/`. Cada execução
tem UUID próprio e registra SHA-256, tamanho e nome dos oito arquivos de origem.

## Carregar no Supabase

No painel do projeto, abra **Connect**, copie a string **Session pooler** e remova
a senha. O executor valida o `project-ref`, inspeciona as seis tabelas e pede a
senha sem exibi-la nem gravá-la. Execute primeiro apenas a conferência:

```powershell
npm run deploy -- --project-ref <PETSHOP_PROJECT_REF> --database-url "postgresql://postgres.<PETSHOP_PROJECT_REF>@<SESSION_POOLER>:5432/postgres" --check
npm run deploy -- --project-ref <PETSHOP_PROJECT_REF> --database-url "postgresql://postgres.<PETSHOP_PROJECT_REF>@<SESSION_POOLER>:5432/postgres" --yes
```

Alternativamente, copie `.env.example` para `.env` e preencha
`PETSHOP_SUPABASE_PROJECT_REF` e `DATABASE_URL`. O destino é bloqueado se o host
ou o usuário do pooler não corresponderem à referência declarada.

## Garantias

- carga transacional com validação antes do `COMMIT`;
- SCD tipo 2 para produto e loja;
- fatos ligados à versão válida da dimensão na data da venda;
- advisory locks contra cargas concorrentes;
- quarentena e auditoria por `id_carga`;
- RLS, privilégios mínimos e índices de FKs;
- reconciliação obrigatória das 6.621 linhas de item.

Detalhes: [ETL](etl/README.md) e [documentação do modelo](docs/README.md).
