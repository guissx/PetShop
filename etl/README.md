# ETL — fontes → staging → DW

Lê os 8 arquivos de [`../data`](../data), deriva o catálogo conformado e **gera
SQL** em `../sql/generated/`. A gravação no Supabase é feita separadamente por
[`deploy.mjs`](deploy.mjs), com uma trava para o projeto correto.

## Rodar

```bash
node etl/main.mjs          # gera os SQL e imprime o relatório
node etl/main.mjs --dry    # só o relatório, não escreve arquivo
node --test --test-isolation=none
```

**Zero dependências** — só a stdlib do Node (testado no v24). Não precisa de
`npm install`. O `.xlsx` é lido com `zlib` + parser de ZIP próprio
([`lib/zip.mjs`](lib/zip.mjs)) em vez de uma biblioteca externa.

Depois, no banco:

```
sql/00_preflight.sql           # corrige/valida o OLAP informado
sql/02_stg_ddl.sql             # cria o schema stg
sql/generated/10_stg_raw.sql
sql/generated/20_stg_map.sql
sql/generated/30_stg_cln.sql
sql/generated/40_load_dw.sql
```

Ou execute toda a sequência com `npm run deploy -- --project-ref <REF>
--database-url "<SESSION_POOLER_SEM_SENHA>" --yes`. O script confere rigorosamente
o host e o usuário da conexão, pede a senha sem gravá-la e interrompe no primeiro
erro SQL.

Cada geração também cria `manifest.json`, contendo `id_carga`, data efetiva,
hash SHA-256 e tamanho de cada fonte.

## Arquitetura

```
config.mjs      decisões humanas irredutíveis — e SÓ elas
lib/zip.mjs     leitor de ZIP/XLSX (stdlib)
lib/sqlparse.mjs parser de INSERT (Oracle + PostgreSQL)
extract.mjs     8 arquivos -> registros. Desfaz FORMATO, não semântica
conform.mjs     deriva catálogo, de-para, fatos. Valida e falha alto
emit.mjs        registros -> SQL
main.mjs        orquestra e relata
```

### A regra que separa `config.mjs` do resto

Se um valor **pode** ser derivado dos arquivos, ele **não** pode estar no
config — tem que ser derivado em `conform.mjs`. O config guarda só o que não
existe em lugar nenhum nos dados:

| Decisão | Por que é irredutível |
|---|---|
| Nome das lojas | A loja não é coluna em nenhuma fonte; o nome não existe nos dados |
| Legenda `C`/`D`/`S`/`U`/`V` | Nenhuma fonte documenta o que as letras significam |
| Membro `Não informado` | 10 clientes sem estado civil + coluna `NOT NULL` no destino: é escolha, não dado |
| Produto sentinela | `fat_concorrente.sk_produto` é `NOT NULL` e a fonte não tem produto |
| Numeração canônica | Os ids colidem; alguma fonte tem que ser eleita |
| Fatores da chave de fato | Convenção de codificação |

Tudo o mais — os 17 produtos, os 47 mapeamentos de de-para, a categoria herdada
pelos 5 produtos que o Salvador tem sem categoria, a grafia escolhida de cada
nome — sai dos arquivos.

## O que o script decide sozinho

**Catálogo de produtos.** Agrupa por nome normalizado (sem acento, minúsculo) e
funde as três fontes. Ids vêm do Salvador, que é a única fonte com o catálogo
completo; produtos ausentes dele recebem id sequencial e o script avisa.

**Grafia do nome.** Escolhe a variante com mais caracteres acentuados
(`Ração Premium Cães` do Feira vence `Racao Premium Caes` do Salvador). Não
inventa acento: produtos ausentes do Feira ficam com a grafia sem acento da
origem, e o script **reporta quais são** para você conferir.

**Categoria.** A mais frequente entre as fontes. É assim que os 5 produtos que
o Salvador tem com `id_categoria NULL` herdam a categoria de Itabuna/Feira em
vez de virar "Não informado". Divergência entre fontes vira aviso.

**Deduplicação.** O Itabuna tem produto repetido no cadastro; os dois ids
apontam para o mesmo `id_conformado`, o que deduplica na carga.

**Chave de fato.** `fat_vendas` tem PK em `id_venda` mas grão de item, e o
destino não muda. O script gera:

```
id_venda = id_loja * 1000000000 + id_venda_origem * 100 + seq_item
```

Decodificável de propósito: `id_venda / 100` reagrupa os itens do mesmo pedido
original e `id_venda / 1000000000` devolve a loja. O script **falha** se algum
id exceder os fatores, em vez de gerar chave colidida em silêncio.

## Como o script falha

Quebra (exit 1) em vez de gerar SQL ruim quando:

- um valor de estado civil não tem correspondência no config
- um produto não tem categoria em fonte nenhuma
- um id de venda ou contagem de itens excede os fatores da chave
- a reconciliação não fecha (`itens da origem ≠ conformados + rejeitados`)
- o número de produtos distintos derivado difere de `ESPERADO`

Avisa (mas segue) quando: contagem de arquivo diverge do esperado, categoria
diverge entre fontes, grafia não pôde ser confirmada, produto duplicado,
telefone com DDD inesperado, `valor_total` divergente.

Linhas individuais que não podem virar fato vão para `stg.rej_carga`, ligadas ao
`id_carga`, com o motivo. `40_load_dw.sql` valida **antes do COMMIT** e qualquer
divergência desfaz fatos e dimensões no mesmo rollback.

## Reprocessamento e SCD2

Produto e loja são SCD tipo 2. Uma mudança fecha a versão corrente na data
efetiva do lote e abre `versao + 1`; remoções fecham a versão sem criar outra.
Os fatos procuram a SK cuja vigência contém a data da venda, preservando o
histórico. Reexecutar o mesmo lote não cria versões adicionais.

As tabelas de fato são snapshots completos: são truncadas e recarregadas dentro
da mesma transação. Isso é deliberado para as fontes atuais, que são arquivos
completos e pequenos. Para fontes futuras incrementais, a estratégia deve mudar
para watermark/upsert por partição.

## Limite conhecido da fonte concorrente

O XLSX concorrente não contém produto nem quantidade. O membro `Não aplicável`
e a quantidade `0` representam **não medido**, não zero unidades. Portanto só a
comparação de valor entre empresa e concorrente é válida com os dados fornecidos.

## Regenerar

Os arquivos em `sql/generated/` são descartáveis: apague e rode de novo. Não os
edite à mão — edite `config.mjs` ou `conform.mjs`.
