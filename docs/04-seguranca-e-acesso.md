# 04 — Segurança e acesso

Diagnóstico histórico de segurança do modelo original. As correções locais
foram consolidadas em `sql/00_preflight.sql` e na instalação limpa
`sql/01_dw_ddl.sql`; elas ainda precisam ser verificadas pelos advisors no
projeto Supabase correto após a implantação.

## Papéis e privilégios

Todos os objetos pertencem a `postgres`. Os grants de tabela são idênticos nas
6 tabelas e nas 2 views:

```
{postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
 authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
```

Traduzindo `arwdDxtm`: **SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
TRIGGER, MAINTAIN** — privilégio total.

| Papel | Privilégio de tabela | Quem é |
|---|---|---|
| `postgres` | total | dono, superusuário do projeto |
| `service_role` | total | chave secreta (`SUPABASE_SECRET_KEY`) — **ignora RLS por design** |
| `authenticated` | **total** | qualquer usuário logado via Supabase Auth |
| `anon` | **total** | **qualquer requisição sem autenticação** |

Esse é o default do Supabase para tabelas criadas em `public`, e é por isso que
o RLS é a única coisa que separa `anon` do dado.

## Estado do RLS

| Tabela | RLS habilitado | `FORCE` RLS | Políticas |
|---|---|---|---:|
| `dim_produto` | sim | **não** | **0** |
| `dim_loja` | sim | **não** | **0** |
| `dim_estado_civil` | sim | **não** | **0** |
| `dim_data` | sim | **não** | **0** |
| `fat_vendas` | sim | **não** | **0** |
| `fat_concorrente` | sim | **não** | **0** |

RLS habilitado sem nenhuma política significa **negar tudo** para papéis
comuns. Então, hoje, `anon` e `authenticated` não leem nem escrevem nas tabelas
via API REST — apesar dos grants totais.

Isso funciona, mas é uma proteção frágil por dois motivos: foi ligada
automaticamente pelo event trigger `ensure_rls` (não por decisão de modelagem de
acesso), e o `FORCE` desligado abre o furo descrito a seguir.

---

## Achados

### 1. As views contornam o RLS (ERRO)

Severidade do linter: **ERROR** — `security_definer_view` nas duas views.

`vw_dim_produto_atual` e `vw_dim_loja_atual` foram criadas **sem
`security_invoker = true`** (verificado: `reloptions` está vazio nas duas). No
PostgreSQL, uma view sem essa opção executa com os privilégios do **dono** da
view — aqui `postgres`, que também é dono das tabelas.

E o dono de uma tabela **ignora o RLS** dela, a menos que a tabela tenha
`FORCE ROW LEVEL SECURITY` — que está **desligado** em todas as 6.

Encadeando: `anon` tem `SELECT` na view → a view roda como `postgres` →
`postgres` ignora o RLS de `dim_produto` → **`anon` lê os dados de produto e de
loja pela API REST**, mesmo com RLS habilitado e sem política nenhuma.

```
GET /rest/v1/vw_dim_produto_atual   ->  devolve dados
GET /rest/v1/dim_produto            ->  bloqueado pelo RLS
```

Hoje isso devolve zero linhas porque o banco está vazio. **Após a primeira
carga, devolve o catálogo de produtos e a lista de lojas para qualquer um com a
chave publishable.**

Correção — qualquer uma das três:

```sql
-- (a) fazer a view respeitar o RLS de quem consulta
ALTER VIEW public.vw_dim_produto_atual SET (security_invoker = true);
ALTER VIEW public.vw_dim_loja_atual    SET (security_invoker = true);

-- (b) tirar as views da API pública
REVOKE ALL ON public.vw_dim_produto_atual FROM anon, authenticated;
REVOKE ALL ON public.vw_dim_loja_atual    FROM anon, authenticated;

-- (c) fechar o furo na raiz, para todas as tabelas
ALTER TABLE public.dim_produto FORCE ROW LEVEL SECURITY;  -- etc.
```

A opção (a) é a mais alinhada com a intenção original das views. Note que com
(a) as views passam a devolver **zero linhas** enquanto não houver política —
o que é o comportamento correto, mas quebra quem já dependa delas.

### 2. Grants abertos, RLS como única barreira

Severidade do linter: **INFO** — `rls_enabled_no_policy` nas 6 tabelas.

Já descrito acima. O ponto a registrar é a ordem de dependência: as tabelas não
estão protegidas porque os privilégios foram restringidos, e sim porque **falta
política**. Se alguém criar uma política permissiva de teste
(`USING (true)`) para destravar um dashboard, os grants totais de `anon`
significam que isso libera **leitura e escrita anônimas** de uma vez.

Recomendação, dado que este é um DW analítico e não uma aplicação multiusuário:
decidir explicitamente o modelo de acesso em vez de deixá-lo implícito.

```sql
-- opção conservadora: nenhum acesso via API; consumo só por service_role/psql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- ou, se um BI/dashboard precisar de leitura autenticada:
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
    FROM anon, authenticated;
CREATE POLICY leitura_autenticada ON public.fat_vendas
    FOR SELECT TO authenticated USING (true);
```

### 3. Função SECURITY DEFINER exposta (WARN)

Severidade do linter: **WARN** — `anon_security_definer_function_executable` e
`authenticated_security_definer_function_executable`.

`public.rls_auto_enable()` é `SECURITY DEFINER` e está em `public`, portanto
exposta em `POST /rest/v1/rpc/rls_auto_enable`, chamável por `anon`.

O risco concreto é **baixo**: a função retorna `event_trigger` e chama
`pg_event_trigger_ddl_commands()`, que só é válida dentro do contexto de um
event trigger — uma chamada direta via RPC falha. O `search_path` está fixado em
`pg_catalog`, o que fecha o vetor clássico de sequestro de search_path.

Ainda assim, não há razão para ela estar exposta:

```sql
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, PUBLIC;
```

Idealmente a função viveria fora de `public` (ex.: um schema `util`), o que a
tira da API REST por completo.

### 4. btree_gist em public (WARN)

Severidade do linter: **WARN** — `extension_in_public`.

`btree_gist` está instalada em `public`, despejando ~190 funções (`gbt_*`,
`*_dist`) e 6 tipos no schema exposto pela API. Não é vulnerabilidade direta,
mas polui o namespace e amplia a superfície da API REST.

Mover é o recomendado, **mas as duas exclusion constraints dependem dela**:

```sql
-- 1. remover as constraints que dependem da extensão
ALTER TABLE public.dim_produto DROP CONSTRAINT ex_produto_per;
ALTER TABLE public.dim_loja    DROP CONSTRAINT ex_loja_per;
-- 2. mover
ALTER EXTENSION btree_gist SET SCHEMA extensions;
-- 3. recriar
ALTER TABLE public.dim_produto ADD CONSTRAINT ex_produto_per
    EXCLUDE USING gist (id_produto WITH =, tsrange(data_inicio, data_fim) WITH &&);
ALTER TABLE public.dim_loja ADD CONSTRAINT ex_loja_per
    EXCLUDE USING gist (id_loja WITH =, tsrange(data_inicio, data_fim) WITH &&);
```

**Faça isso agora, com o banco vazio.** Recriar exclusion constraint sobre
tabela populada exige varredura completa com lock exclusivo. O `search_path` do
Supabase já inclui `extensions`, então nada mais precisa mudar.

### 5. Credenciais em texto puro no disco

Não é achado do linter, é observação do repositório.

O `.mcp.json` (não versionado, corretamente coberto pelo `.gitignore`) contém o
`SUPABASE_ACCESS_TOKEN` **hardcoded em texto puro**, em vez de usar a
interpolação `${SUPABASE_ACCESS_TOKEN}` que o `.mcp.json.example` demonstra.
O `.env` também guarda a `SUPABASE_SECRET_KEY` (service_role, que ignora RLS).

Nenhum dos dois está no Git — verificado. Mas como o token já foi escrito em
claro, o mais seguro é **rotacioná-lo** no dashboard e passar a usar a
interpolação a partir do `.env`, que o `run.ps1` já carrega.

---

## Performance

O linter reporta dois tipos de achado, ambos **INFO**:

| Achado | Detalhe |
|---|---|
| `unindexed_foreign_keys` | `fk_conc_produto` em `fat_concorrente` não tem índice de cobertura. `ix_conc_data` é `(data, sk_produto)` — coluna líder errada para essa FK |
| `unused_index` (9×) | Esperado: banco com 0 linhas e nenhuma consulta. Ignorar por ora |

Correção do primeiro, se `fat_concorrente` sobreviver ao redesenho de
[07](07-bloqueios-de-modelagem.md#2-fat_concorrente--fonte-incompatível-com-o-modelo):

```sql
CREATE INDEX ix_conc_produto ON public.fat_concorrente (sk_produto);
```

---

## Acesso via MCP

A conexão MCP configurada em `.mcp.json` roda:

```
npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=<PETSHOP_SUPABASE_PROJECT_REF>
```

| Item | Valor |
|---|---|
| Papel efetivo no banco | `supabase_read_only_user` (verificado com `current_user`) |
| Modo | `--read-only` |
| O que funciona | `list_tables`, `execute_sql` de leitura, `get_advisors`, `list_extensions` |
| O que **não** funciona | `apply_migration`, DDL, INSERT/UPDATE/DELETE |

**Consequência para o ETL:** a carga de dados **não pode acontecer pelo MCP**.
Ela precisa de outro caminho — `DATABASE_URL` com psycopg/SQLAlchemy, o SQL
editor do dashboard, ou a Supabase CLI. Isso reforça a arquitetura proposta em
[06](06-ingestao-e-staging.md): o MCP serve para inspecionar e validar; a
escrita passa por um script versionado.

---

## Checklist recomendado antes da primeira carga

- [ ] Mover `btree_gist` para `extensions` (fazer agora, com tabelas vazias)
- [ ] `security_invoker = true` nas duas views, ou revogar acesso de `anon`
- [ ] Decidir o modelo de acesso: revogar grants de `anon`/`authenticated` ou criar políticas explícitas
- [ ] `REVOKE EXECUTE` em `rls_auto_enable()` de `anon`/`authenticated`
- [ ] Rotacionar o `SUPABASE_ACCESS_TOKEN` e usar interpolação no `.mcp.json`
- [ ] Versionar o DDL no repositório (ver [06](06-ingestao-e-staging.md#pendências-de-infraestrutura))
