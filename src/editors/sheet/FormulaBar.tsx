import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import styles from "./SheetEditor.module.css";

interface FormulaBarProps {
  /** Référence de la cellule / plage active ("B3", "A1:C5"). */
  reference: string;
  content: string;
  readOnly: boolean;
  onGoto(text: string): void;
  onContentFocus(): void;
  onContentChange(text: string): void;
  onContentKeyDown(e: KeyboardEvent<HTMLInputElement>): void;
}

export function FormulaBar(props: FormulaBarProps) {
  const { t } = useTranslation("sheet");
  // Brouillon de saisie ; null = affiche la référence courante
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className={styles.formulaBar}>
      <input
        className={styles.nameBox}
        aria-label={t("formulaBar.reference")}
        value={draft ?? props.reference}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onGoto(draft ?? props.reference);
            setDraft(null);
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLElement).blur();
          }
        }}
      />
      <span className={styles.fx} aria-hidden="true">
        fx
      </span>
      <input
        className={styles.formulaInput}
        aria-label={t("formulaBar.content")}
        data-testid="sheet-formula-input"
        value={props.content}
        readOnly={props.readOnly}
        spellCheck={false}
        onFocus={props.onContentFocus}
        onChange={(e) => props.onContentChange(e.target.value)}
        onKeyDown={props.onContentKeyDown}
      />
      {props.readOnly && <span className={styles.readOnlyTag}>{t("readOnly")}</span>}
    </div>
  );
}
