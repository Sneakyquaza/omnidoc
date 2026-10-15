export interface OutlineItem {
  level: number;
  title: string;
  /** Offset du début de la ligne du titre. */
  offset: number;
}

/** Titres Markdown (ATX et Setext), hors blocs de code délimités. */
export function markdownOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let offset = 0;
  let fence: string | null = null;
  let prev: { text: string; offset: number } | null = null;
  for (const line of text.split("\n")) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const marker = (fm[1] as string).slice(0, 1);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      prev = null;
    } else if (fence === null) {
      const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (atx) {
        items.push({ level: (atx[1] as string).length, title: atx[2] as string, offset });
        prev = null;
      } else {
        const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
        if (setext && prev) {
          items.push({
            level: (setext[1] as string).startsWith("=") ? 1 : 2,
            title: prev.text.trim(),
            offset: prev.offset,
          });
          prev = null;
        } else {
          prev = line.trim() === "" ? null : { text: line, offset };
        }
      }
    }
    offset += line.length + 1;
  }
  return items;
}
