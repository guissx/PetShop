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
// Codificação da chave de fato
// -----------------------------------------------------------------------------
// IRREDUTÍVEL: fat_vendas tem PK em id_venda mas grão de ITEM, e o destino não
// muda. Então id_venda tem que ser único por linha de item.
//
//   id_venda = id_loja * FATOR_LOJA + id_venda_origem * FATOR_VENDA + seq_item
//
// Formato decodificável em vez de contador opaco, para que (id_venda / 100)
// reagrupe os itens do mesmo pedido original:
//   id_loja         =  id_venda / FATOR_LOJA
//   id_venda_origem = (id_venda % FATOR_LOJA) / FATOR_VENDA
//   seq_item        =  id_venda % FATOR_VENDA
export const FATOR_LOJA = 1_000_000_000; // até 9.999.999 vendas por loja
export const FATOR_VENDA = 100;          // até 99 itens por venda

// Máximos observados nas fontes; o script FALHA se forem excedidos, em vez de
// gerar chave colidida em silêncio.
export const LIMITES = {
  max_itens_por_venda: FATOR_VENDA - 1,
  max_vendas_por_loja: FATOR_LOJA / FATOR_VENDA - 1,
};

// -----------------------------------------------------------------------------
// Calendário
// -----------------------------------------------------------------------------
// Gerado completo em vez de só as datas observadas: os fatos têm FK obrigatória
// para dim_data, e 731 linhas é mais simples e robusto do que ~700 distintas.
// O script VERIFICA que toda data das fontes cai dentro deste intervalo.
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
};
