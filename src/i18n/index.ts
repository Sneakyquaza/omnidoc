import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const defaultNS = "common";

type Dict = Record<string, unknown>;

/**
 * Tous les `locales/<langue>/<namespace>.json` sont enregistrés automatiquement :
 * un nouvel éditeur n'ajoute que ses fichiers JSON.
 */
const files = import.meta.glob<Dict>("./locales/*/*.json", { eager: true, import: "default" });

export const resources: Record<string, Record<string, Dict>> = {};
for (const [path, dict] of Object.entries(files)) {
  const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match?.[1] || !match[2]) continue;
  (resources[match[1]] ??= {})[match[2]] = dict;
}

/** FR si la langue du navigateur est française, sinon EN. */
export function detectLanguage(
  nav: string | undefined = globalThis.navigator?.language,
): "fr" | "en" {
  return nav?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: "en",
  ns: Array.from(new Set(Object.values(resources).flatMap((r) => Object.keys(r)))),
  defaultNS,
  interpolation: { escapeValue: false },
});

export default i18n;
