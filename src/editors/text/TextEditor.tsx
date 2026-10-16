import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  searchKeymap,
} from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { commands } from "../../ipc/bindings";
import type { LineEnding, TextDoc } from "../../ipc/bindings";
import i18n from "../../i18n";
import { reportError } from "../../shell/errors";
import { SaveCancelled } from "../../shell/runtime";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { ToolBar, ToolGroup } from "../../shell/ui/ToolBar";
import { Menu } from "../../shell/ui/Menu";
import type { MenuItem } from "../../shell/ui/Menu";
import { choose, confirm } from "../../shell/ui/dialogStore";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { isDarkTheme, themeExtension } from "./cmTheme";
import { detectIndent } from "./indent";
import { dominantLineEnding, needsLineEndingChoice } from "./lineEnding";
import { LANGUAGES, loadLanguage } from "./languages";
import { MarkdownPreview } from "./MarkdownPreview";
import { InfoPanel, OutlinePanel, TreePanel } from "./Panels";
import type { PanelSource } from "./Panels";
import { cmPhrases } from "./phrases";
import { TREE_LANGUAGES } from "./tree";
import { formatJson, formatXml, validatorFor } from "./validate";
import styles from "./TextEditor.module.css";

/** Au-delà (en caractères), le fichier s'ouvre en lecture seule. */
const LARGE_TEXT = 20 * 1024 * 1024;
/** Au-delà, pas de validation ni de complétion de mots. */
const HEAVY_TEXT = 2 * 1024 * 1024;

const LINE_ENDINGS: Exclude<LineEnding, "mixed">[] = ["lf", "crlf", "cr"];
const INDENT_CHOICES: ("tab" | number)[] = ["tab", 2, 4, 8];

function wordSource(ctx: CompletionContext): CompletionResult | null {
  const w = ctx.matchBefore(/[\w$]+/);
  if (!w || (!ctx.explicit && w.to - w.from < 2)) return null;
  if (ctx.state.doc.length > HEAVY_TEXT) return null;
  const found = new Set(ctx.state.doc.sliceString(0, 500_000).match(/[\w$]{3,}/g) ?? []);
  found.delete(w.text);
  return { from: w.from, options: Array.from(found, (label) => ({ label, type: "text" })) };
}

function indentExtension(unit: "tab" | number) {
  return [
    indentUnit.of(unit === "tab" ? "\t" : " ".repeat(unit)),
    EditorState.tabSize.of(unit === "tab" ? 4 : unit),
  ];
}

interface Meta {
  encoding: string;
  bom: boolean;
  lineEnding: LineEnding;
  language: string;
}

export default function TextEditor({
  tab,
  model,
  readOnly,
  setDirty,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<TextDoc>) {
  const { t, i18n: i18nInst } = useTranslation("text");
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const comps = useRef({
    language: new Compartment(),
    lint: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment(),
    readOnly: new Compartment(),
    indent: new Compartment(),
    phrases: new Compartment(),
  });
  const tRef = useRef(t);
  // onglet restauré (dirty) : le texte récupéré n'est pas la version du disque → jamais « propre » par undo
  const baseline = useRef<string | null>(tab.dirty ? null : model.text);
  const dirtyRef = useRef(tab.dirty);
  const metaDirty = useRef(false);
  const suppress = useRef(false);

  const large = model.text.length > LARGE_TEXT;
  const [editEnabled, setEditEnabled] = useState(false);
  const effectiveReadOnly = readOnly || (large && !editEnabled);
  const [meta, setMeta] = useState<Meta>({
    encoding: model.encoding,
    bom: model.bom,
    lineEnding: model.lineEnding,
    language: model.language,
  });
  const metaRef = useRef(meta);
  const [indent, setIndent] = useState<"tab" | number>(() => detectIndent(model.text).unit);
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(false);
  const [version, setVersion] = useState(0);
  const [cursor, setCursor] = useState({
    line: 1,
    col: 1,
    selected: 0,
    ranges: 1,
    lines: 1,
    chars: 0,
  });
  const [encodings, setEncodings] = useState<string[]>([]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const updateMeta = useCallback(
    (patch: Partial<Meta>, markDirty: boolean) => {
      metaRef.current = { ...metaRef.current, ...patch };
      setMeta(metaRef.current);
      if (markDirty) {
        metaDirty.current = true;
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          setDirty(true);
        }
      }
    },
    [setDirty],
  );

  const getText = useCallback(
    () => viewRef.current?.state.doc.toString() ?? model.text,
    [model.text],
  );

  const goTo = useCallback((offset: number) => {
    const view = viewRef.current;
    if (!view) return;
    const pos = Math.min(offset, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }),
    });
    view.focus();
  }, []);

  // Création de la vue CodeMirror
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = comps.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let versionTimer: ReturnType<typeof setTimeout> | undefined;
    const search = searchKeymap.filter((k) => k.key !== "Mod-f" && k.key !== "Mod-g");
    const state = EditorState.create({
      doc: model.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        EditorState.languageData.of(() => [{ autocomplete: wordSource }]),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...search,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        c.language.of([]),
        c.lint.of([]),
        c.theme.of(themeExtension(isDarkTheme())),
        c.wrap.of([]),
        c.readOnly.of(EditorState.readOnly.of(effectiveReadOnlyInit())),
        c.indent.of(indentExtension(detectIndent(model.text).unit)),
        c.phrases.of(EditorState.phrases.of(cmPhrases(i18n.language))),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            const sel = u.state.selection.main;
            setCursor({
              line: line.number,
              col: head - line.from + 1,
              selected: sel.to - sel.from,
              ranges: u.state.selection.ranges.length,
              lines: u.state.doc.lines,
              chars: u.state.doc.length,
            });
          }
          if (!u.docChanged || suppress.current) return;
          if (!dirtyRef.current) {
            dirtyRef.current = true;
            setDirty(true);
          }
          clearTimeout(timer);
          timer = setTimeout(() => {
            const doc = viewRef.current?.state.doc;
            if (
              doc &&
              !metaDirty.current &&
              dirtyRef.current &&
              baseline.current !== null &&
              doc.length === baseline.current.length &&
              doc.toString() === baseline.current
            ) {
              dirtyRef.current = false;
              setDirty(false);
            }
          }, 300);
          clearTimeout(versionTimer);
          versionTimer = setTimeout(() => setVersion((v) => v + 1), 300);
        }),
      ],
    });
    function effectiveReadOnlyInit() {
      return readOnly || model.text.length > LARGE_TEXT;
    }
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    setCursor({
      line: 1,
      col: 1,
      selected: 0,
      ranges: 1,
      lines: state.doc.lines,
      chars: state.doc.length,
    });

    const observer = new MutationObserver(() =>
      view.dispatch({ effects: c.theme.reconfigure(themeExtension(isDarkTheme())) }),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    registerSerializer(async (opts) => {
      const m = metaRef.current;
      const text = view.state.doc.toString();
      let lineEnding = m.lineEnding;
      if (opts?.forSave && needsLineEndingChoice(lineEnding, text, baseline.current)) {
        const best = dominantLineEnding(text);
        const choice = await choose({
          title: tRef.current("mixedEol.title"),
          message: tRef.current("mixedEol.message"),
          actions: [
            { id: "cancel", label: i18n.t("common.cancel"), variant: "secondary" },
            ...LINE_ENDINGS.map((id) => ({
              id,
              label: tRef.current(`lineEndings.${id}`),
              variant: id === best ? ("primary" as const) : ("secondary" as const),
            })),
          ],
        });
        if (choice === null || choice === "cancel") throw new SaveCancelled();
        lineEnding = choice as LineEnding;
        updateMeta({ lineEnding }, true);
      }
      return {
        text,
        encoding: m.encoding,
        bom: m.bom,
        lineEnding,
        language: m.language,
      };
    });

    return () => {
      clearTimeout(timer);
      clearTimeout(versionTimer);
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // La vue n'est créée qu'une fois (le modèle initial ne change pas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sauvegarde réussie : le contenu courant devient la référence du « dirty »
  useEffect(() => {
    if (tab.dirty) return;
    const view = viewRef.current;
    if (view) baseline.current = view.state.doc.toString();
    dirtyRef.current = false;
    metaDirty.current = false;
  }, [tab.dirty]);

  // Langage : coloration + validation
  useEffect(() => {
    let cancelled = false;
    const c = comps.current;
    const language = meta.language;
    void loadLanguage(language).then((ext) => {
      if (!cancelled) viewRef.current?.dispatch({ effects: c.language.reconfigure(ext) });
    });
    const validate = model.text.length > HEAVY_TEXT ? null : validatorFor(language);
    viewRef.current?.dispatch({
      effects: c.lint.reconfigure(
        validate
          ? [
              linter(
                (view) =>
                  validate(view.state.doc.toString()).map((i) => ({
                    from: i.from,
                    to: i.to,
                    severity: "error" as const,
                    message: i.key ? tRef.current(`lint.json.${i.key}`) : i.message,
                  })),
                { delay: 300 },
              ),
              lintGutter(),
            ]
          : [],
      ),
    });
    return () => {
      cancelled = true;
    };
  }, [meta.language, model.text.length]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comps.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comps.current.readOnly.reconfigure(EditorState.readOnly.of(effectiveReadOnly)),
    });
  }, [effectiveReadOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comps.current.indent.reconfigure(indentExtension(indent)),
    });
  }, [indent]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comps.current.phrases.reconfigure(
        EditorState.phrases.of(cmPhrases(i18nInst.language)),
      ),
    });
  }, [i18nInst.language]);

  // Défilement synchronisé approximatif (source -> aperçu)
  useEffect(() => {
    const view = viewRef.current;
    if (!preview || !view) return;
    const scroller = view.scrollDOM;
    const onScroll = () => {
      const target = previewRef.current;
      if (!target) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const ratio = max > 0 ? scroller.scrollTop / max : 0;
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
    };
    scroller.addEventListener("scroll", onScroll);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [preview]);

  useEffect(() => {
    commands.textEncodings().then(setEncodings, () => setEncodings([]));
  }, []);

  const isMarkdown = meta.language === "markdown";
  const canFormat = meta.language === "json" || meta.language === "xml";

  const format = useCallback(() => {
    const view = viewRef.current;
    if (!view || effectiveReadOnly || !canFormat) return;
    const text = view.state.doc.toString();
    try {
      const out = meta.language === "json" ? formatJson(text) : formatXml(text);
      if (out === text) return;
      view.dispatch({
        changes: { from: 0, to: text.length, insert: out },
        selection: { anchor: 0 },
      });
    } catch {
      pushToast({ kind: "error", text: tRef.current("format.invalid") });
    }
  }, [effectiveReadOnly, canFormat, meta.language]);

  // Commandes
  useEffect(() => {
    const view = () => viewRef.current;
    const list = [
      {
        id: "text.find",
        title: t("commands.find"),
        shortcut: "Mod+F",
        run: () => {
          const v = view();
          if (v) {
            openSearchPanel(v);
            v.focus();
          }
        },
      },
      {
        id: "text.replace",
        title: t("commands.replace"),
        shortcut: "Mod+H",
        run: () => {
          const v = view();
          if (v) {
            openSearchPanel(v);
            v.focus();
          }
        },
      },
      {
        id: "text.goto",
        title: t("commands.goto"),
        shortcut: "Mod+G",
        run: () => {
          const v = view();
          if (v) {
            gotoLine(v);
            v.focus();
          }
        },
      },
      {
        id: "text.wrap",
        title: t("commands.wrap"),
        shortcut: "Alt+Z",
        run: () => setWrap((w) => !w),
      },
    ];
    if (canFormat) {
      list.push({
        id: "text.format",
        title: t("commands.format"),
        shortcut: "Mod+Shift+F",
        run: format,
      });
    }
    if (isMarkdown) {
      list.push({
        id: "text.preview",
        title: t("commands.preview"),
        shortcut: "Mod+Shift+M",
        run: () => setPreview((p) => !p),
      });
    }
    registerCommands(list);
  }, [registerCommands, t, canFormat, isMarkdown, format]);

  // Barre d'état
  useEffect(() => {
    const langLabel = t(`languages.${meta.language}`, { defaultValue: meta.language });
    setStatus([
      { id: "text-pos", text: t("status.pos", { line: cursor.line, col: cursor.col }) },
      ...(cursor.ranges > 1
        ? [{ id: "text-sel", text: t("status.cursors", { count: cursor.ranges }) }]
        : cursor.selected > 0
          ? [{ id: "text-sel", text: t("status.selected", { count: cursor.selected }) }]
          : []),
      { id: "text-lang", text: langLabel, title: t("toolbar.language") },
      {
        id: "text-enc",
        text: meta.bom ? `${meta.encoding} (BOM)` : meta.encoding,
        title: t("toolbar.encoding"),
      },
      {
        id: "text-eol",
        text: meta.lineEnding === "mixed" ? t("lineEndings.mixed") : meta.lineEnding.toUpperCase(),
        title: t("toolbar.lineEnding"),
      },
      {
        id: "text-indent",
        text: indent === "tab" ? t("status.tabs") : t("status.spaces", { count: indent }),
        title: t("toolbar.indent"),
      },
    ]);
  }, [cursor, meta, indent, setStatus, t]);

  async function reopenWith(encoding: string) {
    const path = tab.path;
    const view = viewRef.current;
    if (!path || !view) return;
    if (dirtyRef.current) {
      const ok = await confirm({
        title: t("encoding.reopenTitle"),
        message: t("encoding.reopenMessage", { encoding }),
        confirmLabel: t("encoding.reopenConfirm"),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const doc = await commands.textReopenWithEncoding(path, encoding);
      suppress.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.text },
        selection: { anchor: 0 },
      });
      suppress.current = false;
      baseline.current = doc.text;
      dirtyRef.current = false;
      metaDirty.current = false;
      updateMeta({ encoding: doc.encoding, bom: doc.bom, lineEnding: doc.lineEnding }, false);
      setDirty(false);
      setVersion((v) => v + 1);
    } catch (e) {
      suppress.current = false;
      reportError(e);
    }
  }

  const source = useMemo<PanelSource>(() => ({ getText, version, goTo }), [getText, version, goTo]);

  const mark = (on: boolean) => (on ? "✓ " : "");
  const languageItems: MenuItem[] = LANGUAGES.map((id) => ({
    id,
    label: mark(meta.language === id) + t(`languages.${id}`),
    onSelect: () => updateMeta({ language: id }, true),
  }));
  const lineEndingItems: MenuItem[] = LINE_ENDINGS.map((id) => ({
    id,
    label: mark(meta.lineEnding === id) + t(`lineEndings.${id}`),
    onSelect: () => updateMeta({ lineEnding: id }, true),
  }));
  const indentItems: MenuItem[] = INDENT_CHOICES.map((id) => ({
    id: String(id),
    label:
      mark(indent === id) + (id === "tab" ? t("status.tabs") : t("status.spaces", { count: id })),
    onSelect: () => setIndent(id),
  }));
  const reopenItems: MenuItem[] = encodings.map((id) => ({
    id,
    label: mark(meta.encoding === id) + id,
    onSelect: () => void reopenWith(id),
  }));
  const saveItems: MenuItem[] = encodings.map((id) => ({
    id,
    label: mark(meta.encoding === id) + id,
    onSelect: () =>
      updateMeta({ encoding: id, bom: id === "UTF-8" ? metaRef.current.bom : false }, true),
  }));

  const infoRows = [
    {
      label: t("info.language"),
      value: t(`languages.${meta.language}`, { defaultValue: meta.language }),
    },
    { label: t("info.encoding"), value: meta.bom ? `${meta.encoding} (BOM)` : meta.encoding },
    { label: t("info.lineEnding"), value: t(`lineEndings.${meta.lineEnding}`) },
    { label: t("info.lines"), value: cursor.lines.toLocaleString(i18nInst.language) },
    { label: t("info.chars"), value: cursor.chars.toLocaleString(i18nInst.language) },
  ];

  return (
    <div className={styles.root}>
      <EditorToolbar>
        <ToolBar label={t("toolbar.label")}>
          <ToolGroup>
            <Button icon="wrap" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              {t("toolbar.wrap")}
            </Button>
            {canFormat && (
              <Button icon="wand" onClick={format} disabled={effectiveReadOnly}>
                {t("toolbar.format")}
              </Button>
            )}
            {isMarkdown && (
              <Button
                icon="eye"
                aria-pressed={preview}
                data-testid="text-preview-toggle"
                onClick={() => setPreview((p) => !p)}
              >
                {t("toolbar.preview")}
              </Button>
            )}
          </ToolGroup>
          <ToolGroup>
            <Menu label={t("toolbar.language")} icon="text" items={languageItems} />
            <Menu
              label={t("toolbar.reopen")}
              icon="openAs"
              items={reopenItems}
              disabled={tab.path === null || encodings.length === 0}
            />
            <Menu
              label={t("toolbar.saveWith")}
              icon="saveAs"
              items={saveItems}
              disabled={effectiveReadOnly || encodings.length === 0}
            />
            <Menu
              label={t("toolbar.lineEnding")}
              icon="enter"
              items={lineEndingItems}
              disabled={effectiveReadOnly}
            />
            <Menu label={t("toolbar.indent")} icon="indent" items={indentItems} />
          </ToolGroup>
        </ToolBar>
      </EditorToolbar>
      <EditorSidePanel title={t("panel.title")}>
        {TREE_LANGUAGES.includes(meta.language) ? (
          model.text.length > HEAVY_TEXT ? (
            <p className={styles.panelNote}>{t("tree.tooLarge")}</p>
          ) : (
            <TreePanel language={meta.language} source={source} />
          )
        ) : isMarkdown ? (
          <OutlinePanel source={source} />
        ) : (
          <InfoPanel rows={infoRows} />
        )}
      </EditorSidePanel>
      {large && !editEnabled && !readOnly && (
        <div className={styles.banner} role="status">
          <span>{t("large.banner")}</span>
          <Button onClick={() => setEditEnabled(true)}>{t("large.enable")}</Button>
        </div>
      )}
      {readOnly && (
        <div className={styles.banner} role="status">
          {t("readOnly")}
        </div>
      )}
      <div className={styles.main}>
        <div className={styles.editor} ref={hostRef} aria-label={t("editor.label")} />
        {preview && isMarkdown && (
          <MarkdownPreview getText={getText} version={version} containerRef={previewRef} />
        )}
      </div>
    </div>
  );
}
