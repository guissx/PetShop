// =============================================================================
// Conformação — deriva o catálogo único e os de-para a partir das fontes
// =============================================================================
// Nada aqui é digitado à mão: o catálogo de produtos, o de-para por fonte e a
// herança de categoria são TODOS derivados dos arquivos. As únicas entradas
// externas são as decisões declaradas em config.mjs, que não existem nos dados.
//
// A função falha alto (throw) em vez de seguir com dado suspeito: um de-para
// incompleto produziria fato órfão, e é melhor quebrar a geração do que gerar
// SQL que quebra na carga.
// =============================================================================

import {
  LOJAS, ESTADO_CIVIL_CANONICO, ESTADO_CIVIL_NAO_INFORMADO, PRODUTO_SENTINELA,
  NUMERACAO_CANONICA, AUTORIDADE_GRAFIA, FATOR_LOJA, FATOR_VENDA, FATOR_FATO,
  LIMITES, CALENDARIO, ESPERADO, FONTES,
} from './config.mjs';

// -----------------------------------------------------------------------------
// Utilitários
// -----------------------------------------------------------------------------

/** Chave de comparação entre fontes: sem acento, minúsculo, espaços colapsados. */
export function normalizar(s) {
  if (s == null) return null;
  return String(s).normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Quantos caracteres não-ASCII a string tem — proxy para "grafia acentuada". */
function escoreAcento(s) {
  let n = 0;
  for (const ch of String(s)) if (ch.codePointAt(0) > 127) n++;
  return n;
}

/** Escolhe a melhor grafia: mais acentos vence; empate pela ordem de autoridade. */
function melhorGrafia(variantes) {
  return [...variantes].sort((a, b) => {
    const d = escoreAcento(b.texto) - escoreAcento(a.texto);
    if (d !== 0) return d;
    return AUTORIDADE_GRAFIA.indexOf(a.fonte) - AUTORIDADE_GRAFIA.indexOf(b.fonte);
  })[0];
}

/** '15/01/2025' ou '2025-01-15' -> '2025-01-15'. Devolve null se não reconhecer. */
export function paraIso(s) {
  if (s == null) return null;
  const t = String(s).trim();
  let ano, mes, dia;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) [, ano, mes, dia] = iso;
  const br = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) [, dia, mes, ano] = br;
  if (!ano) return null;

  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  if (d.getUTCFullYear() !== Number(ano) ||
      d.getUTCMonth() + 1 !== Number(mes) ||
      d.getUTCDate() !== Number(dia)) return null;
  return `${ano}-${mes}-${dia}`;
}

const doisDigitos = n => String(n).padStart(2, '0');

/** numeric(14,2) como string, sem depender de float na saída. */
function money(valor) {
  return (Math.round(valor * 100) / 100).toFixed(2);
}

// =============================================================================
// 1. Catálogo conformado de produtos + de-para
// =============================================================================
export function conformarProdutos(fontes, avisos) {
  // Agrupa por nome normalizado, atravessando as fontes.
  const grupos = new Map(); // chave -> { variantes:[], porFonte: Map<fonte, id[]> }

  for (const fonte of FONTES) {
    for (const p of fontes[fonte].produtos) {
      const chave = normalizar(p.nome);
      if (!chave) throw new Error(`produto sem nome em ${fonte} (ordem ${p.ordem})`);
      if (!grupos.has(chave)) {
        grupos.set(chave, { chave, variantes: [], categorias: [], porFonte: new Map() });
      }
      const g = grupos.get(chave);
      g.variantes.push({ fonte, texto: p.nome });
      if (p.categoria != null) g.categorias.push({ fonte, texto: p.categoria });
      if (!g.porFonte.has(fonte)) g.porFonte.set(fonte, []);
      g.porFonte.get(fonte).push(Number(p.id_origem));
    }
  }

  // Numeração canônica: quem existe na fonte canônica herda o id dela.
  const canonicos = [];
  const semCanonico = [];
  for (const g of grupos.values()) {
    const ids = g.porFonte.get(NUMERACAO_CANONICA);
    if (ids && ids.length) canonicos.push({ g, id: Math.min(...ids) });
    else semCanonico.push(g);
  }

  // Ausentes da fonte canônica recebem id após o maior dela, em ordem alfabética.
  let proximo = canonicos.length ? Math.max(...canonicos.map(c => c.id)) + 1 : 1;
  semCanonico.sort((a, b) => a.chave.localeCompare(b.chave));
  for (const g of semCanonico) {
    canonicos.push({ g, id: proximo++ });
    avisos.push(`produto ausente da fonte canônica (${NUMERACAO_CANONICA}), ` +
                `id atribuído sequencialmente: "${g.variantes[0].texto}" -> ${proximo - 1}`);
  }

  // Detecta colisão de id atribuído (não deve acontecer, mas é barato conferir).
  const vistos = new Set();
  for (const { id, g } of canonicos) {
    if (vistos.has(id)) throw new Error(`id conformado ${id} atribuído duas vezes (${g.chave})`);
    vistos.add(id);
  }

  const catalogo = [];
  const depara = [];

  for (const { g, id } of canonicos.sort((a, b) => a.id - b.id)) {
    const nome = melhorGrafia(g.variantes).texto;

    // Categoria: a mais frequente entre as fontes; empate pela autoridade.
    // Cobre o caso dos 5 produtos do Salvador com id_categoria NULL, que herdam
    // a categoria das outras fontes em vez de virar 'Não informado'.
    let categoria = null;
    let herdada = false;
    if (g.categorias.length) {
      const freq = new Map();
      for (const c of g.categorias) {
        const k = normalizar(c.texto);
        if (!freq.has(k)) freq.set(k, []);
        freq.get(k).push(c);
      }
      if (freq.size > 1) {
        avisos.push(`categoria divergente para "${nome}": ` +
          [...freq.entries()].map(([k, v]) => `${v[0].texto} (${v.map(x => x.fonte).join(',')})`).join(' vs '));
      }
      const vencedora = [...freq.values()].sort((a, b) => b.length - a.length)[0];
      categoria = melhorGrafia(vencedora).texto;

      // A fonte canônica não tinha categoria para este produto?
      const naCanonica = g.categorias.some(c => c.fonte === NUMERACAO_CANONICA);
      if (!naCanonica) herdada = true;
    }

    if (categoria == null) {
      throw new Error(
        `produto "${nome}" (id ${id}) sem categoria em nenhuma fonte. ` +
        `dim_produto.categoria é NOT NULL — decida um valor em config.mjs.`
      );
    }

    // Sinaliza produtos ausentes da fonte que acentua os nomes: são aqueles cuja
    // grafia é menos confiável. Não inventamos acento — apenas reportamos.
    const fonteAcento = AUTORIDADE_GRAFIA[0];
    const observacoes = [];
    if (herdada) observacoes.push('categoria herdada de outra fonte');
    if (!g.porFonte.has(fonteAcento)) {
      observacoes.push(`ausente em ${fonteAcento}: grafia pode estar sem acento`);
      avisos.push(`grafia não confirmada (ausente em ${fonteAcento}): "${nome}"`);
    }
    for (const [fonte, ids] of g.porFonte) {
      if (ids.length > 1) {
        observacoes.push(`duplicado em ${fonte} (ids ${ids.join(' e ')})`);
        avisos.push(`produto duplicado no cadastro de ${fonte}: "${nome}" ids ${ids.join(', ')}`);
      }
    }
    const ausentes = FONTES.filter(f => !g.porFonte.has(f));
    if (ausentes.length) observacoes.push(`ausente em ${ausentes.join(', ')}`);

    catalogo.push({ id_produto: id, produto: nome, categoria,
                    observacao: observacoes.length ? observacoes.join('; ') : null });

    for (const [fonte, ids] of g.porFonte) {
      for (const idOrigem of ids) depara.push({ fonte, id_origem: idOrigem, id_conformado: id });
    }
  }

  // O sentinela não vem de fonte nenhuma e não entra no de-para.
  catalogo.push({
    id_produto: PRODUTO_SENTINELA.id_produto,
    produto: PRODUTO_SENTINELA.produto,
    categoria: PRODUTO_SENTINELA.categoria,
    observacao: 'SENTINELA: fat_concorrente não tem produto na origem',
  });

  if (catalogo.length - 1 !== ESPERADO.produtos_distintos) {
    throw new Error(
      `esperava ${ESPERADO.produtos_distintos} produtos distintos, derivou ${catalogo.length - 1}. ` +
      `Se os dados mudaram de propósito, ajuste ESPERADO em config.mjs.`
    );
  }

  return { catalogo, depara };
}

// =============================================================================
// 2. Estado civil
// =============================================================================
export function conformarEstadoCivil(fontes, avisos) {
  const dominio = [
    ...ESTADO_CIVIL_CANONICO.map(e => ({ id: e.id, rotulo: e.rotulo })),
    { id: ESTADO_CIVIL_NAO_INFORMADO.id, rotulo: ESTADO_CIVIL_NAO_INFORMADO.rotulo },
  ];

  // Índice: código de 1 letra e rótulo normalizado apontam para o mesmo id.
  const porCodigo = new Map();
  const porRotulo = new Map();
  for (const e of ESTADO_CIVIL_CANONICO) {
    for (const c of e.codigos) porCodigo.set(c.toUpperCase(), e.id);
    porRotulo.set(normalizar(e.rotulo), e.id);
  }

  // Varre os valores realmente presentes nas fontes.
  const observados = new Map(); // valorOrigem -> { id, fontes:Set, n }
  let nulos = 0;

  for (const fonte of FONTES) {
    for (const c of fontes[fonte].clientes) {
      const bruto = c.estado_civil;
      if (bruto == null || String(bruto).trim() === '') { nulos++; continue; }
      const texto = String(bruto).trim();
      const id = texto.length === 1
        ? porCodigo.get(texto.toUpperCase())
        : porRotulo.get(normalizar(texto));
      if (id === undefined) {
        throw new Error(
          `estado civil "${texto}" (fonte ${fonte}) não tem correspondência. ` +
          `Acrescente em ESTADO_CIVIL_CANONICO no config.mjs.`
        );
      }
      if (!observados.has(texto)) observados.set(texto, { id, fontes: new Set(), n: 0 });
      const o = observados.get(texto);
      o.fontes.add(fonte);
      o.n++;
    }
  }

  const depara = [...observados.entries()]
    .map(([valor_origem, o]) => ({ valor_origem, id_conformado: o.id }))
    .sort((a, b) => a.valor_origem.localeCompare(b.valor_origem));

  if (nulos > 0) {
    depara.push({ valor_origem: '(nulo)', id_conformado: ESTADO_CIVIL_NAO_INFORMADO.id });
    avisos.push(`${nulos} cliente(s) sem estado civil -> membro "${ESTADO_CIVIL_NAO_INFORMADO.rotulo}"`);
  }

  return { dominio, depara, nulos };
}

// =============================================================================
// 3. Lojas
// =============================================================================
export function conformarLojas(fontes, avisos) {
  const lojas = FONTES.map(f => ({ fonte: f, ...LOJAS[f] }));

  // Confere o DDL declarado no config contra os telefones reais da fonte.
  // É a única evidência que os arquivos dão sobre qual cidade é qual.
  for (const l of lojas) {
    const tels = fontes[l.fonte].clientes.map(c => c.telefone).filter(Boolean);
    const fora = tels.filter(t => !String(t).startsWith(`(${l.ddd})`));
    if (tels.length && fora.length) {
      avisos.push(`${l.fonte}: ${fora.length} de ${tels.length} telefones não usam DDD ${l.ddd} ` +
                  `— confirme a cidade em config.mjs`);
    }
  }
  return lojas;
}

// =============================================================================
// 4. Fatos de venda
// =============================================================================
export function conformarVendas(fontes, deparaProduto, deparaEstadoCivil, ixCalendario, avisos) {
  const idProdutoPor = new Map(deparaProduto.map(d => [`${d.fonte}|${d.id_origem}`, d.id_conformado]));
  const idEcPor = new Map(deparaEstadoCivil.map(d => [d.valor_origem, d.id_conformado]));

  const limites = { inicio: CALENDARIO.inicio, fim: CALENDARIO.fim };
  const fatos = [];
  const rejeitos = [];
  const divergenciasValorTotal = new Map();

  for (const fonte of FONTES) {
    const src = fontes[fonte];
    const loja = LOJAS[fonte];

    const vendaPor = new Map(src.vendas.map(v => [String(v.id_origem), v]));
    const clientePor = new Map(src.clientes.map(c => [String(c.id_origem), c]));

    // Soma dos itens por venda — usada para conferir o valor_total da origem.
    const somaItens = new Map();

    for (const it of src.itens) {
      const rejeitar = motivo => rejeitos.push({
        destino: 'fat_vendas', fonte, motivo, linha: it,
      });

      const venda = vendaPor.get(String(it.id_venda));
      if (!venda) { rejeitar(`venda ${it.id_venda} inexistente na origem`); continue; }

      const idConformado = idProdutoPor.get(`${fonte}|${Number(it.id_produto)}`);
      if (idConformado === undefined) {
        rejeitar(`produto ${it.id_produto} sem de-para`); continue;
      }

      const data = paraIso(venda.data_venda);
      if (!data) { rejeitar(`data ilegível: "${venda.data_venda}"`); continue; }
      if (data < limites.inicio || data > limites.fim) {
        rejeitar(`data ${data} fora do calendário ${limites.inicio}..${limites.fim}`); continue;
      }
      // O DW e quadrimestral: a data vira id_data aqui. `data` continua no
      // staging para o lookup SCD2 e para reconciliar com a origem.
      const idData = idDataDe(ixCalendario, data);
      if (idData === undefined) {
        rejeitar(`data ${data} sem quadrimestre correspondente em dim_data`); continue;
      }

      const cliente = clientePor.get(String(venda.id_cliente));
      if (!cliente) { rejeitar(`cliente ${venda.id_cliente} inexistente na origem`); continue; }

      const ecBruto = cliente.estado_civil == null || String(cliente.estado_civil).trim() === ''
        ? '(nulo)' : String(cliente.estado_civil).trim();
      const idEc = idEcPor.get(ecBruto);
      if (idEc === undefined) { rejeitar(`estado civil "${ecBruto}" sem de-para`); continue; }

      const qtd = Number(it.quantidade);
      if (!Number.isInteger(qtd) || qtd <= 0) {
        rejeitar(`quantidade inválida: "${it.quantidade}" (fat_vendas exige > 0)`); continue;
      }
      const unit = Number(it.valor_unitario);
      if (!Number.isFinite(unit) || unit < 0) {
        rejeitar(`valor unitário inválido: "${it.valor_unitario}"`); continue;
      }

      // Chave decodificável. Ver config.mjs.
      const idVendaOrigem = Number(venda.id_origem);
      if (!Number.isInteger(idVendaOrigem) || idVendaOrigem < 1) {
        rejeitar(`id de venda não numérico: "${venda.id_origem}"`); continue;
      }
      if (idVendaOrigem > LIMITES.max_vendas_por_loja) {
        throw new Error(`id_venda ${idVendaOrigem} excede o limite ${LIMITES.max_vendas_por_loja} ` +
                        `— aumente FATOR_LOJA em config.mjs`);
      }
      if (it.seq_item > LIMITES.max_itens_por_venda) {
        throw new Error(`venda ${idVendaOrigem} de ${fonte} tem mais de ` +
                        `${LIMITES.max_itens_por_venda} itens — aumente FATOR_VENDA em config.mjs`);
      }

      const idVenda = loja.id_loja * FATOR_LOJA + idVendaOrigem * FATOR_VENDA + it.seq_item;
      const valor = qtd * unit;
      somaItens.set(String(it.id_venda), (somaItens.get(String(it.id_venda)) ?? 0) + valor);

      fatos.push({
        id_venda: idVenda,
        id_produto: idConformado,          // resolvido para sk_produto no SQL
        id_loja: loja.id_loja,             // resolvido para sk_loja no SQL
        id_data: idData,                   // FK do DW (grao quadrimestral)
        data,                              // staging: lookup SCD2 + auditoria
        quantidade: qtd,
        valor_venda: money(valor),
        id_estado_civil: idEc,
        fonte,
        id_venda_origem: idVendaOrigem,
        seq_item: it.seq_item,
        id_produto_origem: Number(it.id_produto),
      });
    }

    // Confere o valor_total da origem contra a soma dos itens, quando existe.
    // NÃO usamos valor_total para nada — isto é só diagnóstico, e é o que
    // documenta por que ele foi descartado.
    let divergentes = 0, comValor = 0;
    for (const v of src.vendas) {
      if (v.valor_total == null) continue;
      comValor++;
      const declarado = Number(v.valor_total);
      const somado = somaItens.get(String(v.id_origem)) ?? 0;
      if (Math.abs(declarado - somado) > 0.01) divergentes++;
    }
    if (comValor > 0) {
      divergenciasValorTotal.set(fonte, { divergentes, total: comValor });
      if (divergentes > 0) {
        avisos.push(`${fonte}: valor_total diverge da soma dos itens em ` +
                    `${divergentes} de ${comValor} vendas — coluna descartada, ` +
                    `valor derivado de quantidade x valor_unitario`);
      }
    }
  }

  return { fatos, rejeitos, divergenciasValorTotal };
}

// =============================================================================
// 5. Agregação do fato de venda
// =============================================================================
// O DW é AGREGADO no grão das dimensões de fat_vendas: produto x loja x
// quadrimestre x estado civil. Os 6.621 itens conformados viram 1.382 linhas.
//
// A agregação acontece AQUI, no conformador, e não no SQL de carga — mesma
// decisão já tomada para o concorrente. O SQL de carga fica sendo projeção mais
// lookup SCD2, e os dois lugares onde N linhas viram 1 — este e o concorrente —
// ficam ambos em JavaScript, cobertos por teste.
//
// stg.cln_fat_vendas continua no grão de item: é o que preserva a data da
// venda, o número do pedido e a reconciliação raw = cln + rejeitados. Quem
// precisar contar pedidos ou itens por pedido consulta o staging, não o DW.
export function agregarVendas(fatos, calendario, avisos) {
  // Primeiro dia do quadrimestre — âncora do lookup SCD2 na carga, como em
  // cln_fat_concorrente. No grão agregado não existe uma data real da venda, e
  // com dim_data quadrimestral o DW não conseguiria representar uma troca de
  // versão dentro do quadrimestre de qualquer forma.
  const dataReferenciaPor = new Map(calendario.map(d =>
    [d.id_data, `${d.ano}-${doisDigitos((d.quadrimestre - 1) * 4 + 1)}-01`]));

  // A chave codificada só é reversível se cada campo couber na sua casa.
  const excede = (campo, valor, max) => {
    if (!Number.isInteger(valor) || valor < 0 || valor > max) {
      throw new Error(`${campo} ${valor} não cabe na chave de fat_vendas ` +
                      `(máximo ${max}) — ajuste FATOR_FATO em config.mjs`);
    }
  };

  const grupos = new Map();

  for (const f of fatos) {
    excede('id_data', f.id_data, LIMITES.max_id_data);
    excede('id_loja', f.id_loja, LIMITES.max_id_loja);
    excede('id_produto', f.id_produto, LIMITES.max_id_produto);
    excede('id_estado_civil', f.id_estado_civil, LIMITES.max_id_estado_civil);

    const idVenda = f.id_data * FATOR_FATO.data
                  + f.id_loja * FATOR_FATO.loja
                  + f.id_produto * FATOR_FATO.produto
                  + f.id_estado_civil;

    // Dinheiro somado em CENTAVOS inteiros: somar 6.621 strings de duas casas
    // como float acumularia erro e a conferência de total passaria a depender
    // de tolerância.
    const centavos = Math.round(Number(f.valor_venda) * 100);

    const g = grupos.get(idVenda);
    if (g) {
      // Se a codificação estivesse errada, duas combinações distintas cairiam
      // na mesma chave e as medidas seriam somadas em silêncio.
      if (g.id_data !== f.id_data || g.id_loja !== f.id_loja
          || g.id_produto !== f.id_produto || g.id_estado_civil !== f.id_estado_civil) {
        throw new Error(`chave ${idVenda} colide entre combinações diferentes ` +
                        `— revise FATOR_FATO em config.mjs`);
      }
      g.quantidade += f.quantidade;
      g.centavos += centavos;
      g.itens_agregados++;
    } else {
      const dataReferencia = dataReferenciaPor.get(f.id_data);
      if (!dataReferencia) {
        throw new Error(`id_data ${f.id_data} sem linha no calendário`);
      }
      grupos.set(idVenda, {
        id_venda: idVenda,
        id_produto: f.id_produto,   // resolvido para sk_produto no SQL
        id_loja: f.id_loja,         // resolvido para sk_loja no SQL
        id_data: f.id_data,
        id_estado_civil: f.id_estado_civil,
        quantidade: f.quantidade,
        centavos,
        itens_agregados: 1,
        data_referencia: dataReferencia,
      });
    }
  }

  const agregados = [...grupos.values()]
    .sort((a, b) => a.id_venda - b.id_venda)
    .map(({ centavos, ...g }) => ({ ...g, valor_venda: money(centavos / 100) }));

  // A agregação é o risco novo desta etapa: unidade, dinheiro e linha não podem
  // sumir. As três conferências são exatas — inteiros dos dois lados.
  const unidadesOrigem = fatos.reduce((t, f) => t + f.quantidade, 0);
  const unidadesAgregadas = agregados.reduce((t, g) => t + g.quantidade, 0);
  if (unidadesOrigem !== unidadesAgregadas) {
    throw new Error(`agregação de vendas perdeu unidade: ${unidadesOrigem} nos itens, ` +
                    `${unidadesAgregadas} agregadas`);
  }

  const centavosOrigem = fatos.reduce((t, f) => t + Math.round(Number(f.valor_venda) * 100), 0);
  const centavosAgregados = agregados.reduce(
    (t, g) => t + Math.round(Number(g.valor_venda) * 100), 0);
  if (centavosOrigem !== centavosAgregados) {
    throw new Error(`agregação de vendas perdeu valor: ${money(centavosOrigem / 100)} nos itens, ` +
                    `${money(centavosAgregados / 100)} agregado`);
  }

  const itensContabilizados = agregados.reduce((t, g) => t + g.itens_agregados, 0);
  if (itensContabilizados !== fatos.length) {
    throw new Error(`agregação de vendas perdeu linha: ${fatos.length} itens conformados, ` +
                    `${itensContabilizados} contabilizados`);
  }

  avisos.push(`vendas: ${fatos.length} itens agregados em ${agregados.length} linhas de ` +
              `fat_vendas (produto x loja x quadrimestre x estado civil) — contagem de ` +
              `pedidos e itens por pedido só existe em stg.cln_fat_vendas`);
  return agregados;
}

// =============================================================================
// 6. Fato do concorrente
// =============================================================================
// A fonte e MENSAL (24 linhas) e o DW e QUADRIMESTRAL: a agregacao acontece
// aqui, no conformador, e nao no SQL de carga. Consequencia deliberada: a
// camada cln ja nasce com 6 linhas e o detalhe mensal existe apenas em
// stg.raw_concorrente. Ver docs/07-bloqueios-de-modelagem.md.
export function conformarConcorrente(linhas, ixCalendario, avisos) {
  const porQuadrimestre = new Map();

  for (const l of linhas) {
    const ano = Number(l.ano);
    const mes = Number(l.mes);
    const data = `${ano}-${doisDigitos(mes)}-01`;
    if (data < CALENDARIO.inicio || data > CALENDARIO.fim) {
      throw new Error(`concorrente ${ano}-${doisDigitos(mes)} fora do calendário ` +
                      `${CALENDARIO.inicio}..${CALENDARIO.fim} — ajuste CALENDARIO em config.mjs`);
    }
    const valor = Number(l.valor_venda);
    if (!Number.isFinite(valor) || valor < 0) {
      throw new Error(`valor inválido no concorrente ${ano}-${l.mes_abrev}: "${l.valor_venda}"`);
    }

    const quadrimestre = quadrimestreDe(mes);
    const idData = ixCalendario.get(`${ano}-${quadrimestre}`);
    if (idData === undefined) {
      throw new Error(`concorrente ${ano}-Q${quadrimestre} sem linha em dim_data`);
    }

    const acumulado = porQuadrimestre.get(idData);
    if (acumulado) {
      acumulado.valor_bruto += valor;
      acumulado.meses_agregados++;
    } else {
      porQuadrimestre.set(idData, {
        // 1:1 com id_data: o grao do fato E o quadrimestre, entao a PK exigida
        // pelo modelo nao carrega informacao alem da propria FK.
        id_concorrente: idData,
        id_data: idData,
        id_produto: PRODUTO_SENTINELA.id_produto,
        quantidade: 0,     // não medido na origem; o CHECK aqui é >= 0
        valor_bruto: valor,
        ano, quadrimestre,
        meses_agregados: 1,
        // Só para o lookup SCD2 no staging: primeiro dia do quadrimestre.
        data_referencia: `${ano}-${doisDigitos((quadrimestre - 1) * 4 + 1)}-01`,
      });
    }
  }

  const fatos = [...porQuadrimestre.values()]
    .sort((a, b) => a.id_data - b.id_data)
    .map(({ valor_bruto, ...f }) => ({ ...f, valor_venda: money(valor_bruto) }));

  // A agregacao e o risco novo desta etapa: dinheiro e linha nao podem sumir.
  const totalOrigem = Number(money(linhas.reduce((t, l) => t + Number(l.valor_venda), 0)));
  const totalFatos = Number(money(fatos.reduce((t, f) => t + Number(f.valor_venda), 0)));
  if (Math.abs(totalOrigem - totalFatos) > 0.01) {
    throw new Error(`agregação do concorrente perdeu valor: origem ${totalOrigem}, ` +
                    `agregado ${totalFatos}`);
  }
  const mesesAgregados = fatos.reduce((t, f) => t + f.meses_agregados, 0);
  if (mesesAgregados !== linhas.length) {
    throw new Error(`agregação do concorrente perdeu linha: ${linhas.length} meses na origem, ` +
                    `${mesesAgregados} contabilizados`);
  }

  avisos.push(`concorrente: ${linhas.length} meses agregados em ${fatos.length} quadrimestres ` +
              `com produto sentinela e quantidade 0 — SUM(quantidade) nessa tabela não tem ` +
              `significado, e o detalhe mensal só existe em stg.raw_concorrente`);
  return fatos;
}

// =============================================================================
// 7. Calendário
// =============================================================================
/** Quadrimestre de um mes 1..12: 1 = Jan-Abr, 2 = Mai-Ago, 3 = Set-Dez. */
export function quadrimestreDe(mes) {
  return Math.ceil(mes / 4);
}

/**
 * dim_data tem grao QUADRIMESTRAL: 3 linhas por ano, nao 366.
 * id_data e um surrogate sequencial (1..N) atribuido na ordem cronologica
 * (ano, quadrimestre) — nao carrega significado, e a ordenacao cronologica
 * exige ORDER BY ano, quadrimestre.
 *
 * O calendario e gerado completo (todos os quadrimestres dos anos cobertos)
 * em vez de so os observados: os fatos tem FK obrigatoria para dim_data, e
 * 6 linhas fixas sao mais simples e robustas do que as distintas observadas.
 */
export function gerarCalendario() {
  const linhas = [];
  const anoInicio = Number(CALENDARIO.inicio.slice(0, 4));
  const anoFim = Number(CALENDARIO.fim.slice(0, 4));
  let id = 0;
  for (let ano = anoInicio; ano <= anoFim; ano++) {
    for (let quadrimestre = 1; quadrimestre <= 3; quadrimestre++) {
      linhas.push({ id_data: ++id, ano, quadrimestre });
    }
  }
  return linhas;
}

/** `${ano}-${quadrimestre}` -> id_data. Resolve a FK dos dois fatos. */
export function indexarCalendario(calendario) {
  return new Map(calendario.map(l => [`${l.ano}-${l.quadrimestre}`, l.id_data]));
}

/** id_data a partir de uma data ISO 'YYYY-MM-DD'. undefined se fora do calendario. */
function idDataDe(ixCalendario, dataIso) {
  const ano = Number(dataIso.slice(0, 4));
  const mes = Number(dataIso.slice(5, 7));
  return ixCalendario.get(`${ano}-${quadrimestreDe(mes)}`);
}

// =============================================================================
// Orquestração da conformação
// =============================================================================
export function conformarTudo(fontes) {
  const avisos = [];

  conferirContagens(fontes, avisos);

  const { catalogo, depara: deparaProduto } = conformarProdutos(fontes, avisos);
  const estadoCivil = conformarEstadoCivil(fontes, avisos);
  const lojas = conformarLojas(fontes, avisos);
  const calendario = gerarCalendario();
  const ixCalendario = indexarCalendario(calendario);
  const vendas = conformarVendas(fontes, deparaProduto, estadoCivil.depara, ixCalendario, avisos);
  const fatosAgregados = agregarVendas(vendas.fatos, calendario, avisos);
  const concorrente = conformarConcorrente(fontes.concorrente, ixCalendario, avisos);

  // Reconciliação: nenhuma linha pode sumir sem motivo registrado.
  const itensOrigem = FONTES.reduce((n, f) => n + fontes[f].itens.length, 0);
  const contabilizadas = vendas.fatos.length + vendas.rejeitos.length;
  if (itensOrigem !== contabilizadas) {
    throw new Error(`reconciliação falhou: ${itensOrigem} itens na origem, ` +
                    `${vendas.fatos.length} conformados + ${vendas.rejeitos.length} rejeitados ` +
                    `= ${contabilizadas}`);
  }

  // O número de combinações é derivado dos dados, não imposto: divergir é
  // aviso, não erro. As invariantes duras da agregação (unidade, dinheiro e
  // linha) já falharam alto lá dentro se tivessem sido violadas.
  if (fatosAgregados.length !== ESPERADO.linhas_fat_vendas) {
    avisos.push(`CONTAGEM DIFERENTE: fat_vendas esperava ${ESPERADO.linhas_fat_vendas} linhas ` +
                `agregadas, derivou ${fatosAgregados.length} — se os dados mudaram de ` +
                `propósito, ajuste ESPERADO em config.mjs`);
  }

  return {
    avisos, catalogo, deparaProduto, estadoCivil, lojas, calendario,
    fatos: vendas.fatos, fatosAgregados, rejeitos: vendas.rejeitos,
    divergenciasValorTotal: vendas.divergenciasValorTotal,
    concorrente,
    resumo: {
      itensOrigem,
      fatos: vendas.fatos.length,
      fatosAgregados: fatosAgregados.length,
      rejeitos: vendas.rejeitos.length,
      produtos: catalogo.length,
      deparaProduto: deparaProduto.length,
      estadoCivil: estadoCivil.dominio.length,
      calendario: calendario.length,
      concorrente: concorrente.length,
    },
  };
}

/** Trava de regressão contra ESPERADO — acusa arquivo trocado em vez de seguir. */
function conferirContagens(fontes, avisos) {
  const checar = (rotulo, obtido, esperado) => {
    if (esperado !== undefined && obtido !== esperado) {
      avisos.push(`CONTAGEM DIFERENTE: ${rotulo} esperava ${esperado}, leu ${obtido} ` +
                  `— se os dados mudaram de propósito, ajuste ESPERADO em config.mjs`);
    }
  };
  const e = ESPERADO;
  checar('salvador.categorias', fontes.salvador.categorias.length, e.salvador.categorias);
  checar('salvador.clientes',   fontes.salvador.clientes.length,   e.salvador.clientes);
  checar('salvador.produtos',   fontes.salvador.produtos.length,   e.salvador.produtos);
  checar('salvador.vendas',     fontes.salvador.vendas.length,     e.salvador.vendas);
  checar('salvador.itens',      fontes.salvador.itens.length,      e.salvador.itens);
  checar('itabuna.clientes',    fontes.itabuna.clientes.length,    e.itabuna.clientes);
  checar('itabuna.produtos',    fontes.itabuna.produtos.length,    e.itabuna.produtos);
  checar('itabuna.vendas',      fontes.itabuna.vendas.length,      e.itabuna.vendas);
  checar('itabuna.itens',       fontes.itabuna.itens.length,       e.itabuna.itens);
  checar('itabuna.servicos',    fontes.itabuna.servicos.length,    e.itabuna.servicos);
  checar('itabuna.atendimentos',fontes.itabuna.atendimentos.length,e.itabuna.atendimentos);
  checar('feira.clientes',      fontes.feira.clientes.length,      e.feira.clientes);
  checar('feira.produtos',      fontes.feira.produtos.length,      e.feira.produtos);
  checar('feira.pedidos',       fontes.feira.vendas.length,        e.feira.pedidos);
  checar('feira.itens',         fontes.feira.itens.length,         e.feira.itens);
  checar('concorrente.linhas',  fontes.concorrente.length,         e.concorrente.linhas);
}
