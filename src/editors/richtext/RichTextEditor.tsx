import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { RichDoc } from "../../ipc/bindings";
import { readBytes } from "../../ipc/bytes";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { buildExtensions } from "./extensions";
import { IMAGE_EXTENSIONS, bytesToDataUri, fileToDataUri, mimeFromPath } from "./images";
import { clampZoom, countWords, estimatePages, lossyKind, normalizeDoc } from "./normalize";
import { SearchBar } from "./SearchBar";
import { Toolbar } from "./Toolbar";
import styles from "./RichTextEditor.module.css";

interface OutlineEntry {
  pos: number;
  level: number;
  text: string;
}

interface Snapshot {
  outline: OutlineEntry[];
  words: number;
  chars: number;
  paragraphs: number;
}

function computeSnapshot(editor: Editor): Snapshot {
  const outline: OutlineEntry[] = [];
  let paragraphs = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      outline.push({ pos, level: Number(node.attrs["level"]) || 1, text: node.textContent });
    } else if (node.type.name === "paragraph" && node.content.size > 0) {
      paragraphs++;
    }
    return true;
  });
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ");
  const storage = editor.storage as { characterCount?: { characters(): number } };
  return {
    outline,
    words: countWords(text),
    chars: storage.characterCount?.characters() ?? text.length,
    paragraphs,
  };
}

function isDocJson(v: unknown): v is { type: "doc" } {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "doc";
}

export default function RichTextEditor({
  model,
  readOnly,
  setDirty,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<RichDoc>) {
  const { t } = useTranslation("richtext");
  const [zoom, setZoom] = useState(100);
  const [search, setSearch] = useState<{ replace: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const contentFailed = useRef(false);
  const placeholder = t("placeholder");

  const insertImageFile = useCallback(
    async (file: Blob, pos?: number) => {
      try {
        const src = await fileToDataUri(file);
        const content = { type: "image", attrs: { src } };
        const ed = editorRef.current;
        if (!ed) return;
        if (pos === undefined) ed.chain().focus().insertContent(content).run();
        else ed.chain().focus().insertContentAt(pos, content).run();
      } catch {
        pushToast({ kind: "error", text: t("image.readError") });
      }
    },
    [t],
  );

  const editor = useEditor({
    extensions: useMemo(() => buildExtensions(placeholder), [placeholder]),
    content: isDocJson(model.doc) ? model.doc : undefined,
    editable: !readOnly,
    enableContentCheck: true,
    onContentError: ({ editor: ed }) => {
      contentFailed.current = true;
      ed.setEditable(false);
      pushToast({ kind: "error", text: t("contentError") });
    },
    // setEditable() émet aussi « update » sans changer le document : ne pas marquer modifié
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) setDirty(true);
    },
    editorProps: {
      attributes: { "aria-label": t("document"), role: "textbox", "aria-multiline": "true" },
      handlePaste: (_view, event) => {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        void insertImageFile(file);
        return true;
      },
      handleDrop: (view, event) => {
        const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImageFile(file, pos);
        return true;
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    registerSerializer(() =>
      contentFailed.current ? model : { ...model, doc: normalizeDoc(editor.getJSON()) },
    );
  }, [editor, model, registerSerializer]);

  useEffect(() => {
    editor?.setEditable(!readOnly && !contentFailed.current);
  }, [editor, readOnly]);

  const snap = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e ? computeSnapshot(e) : { outline: [], words: 0, chars: 0, paragraphs: 0 },
  });
  const pages = estimatePages(snap.words);

  useEffect(() => {
    setStatus([
      { id: "words", text: t("status.words", { count: snap.words }) },
      { id: "chars", text: t("status.chars", { count: snap.chars }) },
      { id: "paragraphs", text: t("status.paragraphs", { count: snap.paragraphs }) },
      { id: "pages", text: t("status.pages", { count: pages }), title: t("status.pagesHint") },
      { id: "zoom", text: `${zoom} %` },
    ]);
  }, [snap.words, snap.chars, snap.paragraphs, pages, zoom, setStatus, t]);

  const openSearch = useCallback((replace: boolean) => {
    setSearch((prev) => ({ replace: replace || (prev?.replace ?? false) }));
  }, []);

  const printDocument = useCallback(() => {
    const html = document.documentElement;
    const page = pageRef.current;
    html.classList.add("omnidoc-printing");
    page?.setAttribute("data-omnidoc-print", "");
    const cleanup = () => {
      html.classList.remove("omnidoc-printing");
      page?.removeAttribute("data-omnidoc-print");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    try {
      window.print();
    } catch {
      cleanup();
    }
  }, []);

  const pickImage = useCallback(async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: t("image.filter"), extensions: IMAGE_EXTENSIONS }],
      });
      if (typeof path !== "string") return;
      const bytes = new Uint8Array(await readBytes(path));
      const src = bytesToDataUri(bytes, mimeFromPath(path));
      editorRef.current?.chain().focus().setImage({ src }).run();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      pushToast({
        kind: "error",
        text: t("image.readError"),
        detail: code ? t(`common:errors.${code}`, { defaultValue: "" }) || undefined : undefined,
      });
    }
  }, [t]);

  useEffect(() => {
    registerCommands([
      {
        id: "richtext.find",
        title: t("commands.find"),
        shortcut: "Mod+F",
        run: () => openSearch(false),
      },
      {
        id: "richtext.replace",
        title: t("commands.replace"),
        shortcut: "Mod+H",
        run: () => openSearch(true),
      },
      {
        id: "richtext.zoomIn",
        title: t("commands.zoomIn"),
        shortcut: "Mod+=",
        run: () => setZoom((z) => clampZoom(z + 10)),
      },
      {
        id: "richtext.zoomOut",
        title: t("commands.zoomOut"),
        shortcut: "Mod+-",
        run: () => setZoom((z) => clampZoom(z - 10)),
      },
      {
        id: "richtext.zoomReset",
        title: t("commands.zoomReset"),
        run: () => setZoom(100),
      },
      { id: "richtext.print", title: t("commands.print"), shortcut: "Mod+P", run: printDocument },
    ]);
  }, [registerCommands, openSearch, printDocument, t]);

  function goToHeading(entry: OutlineEntry) {
    editor
      ?.chain()
      .focus()
      .setTextSelection(entry.pos + 1)
      .scrollIntoView()
      .run();
  }

  const lossyDetails = model.lossy.map((key) => {
    const { kind, name } = lossyKind(key);
    if (kind === "known") return t(`lossy.${key}`);
    if (kind === "node") return t("lossy.node", { name });
    if (kind === "mark") return t("lossy.mark", { name });
    return t("lossy.other", { name });
  });

  return (
    <div className={styles.root}>
      {editor && (
        <EditorToolbar>
          <Toolbar
            editor={editor}
            zoom={zoom}
            onZoom={(z) => setZoom(clampZoom(z))}
            onPickImage={() => void pickImage()}
            onPrint={printDocument}
            onFind={openSearch}
          />
        </EditorToolbar>
      )}
      <EditorSidePanel title={t("panel.title")}>
        <nav aria-label={t("panel.outline")} className={styles.outline}>
          <h3 className={styles.panelHeading}>{t("panel.outline")}</h3>
          {snap.outline.length === 0 ? (
            <p className={styles.muted}>{t("panel.noHeadings")}</p>
          ) : (
            <ul className={styles.outlineList}>
              {snap.outline.map((h) => (
                <li key={h.pos} style={{ paddingLeft: (h.level - 1) * 12 }}>
                  <button
                    type="button"
                    className={styles.outlineItem}
                    onClick={() => goToHeading(h)}
                  >
                    {h.text || t("panel.untitled")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <section aria-label={t("panel.stats")} className={styles.stats}>
          <h3 className={styles.panelHeading}>{t("panel.stats")}</h3>
          <dl>
            <dt>{t("panel.words")}</dt>
            <dd>{snap.words}</dd>
            <dt>{t("panel.chars")}</dt>
            <dd>{snap.chars}</dd>
            <dt>{t("panel.paragraphs")}</dt>
            <dd>{snap.paragraphs}</dd>
            <dt>{t("panel.pages")}</dt>
            <dd>{pages}</dd>
          </dl>
        </section>
      </EditorSidePanel>
      {model.lossy.length > 0 && (
        <div className={styles.banner} role="status">
          <strong>{t("lossy.title")}</strong>
          <ul>
            {lossyDetails.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {readOnly && (
        <div className={styles.banner} role="status">
          {t("readOnly")}
        </div>
      )}
      {editor && search && (
        <SearchBar
          editor={editor}
          showReplace={search.replace}
          query={query}
          replacement={replacement}
          caseSensitive={caseSensitive}
          onQuery={setQuery}
          onReplacement={setReplacement}
          onCaseSensitive={setCaseSensitive}
          onToggleReplace={() => setSearch({ replace: !search.replace })}
          onClose={() => setSearch(null)}
        />
      )}
      <div className={styles.desk}>
        <div className={styles.page} ref={pageRef} style={{ zoom: zoom / 100 }}>
          <EditorContent editor={editor} className={styles.content} />
        </div>
      </div>
    </div>
  );
}
