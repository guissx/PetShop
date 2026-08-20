// =============================================================================
// Leitor de ZIP minimalista — só o necessário para abrir um .xlsx
// =============================================================================
// Um .xlsx é um ZIP com XML dentro. Em vez de depender de uma lib externa
// (openpyxl/exceljs), lemos o ZIP direto: `zlib.inflateRawSync` do Node faz o
// deflate, que é o único método de compressão que o Excel usa.
//
// Suporta os métodos 0 (stored) e 8 (deflate). Não suporta ZIP64 nem
// criptografia — nenhum dos dois aparece em planilha do Excel deste tamanho.
// =============================================================================

import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const SIG_EOCD = 0x06054b50;  // End Of Central Directory
const SIG_CD   = 0x02014b50;  // Central Directory file header
const SIG_LFH  = 0x04034b50;  // Local File Header

/**
 * Abre um arquivo ZIP e devolve um Map de nome -> Buffer descomprimido.
 */
export function lerZip(caminho) {
  const buf = readFileSync(caminho);

  // O EOCD fica no fim, mas pode ter um comentário depois. Varre de trás.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`ZIP inválido (EOCD não encontrado): ${caminho}`);

  const totalEntradas = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const membros = new Map();

  for (let n = 0; n < totalEntradas; n++) {
    if (buf.readUInt32LE(offset) !== SIG_CD) {
      throw new Error(`ZIP inválido (central directory corrompido na entrada ${n})`);
    }
    const metodo         = buf.readUInt16LE(offset + 10);
    const tamComprimido  = buf.readUInt32LE(offset + 20);
    const tamNome        = buf.readUInt16LE(offset + 28);
    const tamExtra       = buf.readUInt16LE(offset + 30);
    const tamComentario  = buf.readUInt16LE(offset + 32);
    const offsetLocal    = buf.readUInt32LE(offset + 42);
    const nome           = buf.toString('utf8', offset + 46, offset + 46 + tamNome);

    // No header local o campo `extra` pode ter tamanho diferente do central,
    // então precisa ser lido de lá, não reaproveitado.
    if (buf.readUInt32LE(offsetLocal) !== SIG_LFH) {
      throw new Error(`ZIP inválido (local header de ${nome})`);
    }
    const lfhTamNome  = buf.readUInt16LE(offsetLocal + 26);
    const lfhTamExtra = buf.readUInt16LE(offsetLocal + 28);
    const inicioDados = offsetLocal + 30 + lfhTamNome + lfhTamExtra;
    const dados = buf.subarray(inicioDados, inicioDados + tamComprimido);

    let conteudo;
    if (metodo === 0)      conteudo = Buffer.from(dados);
    else if (metodo === 8) conteudo = inflateRawSync(dados);
    else throw new Error(`método de compressão ${metodo} não suportado (${nome})`);

    membros.set(nome, conteudo);
    offset += 46 + tamNome + tamExtra + tamComentario;
  }

  return membros;
}

/**
 * Lê a primeira planilha de um .xlsx e devolve uma matriz de células como texto.
 *
 * Só o necessário para a planilha do concorrente: valores inline (`<v>`),
 * sharedStrings (`t="s"`) e strings inline (`t="inlineStr"`). Não resolve
 * fórmulas nem formatação de data (a planilha não tem nenhuma das duas).
 */
export function lerXlsx(caminho) {
  const zip = lerZip(caminho);

  const xmlSharedStrings = zip.get('xl/sharedStrings.xml');
  const sharedStrings = [];
  if (xmlSharedStrings) {
    const xml = xmlSharedStrings.toString('utf8');
    // Cada <si> é uma string; pode ser fatiada em vários <t> por formatação rica.
    for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
      const partes = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]);
      sharedStrings.push(desescaparXml(partes.join('')));
    }
  }

  // Descobre a primeira planilha na ordem do workbook, em vez de assumir sheet1.
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const wbXml   = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const primeiroRid = wbXml.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  let alvo = 'xl/worksheets/sheet1.xml';
  if (primeiroRid) {
    const destino = relsXml.match(
      new RegExp(`<Relationship\\b[^>]*Id="${primeiroRid}"[^>]*Target="([^"]+)"`)
    )?.[1];
    if (destino) alvo = 'xl/' + destino.replace(/^\/?xl\//, '').replace(/^\.\//, '');
  }
  const sheet = zip.get(alvo) ?? zip.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error(`planilha não encontrada em ${caminho}`);

  const xml = sheet.toString('utf8');
  const linhas = [];

  for (const linhaXml of xml.match(/<row\b[\s\S]*?(?:\/>|<\/row>)/g) ?? []) {
    const numeroLinha = Number(linhaXml.match(/\br="(\d+)"/)?.[1] ?? 0);
    const celulas = [];

    for (const m of linhaXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? '';
      const corpo = m[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const tipo = attrs.match(/\bt="([^"]+)"/)?.[1];
      const coluna = ref ? letraParaIndice(ref) : celulas.length;

      let valor = null;
      if (tipo === 'inlineStr') {
        const partes = [...corpo.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
        valor = desescaparXml(partes.join(''));
      } else {
        const v = corpo.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v !== undefined) {
          valor = tipo === 's' ? (sharedStrings[Number(v)] ?? null) : desescaparXml(v);
        }
      }
      celulas[coluna] = valor;
    }

    linhas[numeroLinha - 1] = celulas;
  }

  // Remove buracos deixados por linhas/células ausentes.
  return linhas.filter(Boolean).map(l => Array.from(l, c => c ?? null));
}

function letraParaIndice(letras) {
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function desescaparXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');  // por último, para não desfazer os anteriores
}
