/** Presse-papiers tabulaire (TSV compatible Excel / LibreOffice). */

function quoteField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeTsv(grid: string[][]): string {
  return grid.map((row) => row.map(quoteField).join("\t")).join("\n");
}

/** Analyse du TSV : champs entre guillemets (retours à la ligne inclus), CRLF/LF. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let atFieldStart = true;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      i++;
      continue;
    }
    atFieldStart = false;
    if (ch === "\t") {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
    } else field += ch;
    i++;
  }
  if (field !== "" || row.length > 0 || quoted) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
