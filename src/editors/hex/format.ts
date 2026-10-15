/** Utilitaires de formatage/analyse de l'éditeur hexadécimal. */

export function hex(n: number, width = 2): string {
  return n.toString(16).toUpperCase().padStart(width, "0");
}

export function formatOffset(n: number): string {
  return `0x${hex(n, 8)}`;
}

/** Caractère ASCII imprimable, sinon « . ». */
export function asciiChar(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
}

/** Taille lisible (« 1.5 KiB »). */
export function formatSize(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Décimal, ou hexadécimal préfixé « 0x ». */
export function parseOffset(input: string): number | null {
  const s = input.trim();
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^\d+$/.test(s)) n = parseInt(s, 10);
  else return null;
  return Number.isSafeInteger(n) ? n : null;
}

/** « de ad BE EF », « 0xdeadbeef » → octets ; `null` si invalide ou vide. */
export function parseHexPattern(input: string): Uint8Array | null {
  const s = input.replace(/^\s*0x/i, "").replace(/[\s,]+/g, "");
  if (s === "" || s.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function textPattern(input: string): Uint8Array | null {
  return input === "" ? null : new TextEncoder().encode(input);
}

/** Première occurrence de `pattern` dans `buf` à partir de `from` (-1 si absente). */
export function findInBuffer(buf: Uint8Array, pattern: Uint8Array, from: number): number {
  const first = pattern[0];
  if (first === undefined) return -1;
  let i = buf.indexOf(first, Math.max(0, from));
  while (i >= 0 && i + pattern.length <= buf.length) {
    let j = 1;
    while (j < pattern.length && buf[i + j] === pattern[j]) j++;
    if (j === pattern.length) return i;
    i = buf.indexOf(first, i + 1);
  }
  return -1;
}

export interface ByteValues {
  u8: number;
  i8: number;
  u16?: number;
  u32?: number;
}

/** Valeurs (petit-boutiste) à un offset ; `read` renvoie `undefined` hors des données chargées. */
export function describeValues(
  read: (offset: number) => number | undefined,
  offset: number,
): ByteValues | null {
  const b0 = read(offset);
  if (b0 === undefined) return null;
  const values: ByteValues = { u8: b0, i8: b0 > 127 ? b0 - 256 : b0 };
  const b1 = read(offset + 1);
  if (b1 !== undefined) {
    values.u16 = b0 | (b1 << 8);
    const b2 = read(offset + 2);
    const b3 = read(offset + 3);
    if (b2 !== undefined && b3 !== undefined)
      values.u32 = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
  return values;
}
