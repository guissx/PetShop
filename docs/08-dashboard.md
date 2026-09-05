# Dashboard executivo

Aplicação Next.js em `apps/web`; contratos, sessão e cenários em `packages/analytics`.
O ETL continua em `etl/`, com o mesmo grão de item. O dashboard consulta somente
views `vw_bi_*` pelo servidor, via Data API Supabase. Não utiliza ORM.

## Executar

Use Node 22 (`.nvmrc`) e execute na raiz:

```sh
npm ci
npm run dev
```

Abra http://127.0.0.1:3000. Configure no `.env` da raiz:

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_SECRET_KEY` | Acesso do servidor às views; nunca `NEXT_PUBLIC_*` |
| `DEMO_USERNAME` | Usuário demonstrativo: `márcio` |
| `DEMO_PASSWORD` | Senha demonstrativa definida pelo responsável |
| `SESSION_SECRET` | Segredo aleatório com pelo menos 32 caracteres |
| `GROQ_API_KEY`, `GROQ_MODEL` | Integração opcional do assistente |

O login cria cookie assinado, HttpOnly, SameSite=Lax, Secure em produção,
com validade de oito horas. Logout remove o cookie do navegador. Não existe
cadastro; a sessão é demonstrativa, sem revogação central por dispositivo.

## Views e semântica

`sql/03_dashboard_views.sql` cria 13 views com `security_invoker=true`.
Permissões de leitura são exclusivas de `service_role`; `anon`,
`authenticated` e `PUBLIC` não recebem acesso. O servidor protege cada endpoint
com a sessão demonstrativa. A chave de servidor não é enviada ao cliente.

`quadrimestre=0` representa o ano completo; `id_loja=0` representa a rede.
Nunca somar esses registros com as linhas de quadrimestres/filiais.
Percentuais e rankings são calculados por contexto no banco. Empates usam
`dense_rank`; a interface desempata a apresentação pelo nome.

As views usam as chaves históricas das dimensões, sem filtrar `flag_atual`.
A fonte do concorrente é agregada separadamente, e sua quantidade é NULL
na view: não disponível, em vez de zero. A comparação concorrente só vale
para toda a rede. O modelo não fornece margem, lucro ou clientes únicos.

Aplicar/verificar independentemente do ETL:

```sh
npm run views:check
npm run views:apply
```

O executor usa `SUPABASE_ACCESS_TOKEN` pela Management API quando preenchido;
caso contrário usa `DATABASE_URL` com validação TLS e CA Supabase. Ambos validam
o projeto `ahoxobyduzludlgxtpsx`. O script não executa carga nem apaga fatos.
A migração é reaplicável e está em transação. Alterações incompatíveis nas
colunas das views requerem nova migração explícita.

## Interface e assistente

Visão geral, produtos/perfil, filiais e concorrência compartilham filtros na URL.
O padrão é o último ano disponível. Os gráficos temporais exibem o ano inteiro,
como indicado no subtítulo, mesmo com filtro de quadrimestre nos indicadores.
O mapa utiliza a malha geográfica do IBGE e posições das cidades, não endereços.

Fonte da geometria: https://servicodados.ibge.gov.br/api/v3/malhas/estados/29?formato=application/vnd.geo+json&qualidade=minima

O assistente só consulta funções permitidas para resumo, produtos e concorrência.
Não executa SQL nem modifica dados. Cenários exigem percentual explícito e usam
cálculo determinístico. Perguntas podem indicar ano e filial; continuações mantêm
o contexto das perguntas anteriores. A evolução compara quadrimestres nas views.

Previsões de faturamento usam os dois últimos anos completos da filial ou rede:
calculam a variação da receita anual e a aplicam a cada quadrimestre do último ano.
Anos futuros usam crescimento composto: receita do quadrimestre-base multiplicada
por `(1 + taxa anual) ^ (ano-alvo - ano-base)`. São aceitos anos isolados, listas,
intervalos e continuações como “e 2028?” ou “no ano seguinte?”, com até 20 anos
por resposta. Para anos históricos disponíveis, são apresentados valores reais.
Quanto maior o horizonte, maior a incerteza da extrapolação. Valores
são calculados no servidor, preservando a distribuição quadrimestral, e a resposta
identifica método, base e limitações. Trata-se de extrapolação exploratória, sem
intervalo de confiança ou garantia de resultado. Dados incompletos ou base zero
produzem uma explicação, sem números inventados.
Sem chave/modelo Groq, o painel funciona e o assistente permanece indisponível.
Ao configurar Groq, use o ID de um modelo da conta com suporte a tool calling.
O endpoint verifica a disponibilidade do modelo e trata limites e timeout.

## Testes

```sh
npm test
npm run test:dashboard
npm run typecheck
npm run build
# Com o servidor local em execução:
npx playwright install chromium
npm run test:e2e
npm run test:ui
```

Os testes SQL executam PostgreSQL local via PGlite com as fontes reais e a DDL
do projeto. Verificam soma de receita/unidades, contextos, participação,
concorrência, SCD histórico, base zero, produtos sem vendas e permissões.
Os testes E2E são de leitura e conferem login, filtros, mapa, cenários e mobile.
As capturas ficam em `.artifacts/`, ignorado pelo Git.

O teste de interface cobre temas claro/escuro, persistência após recarregar,
selects Radix, navegação por teclado, câmera do mapa e movimento reduzido.
O botão de tema fica no topo do painel e do login. A preferência usa o cookie
`petshop_theme`, sem relação com a sessão de autenticação. As fontes Manrope e
Source Sans 3 são servidas pela própria aplicação. Tokens e contratos visuais
estão em `apps/web/DESIGN.md` e `apps/web/UX-CONTRACT.md`.

## Vercel

Importe este repositório e configure:

- Framework: Next.js; Root Directory: `apps/web`.
- Node.js: 22.x; habilite inclusão de arquivos fora da Root Directory.
- Install Command: `npm ci` (workspace/lockfile da raiz).
- Build Command: `npm run build` (script do workspace web).
- Cadastre `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DEMO_USERNAME`,
  `DEMO_PASSWORD` e `SESSION_SECRET` nos ambientes desejados.
- Cadastre as duas variáveis Groq somente quando a integração estiver pronta.
- Não envie DATABASE_URL, token de gerenciamento ou `.env` para o cliente.

Não foi necessário criar projeto ou publicar na Vercel para validar o build.
