import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

function highlight(c: {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  fn: string;
  prop: string;
  tag: string;
}): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: c.keyword },
      { tag: [t.string, t.special(t.string), t.regexp], color: c.string },
      { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
      { tag: [t.comment, t.lineComment, t.blockComment], color: c.comment, fontStyle: "italic" },
      { tag: [t.typeName, t.className, t.namespace], color: c.type },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.fn },
      { tag: [t.propertyName, t.attributeName], color: c.prop },
      { tag: [t.tagName, t.angleBracket], color: c.tag },
      { tag: t.heading, fontWeight: "bold", color: c.keyword },
      { tag: t.strong, fontWeight: "bold" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.link, textDecoration: "underline", color: c.fn },
      { tag: t.invalid, color: "var(--color-danger)" },
    ]),
  );
}

const LIGHT = highlight({
  keyword: "#7c3aed",
  string: "#15803d",
  number: "#b45309",
  comment: "#5b6470",
  type: "#0e7490",
  fn: "#1d4ed8",
  prop: "#9d174d",
  tag: "#b91c1c",
});

const DARK = highlight({
  keyword: "#c4a1ff",
  string: "#8bd49c",
  number: "#f0b765",
  comment: "#98a1ad",
  type: "#67d4e8",
  fn: "#8db1ff",
  prop: "#f49bc2",
  tag: "#f48a8a",
});

/** Thème de base : couleurs issues des variables CSS de l'application. */
const base = (dark: boolean) =>
  EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "var(--color-text)",
        backgroundColor: "var(--color-bg)",
        fontSize: "13px",
      },
      ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
      ".cm-content": { caretColor: "var(--color-text)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-text)" },
      "&.cm-focused": { outline: "2px solid var(--color-focus)", outlineOffset: "-2px" },
      ".cm-gutters": {
        backgroundColor: "var(--color-surface)",
        color: "var(--color-text-muted)",
        borderRight: "1px solid var(--color-border)",
      },
      ".cm-activeLine": { backgroundColor: "var(--color-hover)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--color-hover)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(91, 141, 239, 0.35)" : "rgba(37, 99, 235, 0.25)",
      },
      ".cm-selectionMatch": {
        backgroundColor: dark ? "rgba(232, 176, 74, 0.25)" : "rgba(161, 92, 0, 0.18)",
      },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: dark ? "rgba(91, 141, 239, 0.35)" : "rgba(37, 99, 235, 0.2)",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-surface)",
        color: "var(--color-text)",
        borderColor: "var(--color-border)",
        fontFamily: "var(--font-ui)",
      },
      ".cm-panels input, .cm-panels button": { font: "inherit" },
      ".cm-panels input[type=text], .cm-panels input:not([type])": {
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius)",
        padding: "2px 6px",
      },
      ".cm-panels button": {
        backgroundImage: "none",
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius)",
      },
      ".cm-searchMatch": { backgroundColor: "rgba(232, 176, 74, 0.35)" },
      ".cm-searchMatch-selected": { backgroundColor: "rgba(91, 141, 239, 0.45)" },
      ".cm-tooltip": {
        backgroundColor: "var(--color-bg)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--color-accent)",
        color: "var(--color-accent-text)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--color-hover)",
        color: "var(--color-text-muted)",
        border: "1px solid var(--color-border)",
      },
    },
    { dark },
  );

export function themeExtension(dark: boolean): Extension {
  return [base(dark), dark ? DARK : LIGHT];
}

export function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === "dark";
}
