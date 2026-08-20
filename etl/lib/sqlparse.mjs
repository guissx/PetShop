// =============================================================================
// Parser de INSERT — cobre o dialeto Oracle (Salvador) e o PostgreSQL (Itabuna)
// =============================================================================
// Não é um parser de SQL completo: é um extrator de INSERTs, que é o que os dois
// arquivos DML contêm. Precisa lidcom três formatações diferentes que aparecem
// nas fontes:
//
//   Oracle, sem lista de colunas, uma linha:
//     INSERT INTO produtos VALUES (1, 'Racao Premium Caes', 129.9, 1);
//     INSERT INTO vendas VALUES (1, 4, TO_DATE('15/01/2025','DD/MM/YYYY'));
//
//   PostgreSQL, com lista de colunas, multilinha:
//     INSERT INTO clientes
//     (nome,email,telefone,sexo,estado_civil,data_nascimento)
//     VALUES
//     ( 'Maria Costa', NULL, '(73)964659064', 'Feminino', 'Solteiro', '2003-01-13' );
//
//   PostgreSQL, lista de colunas encostada no nome:
//     INSERT INTO servicos(descricao,valor) VALUES('Banho Simples',40);
//
// A extração é DE-SERIALIZAÇÃO, não interpretação: tira a sintaxe SQL (aspas,
// TO_DATE) e devolve o literal como texto. '15/01/2025' continua em DD/MM/YYYY
// — converter para date é trabalho da camada de conformação, não daqui.
// =============================================================================

/**
 * Extrai todos os INSERTs de um script SQL.
 * Devolve [{ tabela, colunas: string[]|null, valores: string[], ordem }]
 * onde `ordem` é 1-based por tabela — indispensável para o Itabuna, cujas
 * chaves são SERIAL e portanto derivam da posição no arquivo.
 */
export function extrairInserts(sql) {
  const resultado = [];
  const contador = new Map();
  const re = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

  let m;
  while ((m = re.exec(sql)) !== null) {
    const tabela = m[1].toLowerCase();
    let i = m.index + m[0].length;

    // Lista de colunas, se houver. Cuidado: o próximo '(' pode ser o do VALUES.
    let colunas = null;
    const proximo = pularEspacos(sql, i);
    if (sql[proximo] === '(') {
      const bloco = lerParenteses(sql, proximo);
      const conteudo = bloco.conteudo.trim();
      // Heurística: lista de colunas é só identificadores e vírgulas. Se tiver
      // aspas ou número, é o tuple do VALUES de um INSERT sem lista de colunas.
      if (/^[A-Za-z_][A-Za-z0-9_]*(\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(conteudo)) {
        colunas = conteudo.split(',').map(c => c.trim().toLowerCase());
        i = bloco.fim;
      }
    }

    // VALUES
    const idxValues = sql.toUpperCase().indexOf('VALUES', i);
    if (idxValues < 0) continue;
    i = idxValues + 'VALUES'.length;

    // Um ou mais tuples separados por vírgula.
    while (true) {
      const abre = pularEspacos(sql, i);
      if (sql[abre] !== '(') break;
      const bloco = lerParenteses(sql, abre);
      const valores = dividirTopo(bloco.conteudo).map(normalizarLiteral);

      const ordem = (contador.get(tabela) ?? 0) + 1;
      contador.set(tabela, ordem);
      resultado.push({ tabela, colunas, valores, ordem });

      const depois = pularEspacos(sql, bloco.fim);
      if (sql[depois] === ',') { i = depois + 1; continue; }
      i = depois;
      break;
    }

    re.lastIndex = i;
  }

  return resultado;
}

/**
 * Agrupa o resultado de extrairInserts por tabela, já como objetos quando há
 * lista de colunas. Quando não há (Oracle), usa os nomes de coluna fornecidos
 * — que vêm do DDL, não de suposição.
 */
export function comoRegistros(inserts, tabela, colunasDoDdl = null) {
  return inserts
    .filter(x => x.tabela === tabela)
    .map(x => {
      const nomes = x.colunas ?? colunasDoDdl;
      if (!nomes) throw new Error(`sem nomes de coluna para ${tabela}`);
      if (nomes.length !== x.valores.length) {
        throw new Error(
          `${tabela}: ${nomes.length} colunas mas ${x.valores.length} valores ` +
          `(insert #${x.ordem}): ${JSON.stringify(x.valores)}`
        );
      }
      const reg = { __ordem: x.ordem };
      nomes.forEach((n, k) => { reg[n] = x.valores[k]; });
      return reg;
    });
}

/**
 * Lê os nomes de coluna de um CREATE TABLE, para não ter que supor a ordem dos
 * valores nos INSERTs sem lista de colunas (o caso do Salvador/Oracle).
 */
export function colunasDoCreateTable(ddl, tabela) {
  const re = new RegExp(`CREATE\\s+TABLE\\s+${tabela}\\s*\\(`, 'i');
  const m = re.exec(ddl);
  if (!m) return null;
  const bloco = lerParenteses(ddl, m.index + m[0].length - 1);

  const colunas = [];
  for (const parte of dividirTopo(bloco.conteudo)) {
    const t = parte.trim();
    // Pula definições que não são coluna.
    if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b/i.test(t)) continue;
    const nome = t.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (nome) colunas.push(nome.toLowerCase());
  }
  return colunas;
}

// -----------------------------------------------------------------------------
// Internos
// -----------------------------------------------------------------------------

function pularEspacos(s, i) {
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    // comentário de linha
    if (s[i] === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    // comentário de bloco
    if (s[i] === '/' && s[i + 1] === '*') {
      const fim = s.indexOf('*/', i);
      i = fim < 0 ? s.length : fim + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Lê de '(' até o ')' correspondente, respeitando aspas. */
function lerParenteses(s, inicio) {
  if (s[inicio] !== '(') throw new Error(`esperava '(' na posição ${inicio}`);
  let profundidade = 0;
  let emAspas = false;
  for (let i = inicio; i < s.length; i++) {
    const c = s[i];
    if (emAspas) {
      if (c === "'") {
        if (s[i + 1] === "'") { i++; continue; }  // '' escapado
        emAspas = false;
      }
      continue;
    }
    if (c === "'") { emAspas = true; continue; }
    if (c === '(') profundidade++;
    else if (c === ')') {
      profundidade--;
      if (profundidade === 0) {
        return { conteudo: s.slice(inicio + 1, i), fim: i + 1 };
      }
    }
  }
  throw new Error(`parêntese não fechado a partir da posição ${inicio}`);
}

/** Divide por vírgulas de nível 0, respeitando aspas e parênteses aninhados. */
function dividirTopo(s) {
  const partes = [];
  let atual = '';
  let profundidade = 0;
  let emAspas = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (emAspas) {
      atual += c;
      if (c === "'") {
        if (s[i + 1] === "'") { atual += s[++i]; continue; }
        emAspas = false;
      }
      continue;
    }
    if (c === "'") { emAspas = true; atual += c; continue; }
    if (c === '(') profundidade++;
    if (c === ')') profundidade--;
    if (c === ',' && profundidade === 0) { partes.push(atual); atual = ''; continue; }
    atual += c;
  }
  if (atual.trim() !== '') partes.push(atual);
  return partes;
}

/**
 * Tira a sintaxe SQL de um literal, devolvendo texto (ou null).
 * NÃO converte semântica: '15/01/2025' sai como '15/01/2025'.
 */
function normalizarLiteral(bruto) {
  const t = bruto.trim();

  if (/^NULL$/i.test(t)) return null;

  // Oracle: SYSDATE / CURRENT_DATE não carregam informação real nas fontes.
  if (/^(SYSDATE|CURRENT_DATE|CURRENT_TIMESTAMP|now\(\))$/i.test(t)) return null;

  // Oracle: TO_DATE('15/01/2025','DD/MM/YYYY') -> '15/01/2025'
  const toDate = t.match(/^TO_DATE\s*\(\s*'((?:[^']|'')*)'\s*(?:,\s*'(?:[^']|'')*'\s*)?\)$/i);
  if (toDate) return toDate[1].replace(/''/g, "'");

  // String
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }

  // Número ou qualquer outra coisa: devolve como texto, sem converter.
  return t;
}
