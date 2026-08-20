// =============================================================================
// Extração — os 8 arquivos de ../data para registros em memória
// =============================================================================
// Esta camada NÃO conforma nada entre fontes. Ela só desfaz o formato de
// arquivo: SQL, JSON e XLSX viram a mesma forma de registro.
//
// A única normalização feita aqui é DENTRO de uma fonte: o Salvador tem
// `categorias` em tabela própria, então o join produtos->categorias acontece
// aqui para que o registro de produto das três fontes tenha a mesma forma
// (nome + categoria). Nada é comparado entre fontes.
//
// Datas saem como vieram: '15/01/2025' do Salvador continua em DD/MM/YYYY.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARQUIVOS, MESES_ABREV } from './config.mjs';
import { extrairInserts, comoRegistros, colunasDoCreateTable } from './lib/sqlparse.mjs';
import { lerXlsx } from './lib/zip.mjs';

/** Lê um arquivo com o encoding declarado em config (fato verificado). */
function ler(dirDados, chave) {
  const { arquivo, encoding } = ARQUIVOS[chave];
  const caminho = join(dirDados, arquivo);
  const bytes = readFileSync(caminho);
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

/** Numera os itens dentro de cada venda, na ordem em que aparecem no arquivo. */
function numerarItens(itens, chaveVenda) {
  const contador = new Map();
  return itens.map(it => {
    const k = String(it[chaveVenda]);
    const seq = (contador.get(k) ?? 0) + 1;
    contador.set(k, seq);
    return { ...it, seq_item: seq };
  });
}

// -----------------------------------------------------------------------------
// Salvador — Oracle, windows-1252
// -----------------------------------------------------------------------------
export function extrairSalvador(dirDados) {
  const ddl = ler(dirDados, 'salvador_ddl');
  const dml = ler(dirDados, 'salvador_dml');
  const inserts = extrairInserts(dml);

  // Os INSERTs do Salvador não têm lista de colunas, então a ordem dos valores
  // vem do CREATE TABLE — lida do DDL, não suposta.
  const cols = t => {
    const c = colunasDoCreateTable(ddl, t);
    if (!c) throw new Error(`CREATE TABLE ${t} não encontrado no DDL do Salvador`);
    return c;
  };

  const categorias = comoRegistros(inserts, 'categorias', cols('categorias'))
    .map(r => ({
      fonte: 'salvador', ordem: r.__ordem,
      id_origem: r.id_categoria, nome: r.nome_categoria,
    }));

  const porId = new Map(categorias.map(c => [String(c.id_origem), c.nome]));

  const produtos = comoRegistros(inserts, 'produtos', cols('produtos'))
    .map(r => ({
      fonte: 'salvador', ordem: r.__ordem,
      id_origem: r.id_produto,
      nome: r.nome,
      // Join dentro da própria fonte. id_categoria NULL fica null e é tratado
      // na conformação (herda das outras fontes), não aqui.
      categoria: r.id_categoria == null ? null : (porId.get(String(r.id_categoria)) ?? null),
      preco: r.preco,
    }));

  const clientes = comoRegistros(inserts, 'clientes', cols('clientes'))
    .map(r => ({
      fonte: 'salvador', ordem: r.__ordem,
      id_origem: r.id_cliente, nome: r.nome, email: r.email, telefone: r.telefone,
      sexo: r.sexo, estado_civil: r.estado_civil,
      data_nascimento: r.data_nascimento, data_cadastro: r.data_cadastro,
    }));

  const vendas = comoRegistros(inserts, 'vendas', cols('vendas'))
    .map(r => ({
      fonte: 'salvador', ordem: r.__ordem,
      id_origem: r.id_venda, id_cliente: r.id_cliente,
      data_venda: r.data_venda,
      valor_total: null,   // a tabela do Salvador não tem valor_total
    }));

  const itens = numerarItens(
    comoRegistros(inserts, 'itens_venda', cols('itens_venda'))
      .map(r => ({
        fonte: 'salvador', ordem: r.__ordem,
        id_origem: r.id_item, id_venda: r.id_venda, id_produto: r.id_produto,
        quantidade: r.quantidade, valor_unitario: r.valor_unitario,
      })),
    'id_venda'
  );

  return { fonte: 'salvador', categorias, produtos, clientes, vendas, itens,
           servicos: [], atendimentos: [] };
}

// -----------------------------------------------------------------------------
// Itabuna — PostgreSQL, UTF-8
// -----------------------------------------------------------------------------
// Atenção: as tabelas usam SERIAL e os INSERTs não informam a PK. O id de cada
// entidade É a posição no arquivo. Reordenar o arquivo mudaria as chaves e
// faria os itens apontarem para os produtos errados.
export function extrairItabuna(dirDados) {
  const dml = ler(dirDados, 'itabuna_dml');
  const inserts = extrairInserts(dml);

  const produtos = comoRegistros(inserts, 'produtos')
    .map(r => ({
      fonte: 'itabuna', ordem: r.__ordem,
      id_origem: String(r.__ordem),   // SERIAL = ordem de inserção
      nome: r.nome, categoria: r.categoria, preco: r.preco,
    }));

  const clientes = comoRegistros(inserts, 'clientes')
    .map(r => ({
      fonte: 'itabuna', ordem: r.__ordem,
      id_origem: String(r.__ordem),
      nome: r.nome, email: r.email, telefone: r.telefone,
      sexo: r.sexo, estado_civil: r.estado_civil,
      data_nascimento: r.data_nascimento, data_cadastro: null,
    }));

  const vendas = comoRegistros(inserts, 'vendas')
    .map(r => ({
      fonte: 'itabuna', ordem: r.__ordem,
      id_origem: String(r.__ordem),
      id_cliente: r.id_cliente, data_venda: r.data_venda,
      // Mantido no raw de propósito: é o registro de que a coluna existe e
      // divergia. A conformação NÃO usa este valor.
      valor_total: r.valor_total,
    }));

  const itens = numerarItens(
    comoRegistros(inserts, 'itens_venda')
      .map(r => ({
        fonte: 'itabuna', ordem: r.__ordem,
        id_origem: String(r.__ordem),
        id_venda: r.id_venda, id_produto: r.id_produto,
        quantidade: r.quantidade, valor_unitario: r.valor_unitario,
      })),
    'id_venda'
  );

  const servicos = comoRegistros(inserts, 'servicos')
    .map(r => ({
      fonte: 'itabuna', ordem: r.__ordem,
      id_origem: String(r.__ordem), descricao: r.descricao, valor: r.valor,
    }));

  const atendimentos = comoRegistros(inserts, 'atendimento_servico')
    .map(r => ({
      fonte: 'itabuna', ordem: r.__ordem,
      id_origem: String(r.__ordem),
      id_cliente: r.id_cliente, id_servico: r.id_servico,
      data_atendimento: r.data_atendimento, valor_cobrado: r.valor_cobrado,
    }));

  return { fonte: 'itabuna', categorias: [], produtos, clientes, vendas, itens,
           servicos, atendimentos };
}

// -----------------------------------------------------------------------------
// Feira de Santana — JSON
// -----------------------------------------------------------------------------
// Os itens vêm aninhados dentro do pedido e precisam ser achatados. Cada item
// repete nome_produto/categoria, que já estão no catálogo — a redundância é
// ignorada aqui e conferida em conform.mjs.
export function extrairFeira(dirDados) {
  const jProdutos = JSON.parse(ler(dirDados, 'feira_produtos'));
  const jClientes = JSON.parse(ler(dirDados, 'feira_clientes'));
  const jPedidos  = JSON.parse(ler(dirDados, 'feira_pedidos'));

  const txt = v => (v === null || v === undefined ? null : String(v));

  const produtos = jProdutos.map((p, i) => ({
    fonte: 'feira', ordem: i + 1,
    id_origem: txt(p.id_produto), nome: p.nome_produto,
    categoria: p.categoria, preco: txt(p.preco),
  }));

  const clientes = jClientes.map((c, i) => ({
    fonte: 'feira', ordem: i + 1,
    id_origem: txt(c.id_cliente), nome: c.nome, email: c.email, telefone: c.telefone,
    sexo: c.sexo, estado_civil: c.estado_civil,
    data_nascimento: c.data_nascimento, data_cadastro: null,
  }));

  const vendas = jPedidos.map((p, i) => ({
    fonte: 'feira', ordem: i + 1,
    id_origem: txt(p.id_pedido), id_cliente: txt(p.id_cliente),
    data_venda: p.data_pedido, valor_total: txt(p.valor_total),
  }));

  const itens = [];
  let n = 0;
  for (const p of jPedidos) {
    (p.itens ?? []).forEach((it, k) => {
      itens.push({
        fonte: 'feira', ordem: ++n,
        id_origem: null,             // itens aninhados não têm id próprio
        id_venda: txt(p.id_pedido),
        seq_item: k + 1,             // posição dentro do pedido
        id_produto: txt(it.id_produto),
        quantidade: txt(it.quantidade),
        valor_unitario: txt(it.preco_unitario),
        // guardados só para a conferência de consistência
        _nome_produto: it.nome_produto,
        _categoria: it.categoria,
      });
    });
  }

  return { fonte: 'feira', categorias: [], produtos, clientes, vendas, itens,
           servicos: [], atendimentos: [] };
}

// -----------------------------------------------------------------------------
// Concorrente — XLSX
// -----------------------------------------------------------------------------
// Três colunas: Ano, Mês (abreviado em português), Vendas (R$).
export function extrairConcorrente(dirDados) {
  const { arquivo } = ARQUIVOS.concorrente;
  const linhas = lerXlsx(join(dirDados, arquivo));
  if (linhas.length === 0) throw new Error('planilha do concorrente vazia');

  const cabecalho = linhas[0].map(c => (c ?? '').trim());
  const iAno   = cabecalho.findIndex(c => /^ano$/i.test(c));
  const iMes   = cabecalho.findIndex(c => /^m[êe]s$/i.test(c));
  const iValor = cabecalho.findIndex(c => /vendas/i.test(c));
  if (iAno < 0 || iMes < 0 || iValor < 0) {
    throw new Error(`cabeçalho inesperado no concorrente: ${JSON.stringify(cabecalho)}`);
  }

  return linhas.slice(1)
    .filter(l => l[iAno] != null && l[iMes] != null)
    .map((l, i) => {
      const abrev = String(l[iMes]).trim();
      const mes = MESES_ABREV.findIndex(m => m.toLowerCase() === abrev.toLowerCase()) + 1;
      if (mes === 0) throw new Error(`mês não reconhecido no concorrente: "${abrev}"`);
      return {
        fonte: 'concorrente', ordem: i + 1,
        ano: String(l[iAno]).trim(),
        mes_abrev: abrev,
        mes,
        valor_venda: String(l[iValor]).trim(),
      };
    });
}

// -----------------------------------------------------------------------------
export function extrairTudo(dirDados) {
  return {
    salvador: extrairSalvador(dirDados),
    itabuna: extrairItabuna(dirDados),
    feira: extrairFeira(dirDados),
    concorrente: extrairConcorrente(dirDados),
  };
}
