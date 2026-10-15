import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { findMatches, searchKey } from "./search";
import styles from "./RichTextEditor.module.css";

interface SearchBarProps {
  editor: Editor;
  showReplace: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  onQuery(q: string): void;
  onReplacement(r: string): void;
  onCaseSensitive(c: boolean): void;
  onToggleReplace(): void;
  onClose(): void;
}

export function SearchBar({
  editor,
  showReplace,
  query,
  replacement,
  caseSensitive,
  onQuery,
  onReplacement,
  onCaseSensitive,
  onToggleReplace,
  onClose,
}: SearchBarProps) {
  const { t } = useTranslation("richtext");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // Synchronise l'état de recherche avec le plugin ProseMirror.
  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, caseSensitive, current: 0 }));
    return () => {
      editor.view.dispatch(
        editor.state.tr.setMeta(searchKey, { query: "", caseSensitive: false, current: 0 }),
      );
    };
  }, [editor, query, caseSensitive]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      current: searchKey.getState(e.state)?.current ?? 0,
      count: findMatches(e.state.doc, query, caseSensitive).length,
      editable: e.isEditable,
    }),
  });
  const matches = useMemo(
    () => findMatches(editor.state.doc, query, caseSensitive),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, query, caseSensitive, state.count],
  );

  function goTo(index: number) {
    if (matches.length === 0) return;
    const i = (index + matches.length) % matches.length;
    const m = matches[i];
    if (!m) return;
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { current: i }));
    editor.chain().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
  }

  function replaceCurrent() {
    const m = matches[state.current];
    if (!m || !state.editable) return;
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, replacement).run();
  }

  function replaceAll() {
    if (!state.editable || matches.length === 0) return;
    const { tr } = editor.state;
    for (const m of [...matches].reverse()) {
      if (replacement) tr.insertText(replacement, m.from, m.to);
      else tr.delete(m.from, m.to);
    }
    editor.view.dispatch(tr);
  }

  return (
    <div
      className={styles.searchBar}
      role="search"
      aria-label={t("search.label")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          editor.commands.focus();
        }
      }}
    >
      <div className={styles.searchRow}>
        <input
          ref={inputRef}
          type="search"
          className={styles.searchInput}
          value={query}
          placeholder={t("search.find")}
          aria-label={t("search.find")}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goTo(state.current + (e.shiftKey ? -1 : 1));
            }
          }}
        />
        <span className={styles.searchCount} aria-live="polite">
          {query
            ? t("search.count", {
                current: matches.length ? state.current + 1 : 0,
                total: matches.length,
              })
            : ""}
        </span>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => goTo(state.current - 1)}
        >
          {t("search.previous")}
        </button>
        <button
          type="button"
          className={styles.searchButton}
          onClick={() => goTo(state.current + 1)}
        >
          {t("search.next")}
        </button>
        <label className={styles.searchCheck}>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => onCaseSensitive(e.target.checked)}
          />
          {t("search.caseSensitive")}
        </label>
        <button
          type="button"
          className={styles.searchButton}
          aria-pressed={showReplace}
          onClick={onToggleReplace}
        >
          {t("search.replaceToggle")}
        </button>
        <button type="button" className={styles.searchButton} onClick={onClose}>
          {t("search.close")}
        </button>
      </div>
      {showReplace && (
        <div className={styles.searchRow}>
          <input
            type="text"
            className={styles.searchInput}
            value={replacement}
            placeholder={t("search.replaceWith")}
            aria-label={t("search.replaceWith")}
            onChange={(e) => onReplacement(e.target.value)}
          />
          <button
            type="button"
            className={styles.searchButton}
            disabled={!state.editable || matches.length === 0}
            onClick={replaceCurrent}
          >
            {t("search.replace")}
          </button>
          <button
            type="button"
            className={styles.searchButton}
            disabled={!state.editable || matches.length === 0}
            onClick={replaceAll}
          >
            {t("search.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
