import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import frCommon from "./locales/fr/common.json";
import enCommon from "./locales/en/common.json";

export const defaultNS = "common";

export const resources = {
  fr: { common: frCommon },
  en: { common: enCommon },
} as const;

/** FR si la langue du navigateur est française, sinon EN. */
export function detectLanguage(nav: string | undefined = globalThis.navigator?.language): "fr" | "en" {
  return nav?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: "en",
  ns: ["common"],
  defaultNS,
  interpolation: { escapeValue: false },
});

export default i18n;
