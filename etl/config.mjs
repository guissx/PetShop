// =============================================================================
// Decisões humanas irredutíveis
// =============================================================================
// Tudo que NÃO pode ser derivado dos arquivos em ../data mora aqui, e só aqui.
// Se um valor pode sair dos dados, ele NÃO deve estar neste arquivo — deve ser
// derivado em conform.mjs.
//
// Cada entrada abaixo tem a justificativa de por que é irredutível.
// =============================================================================

export const FONTES = ['salvador', 'itabuna', 'feira'];

// -----------------------------------------------------------------------------
// Lojas
// -----------------------------------------------------------------------------
// IRREDUTÍVEL: a loja não existe como coluna em nenhuma fonte — é implícita no
// arquivo de origem. A cidade é corroborada pelo DDD dos telefones
// (71 Salvador, 73 Itabuna, 75 Feira), mas o NOME da loja não existe em lugar
// nenhum: é arbitrário. Ajuste se houver nome oficial.
export const LOJAS = {
  salvador: { id_loja: 1, loja: 'PetShop Salvador',         cidade: 'Salvador',         estado: 'BA', ddd: '71' },
  itabuna:  { id_loja: 2, loja: 'PetShop Itabuna',          cidade: 'Itabuna',          estado: 'BA', ddd: '73' },
  feira:    { id_loja: 3, loja: 'PetShop Feira de Santana', cidade: 'Feira de Santana', estado: 'BA', ddd: '75' },
};

// -----------------------------------------------------------------------------
// Legenda de estado civil
// -----------------------------------------------------------------------------
// IRREDUTÍVEL: Salvador guarda estado civil como 1 letra e NENHUMA fonte
// documenta a legenda. O mapeamento abaixo é uma interpretação — inequívoca
// (as 5 iniciais são distintas e cobrem exatamente os 5 rótulos textuais que
// Itabuna e Feira usam), mas ainda assim uma interpretação.
//
// Os rótulos canônicos vêm daqui; os valores textuais das outras fontes são
// casados contra eles por nome normalizado em conform.mjs.
export const ESTADO_CIVIL_CANONICO = [
  { id: 1, rotulo: 'Casado',        codigos: ['C'] },
  { id: 2, rotulo: 'Divorciado',    codigos: ['D'] },
  { id: 3, rotulo: 'Solteiro',      codigos: ['S'] },
  { id: 4, rotulo: 'União Estável', codigos: ['U'] },
  { id: 5, rotulo: 'Viúvo',         codigos: ['V'] },
];

// IRREDUTÍVEL: 10 clientes da Feira têm estado_civil nulo, e
// fat_vendas.id_estado_civil é NOT NULL sem membro desconhecido na dimensão.
// Sem este membro, 193 linhas de fato não podem ser carregadas.
// Alternativa seria rejeitá-las — é uma escolha, não um dado.
export const ESTADO_CIVIL_NAO_INFORMADO = { id: 9, rotulo: 'Não informado' };

// -----------------------------------------------------------------------------
// Produto sentinela
// -----------------------------------------------------------------------------
// IRREDUTÍVEL: fat_concorrente.sk_produto é NOT NULL, mas a fonte do
// concorrente é faturamento mensal agregado — não tem produto. Este membro
// representa "não aplicável", e existe só para que a FK possa ser satisfeita
// sem inventar um produto real.
//
// CONSEQUÊNCIA: fat_concorrente.quantidade fica 0 (o CHECK ali é >= 0, ao
// contrário de fat_vendas). SUM(quantidade) nessa tabela NÃO significa
// "vendeu zero unidades" — significa "não medido na origem".
export const PRODUTO_SENTINELA = {
  id_produto: 999,
  produto: 'Não aplicável',
  categoria: 'Não aplicável',
};

// -----------------------------------------------------------------------------
// Numeração canônica do catálogo de produtos
// -----------------------------------------------------------------------------
// IRREDUTÍVEL: o mesmo id_produto significa produtos diferentes em cada fonte,
// e dim_produto tem chave natural GLOBAL. Alguma numeração tem que ser eleita.
//
// 'salvador' porque é a única fonte com o catálogo completo (Salvador tem 17 de
// 17; Itabuna tem 13 distintos, Feira 15). Produtos ausentes da fonte canônica
// recebem id sequencial após o maior id dela, em ordem alfabética.
export const NUMERACAO_CANONICA = 'salvador';

// -----------------------------------------------------------------------------
// Autoridade de grafia
// -----------------------------------------------------------------------------
// SEMI-IRREDUTÍVEL: o nome do produto aparece com grafias diferentes entre
// fontes ('Racao Premium Caes' vs 'Ração Premium Cães'). A regra derivada é
// "prefira a variante com mais caracteres acentuados"; esta lista só desempata.
//
// Feira primeiro porque é a única fonte que acentua os nomes de produto.
// Produtos ausentes da Feira ficam com a grafia sem acento da origem — o script
// REPORTA quais são, em vez de inventar acentuação.
export const AUTORIDADE_GRAFIA = ['feira', 'salvador', 'itabuna'];

// -----------------------------------------------------------------------------
// Codificação da chave do item (camada stg)
// -----------------------------------------------------------------------------
// stg.cln_fat_vendas guarda o grão de ITEM — uma linha por produto dentro de um
// pedido — e precisa de chave única por linha. As três fontes numeram vendas a
// partir de 1, então o número de origem sozinho colide entre lojas.
//
//   id_item = id_loja * FATOR_LOJA + id_venda_origem * FATOR_VENDA + seq_item
//
// Formato decodificável em vez de contador opaco, para que (id_item / 100)
// reagrupe os itens do mesmo pedido original:
//   id_loja         =  id_item / FATOR_LOJA
//   id_venda_origem = (id_item % FATOR_LOJA) / FATOR_VENDA
//   seq_item        =  id_item % FATOR_VENDA
//
// Esta chave NÃO chega ao DW: public.fat_vendas é agregado (ver abaixo). Ela
// existe para dar PK ao staging e para rastrear o fato agregado até o pedido.
export const FATOR_LOJA = 1_000_000_000; // até 9.999.999 vendas por loja
export const FATOR_VENDA = 100;          // até 99 itens por venda

// -----------------------------------------------------------------------------
// Grão e codificação da chave de public.fat_vendas
// -----------------------------------------------------------------------------
// DECISÃO DE MODELAGEM: o fato é AGREGADO no grão das suas próprias dimensões —
// produto x loja x quadrimestre x estado civil. É o grão que a tabela declara
// (as quatro FKs) e o único que os indicadores do projeto pedem.
//
// Os 6.621 itens de origem viram 1.382 linhas. Nada de dinheiro nem de unidade
// se perde: `quantidade` e `valor_venda` são somados, e a conformação falha se
// os totais não fecharem. O que se perde é a identidade do pedido — contagem de
// pedidos, itens por pedido e ticket médio deixam de ser deriváveis do DW e
// passam a existir só em stg.cln_fat_vendas. Ver docs/07-bloqueios-de-modelagem.md.
//
// IRREDUTÍVEL: fat_vendas.id_venda é PK NOT NULL e o destino não muda, mas no
// grão agregado uma linha não corresponde a nenhuma venda da origem. A PK vira
// então a própria combinação dimensional, codificada:
//
//   id_venda = id_data          * FATOR_FATO.data
//            + id_loja          * FATOR_FATO.loja
//            + id_produto       * FATOR_FATO.produto
//            + id_estado_civil
//
// Decodificável de propósito, como a chave do item:
//   id_data         =  id_venda / FATOR_FATO.data
//   id_loja         = (id_venda / FATOR_FATO.loja)    % 10
//   id_produto      = (id_venda / FATOR_FATO.produto) % 1000
//   id_estado_civil =  id_venda % 1000
//
// Consequência deliberada: a PK passa a DECLARAR o grão. Duas linhas com a
// mesma combinação dimensional colidem na PK em vez de duplicar medida em
// silêncio — que é o modo de falha que uma surrogate sequencial esconderia.
export const FATOR_FATO = {
  data: 10_000_000,
  loja: 1_000_000,
  produto: 1_000,
  // id_estado_civil ocupa as três últimas casas e não tem fator próprio.
};

// Máximos observados nas fontes; o script FALHA se forem excedidos, em vez de
// gerar chave colidida em silêncio.
//
// Cada campo da chave codificada tem que caber entre o seu fator e o da casa
// imediatamente acima — daí os limites serem derivados dos fatores, e não
// digitados. `id_data` é a casa mais alta e não tem teto estrutural: o limite
// ali é o inteiro exato do JavaScript, para que a soma nunca perca precisão
// antes de virar bigint no SQL.
export const LIMITES = {
  max_itens_por_venda: FATOR_VENDA - 1,
  max_vendas_por_loja: FATOR_LOJA / FATOR_VENDA - 1,
  max_id_estado_civil: FATOR_FATO.produto - 1,               // 999
  max_id_produto: FATOR_FATO.loja / FATOR_FATO.produto - 1,  // 999
  max_id_loja: FATOR_FATO.data / FATOR_FATO.loja - 1,        // 9
  max_id_data: Math.floor(Number.MAX_SAFE_INTEGER / FATOR_FATO.data),
};

// -----------------------------------------------------------------------------
// Calendário
// -----------------------------------------------------------------------------
// dim_data tem grao QUADRIMESTRAL (3 linhas por ano, 6 no total): a regra de
// negocio pede analise por quadrimestre e/ou ano, e nenhum indicador exige dia.
// Este intervalo NAO vira linha de dimensao — ele so delimita a validacao: o
// script VERIFICA que toda data das fontes cai dentro dele antes de derivar o
// quadrimestre. Datas fora do intervalo viram rejeito, nao linha nova.
//
// CONSEQUENCIA: a data da venda nao existe em public.fat_vendas. Ela sobrevive
// em stg.cln_fat_vendas (lookup SCD2 + reconciliacao) e em stg.raw_venda.
// Analise mensal ou diaria so e possivel consultando o schema stg.
export const CALENDARIO = { inicio: '2024-01-01', fim: '2025-12-31' };

// -----------------------------------------------------------------------------
// Arquivos de origem
// -----------------------------------------------------------------------------
// `encoding` é fato verificado, não escolha: 02_salvador_dml.sql não é UTF-8
// (falha no byte 8, 0xe7 = 'ç' de 'Rações'). Todos os outros são UTF-8 válido.
export const ARQUIVOS = {
  salvador_ddl:  { arquivo: '01_salvador_ddl.sql',       encoding: 'utf-8' },
  salvador_dml:  { arquivo: '02_salvador_dml.sql',       encoding: 'windows-1252' },
  itabuna_ddl:   { arquivo: '03_Itabuna_ddl.sql',        encoding: 'utf-8' },
  itabuna_dml:   { arquivo: '04_itabuna_dml.sql',        encoding: 'utf-8' },
  feira_clientes:{ arquivo: '05_Feira_Clientes.json',    encoding: 'utf-8' },
  feira_produtos:{ arquivo: '06_Feira_Produtos.json',    encoding: 'utf-8' },
  feira_pedidos: { arquivo: '07_Feira_pedidos.json',     encoding: 'utf-8' },
  concorrente:   { arquivo: '08_Vendas_Concorrente.xlsx', encoding: null },
};

// Meses abreviados em português, como aparecem na planilha do concorrente.
export const MESES_ABREV = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// -----------------------------------------------------------------------------
// Contagens esperadas — trava de regressão
// -----------------------------------------------------------------------------
// Verificadas na leitura integral dos arquivos em 2026-08-20. Se um arquivo for
// trocado, o script acusa a divergência em vez de seguir silenciosamente.
// Ajuste conscientemente ao substituir dados.
export const ESPERADO = {
  salvador: { categorias: 8, clientes: 200, produtos: 17, vendas: 900, itens: 3166 },
  itabuna:  { clientes: 100, produtos: 15, vendas: 500, itens: 1757, servicos: 7, atendimentos: 300 },
  feira:    { clientes: 130, produtos: 15, pedidos: 500, itens: 1698 },
  concorrente: { linhas: 24 },
  produtos_distintos: 17,
  itens_total: 6621,
  // Combinações distintas de produto x loja x quadrimestre x estado civil nos
  // 6.621 itens — ou seja, o número de linhas de public.fat_vendas no grão
  // agregado. Trava de regressão para a agregação: se ela passar a somar ou a
  // perder combinação, este número muda e o script acusa.
  linhas_fat_vendas: 1382,
};
