/** Traductions FR des textes intégrés de CodeMirror (l'anglais est la langue par défaut). */
const FR: Record<string, string> = {
  // @codemirror/view
  "Control character": "Caractère de contrôle",
  // @codemirror/commands
  "Selection deleted": "Sélection supprimée",
  // @codemirror/search
  "Go to line": "Aller à la ligne",
  go: "aller",
  Find: "Rechercher",
  Replace: "Remplacer",
  next: "suivant",
  previous: "précédent",
  all: "tout",
  "match case": "respecter la casse",
  regexp: "regexp",
  "by word": "mot entier",
  replace: "remplacer",
  "replace all": "tout remplacer",
  close: "fermer",
  "current match": "occurrence courante",
  "on line": "à la ligne",
  "replaced match on line $": "occurrence remplacée à la ligne $",
  "replaced $ matches": "$ occurrences remplacées",
  "Replaced match on line $": "Occurrence remplacée à la ligne $",
  "Replaced $ matches": "$ occurrences remplacées",
  // @codemirror/autocomplete
  Completions: "Complétions",
  // @codemirror/language
  "Folded lines": "Lignes repliées",
  "Unfolded lines": "Lignes dépliées",
  to: "à",
  "folded code": "code replié",
  unfold: "déplier",
  "Fold line": "Replier la ligne",
  "Unfold line": "Déplier la ligne",
  // @codemirror/lint
  Diagnostics: "Diagnostics",
  "No diagnostics": "Aucun diagnostic",
  Open: "Ouvrir",
  Dismiss: "Fermer",
};

/** Phrases CodeMirror pour la langue donnée (`{}` en anglais). */
export function cmPhrases(lang: string): Record<string, string> {
  return lang.startsWith("fr") ? FR : {};
}
