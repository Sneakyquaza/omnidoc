/** Formate des millisecondes en « mm:ss.mmm » (« h:mm:ss.mmm » à partir d'une heure). */
export function formatTime(ms: number, withMs = true): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const millis = total % 1000;
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60000) % 60;
  const hours = Math.floor(total / 3600000);
  const two = (n: number) => String(n).padStart(2, "0");
  const base =
    hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
  return withMs ? `${base}.${String(millis).padStart(3, "0")}` : base;
}

/**
 * Analyse « ss », « ss.mmm », « mm:ss », « mm:ss.mmm » ou « h:mm:ss.mmm » ;
 * renvoie des millisecondes, ou `null` si invalide.
 */
export function parseTime(text: string): number | null {
  const match = /^(?:(?:(\d+):)?(\d+):)?(\d+)(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!match) return null;
  const [, h, m, s, frac] = match;
  const hours = h === undefined ? 0 : Number(h);
  const minutes = m === undefined ? 0 : Number(m);
  const seconds = Number(s);
  // Avec « mm:ss » seul, minutes est en position m ; avec « h:mm:ss », h est défini
  if ((h !== undefined || m !== undefined) && seconds >= 60) return null;
  if (h !== undefined && minutes >= 60) return null;
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}
