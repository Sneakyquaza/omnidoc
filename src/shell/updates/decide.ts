import { compareVersions } from "./version";

/** Consentement jamais demandé → afficher la demande (jamais en E2E). */
export function shouldAskConsent(autoCheck: boolean | null, e2e: boolean): boolean {
  return !e2e && autoCheck === null;
}

/** Vérification silencieuse au démarrage : seulement avec consentement explicite. */
export function shouldAutoCheck(autoCheck: boolean | null, e2e: boolean): boolean {
  return !e2e && autoCheck === true;
}

/** Une mise à jour trouvée doit-elle être présentée ? `auto` : la version ignorée est respectée. */
export function shouldShowUpdate(opts: {
  current: string;
  available: string;
  ignored: string | null;
  auto: boolean;
}): boolean {
  if (compareVersions(opts.available, opts.current) <= 0) return false;
  return !(opts.auto && opts.ignored === opts.available);
}

/** Nouveautés à présenter au démarrage : `lastSeen === null` (premier lancement) → rien. */
export function shouldShowWhatsNew(
  lastSeen: string | null,
  current: string,
  e2e: boolean,
): boolean {
  return !e2e && lastSeen !== null && compareVersions(current, lastSeen) > 0;
}
