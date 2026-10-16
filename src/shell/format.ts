import i18n from "../i18n";

const UNITS_FR = ["o", "Ko", "Mo", "Go", "To"];
const UNITS_EN = ["B", "KB", "MB", "GB", "TB"];

/** Taille lisible et localisée (« 1,5 Ko » en FR, « 1.5 KB » en EN) ; base 1024. */
export function formatSize(bytes: number, lang: string = i18n.language): string {
  const units = lang.startsWith("fr") ? UNITS_FR : UNITS_EN;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const label = units[unit] ?? "";
  if (unit === 0) return `${bytes.toLocaleString(lang)} ${label}`;
  const digits = value >= 100 ? 0 : 1;
  const text = value.toLocaleString(lang, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${text} ${label}`;
}

/** Date et heure courtes localisées ; chaîne vide si absente ou invalide. */
export function formatDate(value: string | Date | null, lang: string = i18n.language): string {
  if (value === null) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang, { dateStyle: "short", timeStyle: "short" });
}
