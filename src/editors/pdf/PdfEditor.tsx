import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { PdfAnnotation, PdfDoc } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { choose } from "../../shell/ui/dialogStore";
import { Menu } from "../../shell/ui/Menu";
import type { MenuItem } from "../../shell/ui/Menu";
import { pushToast } from "../../shell/ui/toastStore";
import type { EditorProps } from "../types";
import { ContextMenu } from "./ContextMenu";
import { MergeDialog, RangesDialog, TextPromptDialog } from "./Dialogs";
import { exportPagesPng, hexToRgb } from "./exportPng";
import {
  rectsToQuads,
  strokeBounds,
  strokeToPdf,
  toPdf,
  viewportSize,
  viewRectToPdfRect,
} from "./geometry";
import type { PageGeometry, PdfRect, ViewRect } from "./geometry";
import { isIdentity, nextSelection, reorderPages } from "./pages";
import { PageView } from "./PageView";
import type { Draft, Tool } from "./PageView";
import { CSS_UNITS } from "./pdfjs";
import { AnnotationsPanel, OutlinePanel } from "./SidebarPanels";
import type { TextMatch } from "./search";
import { Thumbnails } from "./Thumbnails";
import { DEFAULT_PAGE, usePdfDocument } from "./usePdfDocument";
import { usePageOps } from "./usePageOps";
import { useSearch } from "./useSearch";
import styles from "./PdfEditor.module.css";

const GAP = 12;
const PAD = 16;
const MIN_PCT = 50;
const MAX_PCT = 400;
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];
const TOOLS: Tool[] = ["select", "highlight", "note", "freeText", "ink"];
const DEFAULT_COLORS: Record<Tool, string> = {
  select: "#ffd400",
  highlight: "#ffd400",
  note: "#ffd400",
  freeText: "#d32f2f",
  ink: "#d32f2f",
};

type Zoom = { mode: "width" | "page" } | { mode: "custom"; pct: number };
type Tab = "thumbs" | "outline" | "annotations";
type Dlg =
  | { kind: "ranges" }
  | { kind: "merge" }
  | { kind: "text"; mode: "note" | "freeText"; page: number; rect: PdfRect };

interface Actions {
  find(): void;
  goto(): void;
  zoomBy(factor: number): void;
  save(): void;
  saveHandler(forceSaveAs?: boolean): Promise<boolean>;
  rotatePages(degrees: number): void;
  remove(): void;
  extract(): void;
  split(): void;
  merge(): void;
  exportPng(): void;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export default function PdfEditor({
  tab,
  model,
  setDirty,
  registerSerializer,
  registerCommands,
  registerSaveHandler,
  setEditable,
  setStatus,
}: EditorProps<PdfDoc>) {
  const { t } = useTranslation("pdf");
  const path = tab.path;
  const doc = usePdfDocument(path, !model.encrypted);
  const { pdf, infos, generation, reload } = doc;
  const pageCount = pdf?.numPages ?? model.pageCount;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const anchor = useRef(1);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [zoom, setZoom] = useState<Zoom>({ mode: "width" });
  const [rotation, setRotation] = useState(0);
  const [current, setCurrent] = useState(1);
  const [pageText, setPageText] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([1]);
  const [sideTab, setSideTab] = useState<Tab>("thumbs");
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(DEFAULT_COLORS.highlight);
  const [pending, setPending] = useState<PdfAnnotation[]>([]);
  const [existing, setExisting] = useState<PdfAnnotation[]>([]);
  const [dialog, setDialog] = useState<Dlg | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // --- Géométrie ---
  const infoOf = useCallback((p: number) => infos[p - 1] ?? infos[0] ?? DEFAULT_PAGE, [infos]);
  const scale = useMemo(() => {
    if (zoom.mode === "custom") return (zoom.pct / 100) * CSS_UNITS;
    const first = viewportSize({
      view: infoOf(1).view,
      rotation: infoOf(1).rotate + rotation,
      scale: 1,
    });
    const byWidth = (size.w - 2 * PAD) / first.width;
    if (zoom.mode === "width") return clamp(byWidth, 0.1, 8);
    return clamp(Math.min(byWidth, (size.h - 2 * GAP) / first.height), 0.1, 8);
  }, [zoom, size, rotation, infoOf]);
  const pct = Math.round((scale / CSS_UNITS) * 100);

  const geoms = useMemo<PageGeometry[]>(
    () =>
      Array.from({ length: pageCount }, (_, i) => {
        const info = infos[i] ?? infos[0] ?? DEFAULT_PAGE;
        return { view: info.view, rotation: (info.rotate + rotation) % 360, scale };
      }),
    [pageCount, infos, rotation, scale],
  );
  const maxWidth = useMemo(
    () => geoms.reduce((m, g) => Math.max(m, viewportSize(g).width), 0),
    [geoms],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => (geoms[i] ? viewportSize(geoms[i]).height : 800) + GAP,
    overscan: 1,
    paddingStart: GAP,
    paddingEnd: GAP,
  });

  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    virtualizer.measure();
  }, [geoms, virtualizer]);

  // Conserve la page courante lors d'un changement de zoom / rotation
  useEffect(() => {
    virtualizer.scrollToIndex(currentRef.current - 1, { align: "start" });
  }, [scale, rotation, virtualizer]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [pdf]);

  const goToPage = useCallback(
    (p: number) => {
      const n = clamp(Math.round(p), 1, Math.max(1, pageCount));
      setCurrent(n);
      virtualizer.scrollToIndex(n - 1, { align: "start" });
    },
    [pageCount, virtualizer],
  );

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop + el.clientHeight / 3;
    const items = virtualizer.getVirtualItems();
    const hit = items.find((v) => v.end > top) ?? items[items.length - 1];
    if (hit) setCurrent(hit.index + 1);
  }

  // Ctrl + molette = zoom
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = (scaleRef.current / CSS_UNITS) * 100;
      const next = clamp(now * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_PCT, MAX_PCT);
      setZoom({ mode: "custom", pct: Math.round(next) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pdf]);

  // --- Annotations existantes ---
  useEffect(() => {
    let cancelled = false;
    if (!path || generation === 0) return;
    commands
      .pdfListAnnotations(path)
      .then((list) => {
        if (!cancelled) setExisting(list);
      })
      .catch(() => {
        if (!cancelled) setExisting([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path, generation]);

  useEffect(() => {
    setDirty(pending.length > 0);
  }, [pending.length, setDirty]);

  useEffect(() => {
    registerSerializer(() => model);
  }, [registerSerializer, model]);

  // --- Recherche ---
  const search = useSearch(pdf, goToPage);

  // --- Opérations de pages ---
  const reloadDoc = useCallback(async () => {
    await reload();
    setSelected([1]);
    anchor.current = 1;
  }, [reload]);
  const ops = usePageOps({ path, pageCount, hasPending: pending.length > 0, reload: reloadDoc });

  const targets = useCallback(
    () => (selected.length > 0 ? selected : [Math.min(current, pageCount)]),
    [selected, current, pageCount],
  );

  function onSelectThumb(page: number, mods: { ctrl: boolean; shift: boolean }) {
    setSelected((s) => nextSelection(s, anchor.current, page, mods));
    if (!mods.shift) anchor.current = page;
    goToPage(page);
  }

  async function dropReorder(pages: number[], insertBefore: number) {
    const order = reorderPages(pageCount, pages, insertBefore);
    if (isIdentity(order)) return;
    if (await ops.reorder(order)) {
      setSelected(pages.map((p) => order.indexOf(p) + 1).sort((a, b) => a - b));
    }
  }

  function moveSelection(dir: -1 | 1) {
    const pages = targets();
    const insertBefore = dir < 0 ? Math.min(...pages) - 1 : Math.max(...pages) + 2;
    if (insertBefore < 1 || insertBefore > pageCount + 1) return;
    void dropReorder(pages, insertBefore);
  }

  async function exportPng() {
    if (!pdf || !path) return;
    try {
      const n = await exportPagesPng(pdf, targets(), path);
      if (n > 0) pushToast({ kind: "success", text: t("ops.exported", { count: n }) });
    } catch (e) {
      reportError(e);
    }
  }

  // --- Annotation ---
  const addPending = useCallback((a: PdfAnnotation) => setPending((p) => [...p, a]), []);

  const latest = useRef({ geoms, color });
  useEffect(() => {
    latest.current = { geoms, color };
  });

  const onDraft = useCallback(
    (page: number, draft: Draft) => {
      const g = latest.current.geoms[page - 1];
      if (!g) return;
      const rgb = hexToRgb(latest.current.color);
      const base = { page, color: rgb, author: null, quads: null, inkList: null };
      if (draft.kind === "note") {
        const [x, y] = toPdf(g, draft.point[0], draft.point[1]);
        setDialog({ kind: "text", mode: "note", page, rect: [x, y - 20, x + 20, y] });
      } else if (draft.kind === "freeText") {
        setDialog({ kind: "text", mode: "freeText", page, rect: viewRectToPdfRect(g, draft.rect) });
      } else {
        const coords = strokeToPdf(g, draft.points);
        addPending({
          ...base,
          kind: "ink",
          rect: strokeBounds(coords, 2),
          contents: null,
          inkList: [coords],
        });
      }
    },
    [addPending],
  );

  function submitText(d: Extract<Dlg, { kind: "text" }>, text: string) {
    setDialog(null);
    addPending({
      page: d.page,
      kind: d.mode,
      rect: d.rect,
      quads: null,
      color: hexToRgb(color),
      contents: text,
      author: null,
      inkList: null,
    });
  }

  function highlightSelection() {
    if (tool !== "highlight") return;
    const sel = window.getSelection();
    const scroller = scrollerRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !scroller) return;
    const clientRects = Array.from(sel.getRangeAt(0).getClientRects());
    const added: PdfAnnotation[] = [];
    scroller.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => {
      const page = Number(el.dataset.page);
      const g = geoms[page - 1];
      if (!g) return;
      const box = el.getBoundingClientRect();
      const rects: ViewRect[] = clientRects
        .filter((r) => {
          const cx = (r.left + r.right) / 2;
          const cy = (r.top + r.bottom) / 2;
          return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
        })
        .map((r) => ({
          left: r.left - box.left,
          top: r.top - box.top,
          right: r.right - box.left,
          bottom: r.bottom - box.top,
        }));
      const q = rectsToQuads(g, rects);
      if (q) {
        added.push({
          page,
          kind: "highlight",
          rect: q.rect,
          quads: q.quads,
          color: hexToRgb(color),
          contents: null,
          author: null,
          inkList: null,
        });
      }
    });
    if (added.length > 0) {
      setPending((p) => [...p, ...added]);
      sel.removeAllRanges();
    }
  }

  /** `true` si rien ne reste à enregistrer (annotations écrites ou aucune en attente). */
  async function saveAnnotations(forceSaveAs = false): Promise<boolean> {
    if (!path) return false;
    if (pending.length === 0) return !forceSaveAs;
    const choice = forceSaveAs
      ? "saveAs"
      : await choose({
          title: t("annotate.confirmTitle"),
          message: t("annotate.confirmMessage", { count: pending.length }),
          actions: [
            { id: "saveAs", label: t("annotate.saveAs"), variant: "secondary" },
            { id: "save", label: t("annotate.save"), variant: "primary" },
          ],
        });
    if (choice === null) return false;
    let dest = path;
    if (choice === "saveAs") {
      const picked = await saveDialog({
        defaultPath: path,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (picked === null) return false;
      dest = picked;
    }
    const ok = await ops.run(async () => {
      await commands.pdfAnnotate(path, pending, dest);
      setPending([]);
      if (dest === path) await reload();
    });
    if (ok && dest !== path) {
      pushToast({ kind: "success", text: t("ops.saved", { name: basename(dest) }) });
    }
    return ok;
  }

  // --- Commandes, état ---
  const actions = useRef<Actions>({
    find: () => {},
    goto: () => {},
    zoomBy: () => {},
    save: () => {},
    saveHandler: () => Promise.resolve(false),
    rotatePages: () => {},
    remove: () => {},
    extract: () => {},
    split: () => {},
    merge: () => {},
    exportPng: () => {},
  });
  useEffect(() => {
    actions.current = {
      find: () => search.setOpen(true),
      goto: () => pageInputRef.current?.select(),
      zoomBy: (f) => setZoom({ mode: "custom", pct: clamp(Math.round(pct * f), MIN_PCT, MAX_PCT) }),
      save: () => void saveAnnotations(),
      saveHandler: saveAnnotations,
      rotatePages: (d) => void ops.rotate(targets(), d),
      remove: () => void ops.remove(targets()),
      extract: () => void ops.extract(targets()),
      split: () => setDialog({ kind: "ranges" }),
      merge: () => setDialog({ kind: "merge" }),
      exportPng: () => void exportPng(),
    };
  });

  useEffect(() => {
    registerSaveHandler({
      save: () => actions.current.saveHandler(),
      saveAs: () => actions.current.saveHandler(true),
    });
    setEditable(true);
  }, [registerSaveHandler, setEditable]);

  useEffect(() => {
    const a = () => actions.current;
    registerCommands([
      { id: "pdf.find", title: t("commands.find"), shortcut: "Mod+F", run: () => a().find() },
      { id: "pdf.goto", title: t("commands.goto"), shortcut: "Mod+G", run: () => a().goto() },
      {
        id: "pdf.zoomIn",
        title: t("commands.zoomIn"),
        shortcut: "Mod++",
        run: () => a().zoomBy(1.25),
      },
      {
        id: "pdf.zoomOut",
        title: t("commands.zoomOut"),
        shortcut: "Mod+-",
        run: () => a().zoomBy(0.8),
      },
      {
        id: "pdf.fitWidth",
        title: t("commands.fitWidth"),
        shortcut: "Mod+0",
        run: () => setZoom({ mode: "width" }),
      },
      { id: "pdf.fitPage", title: t("commands.fitPage"), run: () => setZoom({ mode: "page" }) },
      {
        id: "pdf.rotateView",
        title: t("commands.rotateView"),
        run: () => setRotation((r) => (r + 90) % 360),
      },
      { id: "pdf.tool.highlight", title: t("tools.highlight"), run: () => setTool("highlight") },
      { id: "pdf.tool.note", title: t("tools.note"), run: () => setTool("note") },
      { id: "pdf.tool.freeText", title: t("tools.freeText"), run: () => setTool("freeText") },
      { id: "pdf.tool.ink", title: t("tools.ink"), run: () => setTool("ink") },
      { id: "pdf.saveAnnotations", title: t("annotate.saveButton"), run: () => a().save() },
      { id: "pdf.rotateLeft", title: t("pages.rotateLeft"), run: () => a().rotatePages(270) },
      { id: "pdf.rotateRight", title: t("pages.rotateRight"), run: () => a().rotatePages(90) },
      { id: "pdf.delete", title: t("pages.delete"), run: () => a().remove() },
      { id: "pdf.extract", title: t("pages.extract"), run: () => a().extract() },
      { id: "pdf.split", title: t("pages.split"), run: () => a().split() },
      { id: "pdf.merge", title: t("pages.merge"), run: () => a().merge() },
      { id: "pdf.exportPng", title: t("pages.exportPng"), run: () => a().exportPng() },
    ]);
  }, [registerCommands, t]);

  useEffect(() => {
    const items = [
      {
        id: "pdf-page",
        text: t("status.page", { page: Math.min(current, pageCount), count: pageCount }),
      },
      { id: "pdf-zoom", text: t("status.zoom", { pct }) },
    ];
    if (pending.length > 0) {
      items.push({ id: "pdf-pending", text: t("status.pending", { count: pending.length }) });
    }
    setStatus(items);
  }, [current, pageCount, pct, pending.length, setStatus, t]);

  const pendingByPage = useMemo(() => {
    const map = new Map<number, PdfAnnotation[]>();
    for (const a of pending) map.set(a.page, [...(map.get(a.page) ?? []), a]);
    return map;
  }, [pending]);

  // --- Rendu ---
  const hasSelection = selected.length > 0;
  const pagesMenu: MenuItem[] = [
    {
      id: "rl",
      label: t("pages.rotateLeft"),
      disabled: !hasSelection,
      onSelect: () => actions.current.rotatePages(270),
    },
    {
      id: "rr",
      label: t("pages.rotateRight"),
      disabled: !hasSelection,
      onSelect: () => actions.current.rotatePages(90),
    },
    {
      id: "del",
      label: t("pages.delete"),
      disabled: !hasSelection,
      onSelect: () => actions.current.remove(),
    },
    {
      id: "up",
      label: t("pages.moveUp"),
      disabled: !hasSelection,
      onSelect: () => moveSelection(-1),
    },
    {
      id: "down",
      label: t("pages.moveDown"),
      disabled: !hasSelection,
      onSelect: () => moveSelection(1),
    },
    { id: "sep", label: "", separator: true },
    {
      id: "ext",
      label: t("pages.extract"),
      disabled: !hasSelection,
      onSelect: () => actions.current.extract(),
    },
    { id: "split", label: t("pages.split"), onSelect: () => actions.current.split() },
    { id: "merge", label: t("pages.merge"), onSelect: () => actions.current.merge() },
    { id: "sep2", label: "", separator: true },
    { id: "png", label: t("pages.exportPng"), onSelect: () => actions.current.exportPng() },
  ];

  if (model.encrypted) {
    return (
      <div className={styles.message} role="alert">
        {t("encrypted")}
      </div>
    );
  }
  if (doc.failed) {
    return (
      <div className={styles.message} role="alert">
        {t("loadError")}
      </div>
    );
  }

  const zoomValue = zoom.mode === "custom" ? String(pct) : zoom.mode;
  const busy = ops.busy;
  const shownPage = Math.min(current, pageCount);

  return (
    <div className={styles.root} aria-busy={busy || doc.loading}>
      <EditorToolbar>
        <div className={styles.toolbar} role="group" aria-label={t("toolbar.label")}>
          <label className={styles.pageNav}>
            <span className={styles.srOnly}>{t("toolbar.page")}</span>
            <input
              ref={pageInputRef}
              className={styles.pageInput}
              inputMode="numeric"
              value={pageText ?? String(shownPage)}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setPageText(e.target.value)}
              onBlur={() => setPageText(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const n = Number(pageText ?? shownPage);
                  if (Number.isFinite(n)) goToPage(n);
                  setPageText(null);
                  e.currentTarget.blur();
                }
              }}
            />
            <span>/ {pageCount}</span>
          </label>
          <Button
            variant="ghost"
            aria-label={t("commands.zoomOut")}
            title={t("commands.zoomOut")}
            onClick={() => actions.current.zoomBy(0.8)}
          >
            −
          </Button>
          <select
            className={styles.select}
            aria-label={t("toolbar.zoom")}
            value={zoomValue}
            onChange={(e) => {
              const v = e.target.value;
              setZoom(
                v === "width" || v === "page" ? { mode: v } : { mode: "custom", pct: Number(v) },
              );
            }}
          >
            <option value="width">{t("toolbar.fitWidth")}</option>
            <option value="page">{t("toolbar.fitPage")}</option>
            {zoom.mode !== "custom" || ZOOM_PRESETS.includes(pct) ? null : (
              <option value={String(pct)}>{pct} %</option>
            )}
            {ZOOM_PRESETS.map((z) => (
              <option key={z} value={String(z)}>
                {z} %
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            aria-label={t("commands.zoomIn")}
            title={t("commands.zoomIn")}
            onClick={() => actions.current.zoomBy(1.25)}
          >
            +
          </Button>
          <Button variant="ghost" onClick={() => setRotation((r) => (r + 90) % 360)}>
            {t("commands.rotateView")}
          </Button>
          <Button
            variant="ghost"
            aria-pressed={search.open}
            onClick={() => search.setOpen(!search.open)}
          >
            {t("toolbar.search")}
          </Button>
          <span className={styles.sep} />
          {TOOLS.map((id) => (
            <Button
              key={id}
              data-testid={`pdf-tool-${id}`}
              variant={tool === id ? "primary" : "ghost"}
              aria-pressed={tool === id}
              onClick={() => {
                setTool(id);
                if (id !== "select") setColor(DEFAULT_COLORS[id]);
              }}
            >
              {t(`tools.${id}`)}
            </Button>
          ))}
          <label className={styles.colorLabel}>
            <span className={styles.srOnly}>{t("tools.color")}</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <span className={styles.sep} />
          <Menu label={t("pages.menu")} icon="file" items={pagesMenu} disabled={busy || !pdf} />
          {pending.length > 0 && (
            <Button variant="primary" disabled={busy} onClick={() => void saveAnnotations()}>
              {t("annotate.saveButton")} ({pending.length})
            </Button>
          )}
        </div>
      </EditorToolbar>

      <EditorSidePanel title={t("sidebar.title")} side="left">
        <div role="tablist" aria-label={t("sidebar.title")} className={styles.tabs}>
          {(["thumbs", "outline", "annotations"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={sideTab === id}
              className={styles.tab}
              onClick={() => setSideTab(id)}
            >
              {t(`sidebar.${id}`)}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {pdf && sideTab === "thumbs" && (
            <Thumbnails
              key={generation}
              pdf={pdf}
              infos={infos}
              selected={selected}
              current={Math.min(current, pageCount)}
              onSelect={onSelectThumb}
              onContextMenu={(e: MouseEvent, page) => {
                if (!selected.includes(page)) setSelected([page]);
                setMenu({ x: e.clientX, y: e.clientY });
              }}
              onDropReorder={(pages, at) => void dropReorder(pages, at)}
            />
          )}
          {pdf && sideTab === "outline" && <OutlinePanel pdf={pdf} onGoto={goToPage} />}
          {sideTab === "annotations" && (
            <AnnotationsPanel
              existing={existing}
              pending={pending}
              onGoto={goToPage}
              onRemovePending={(i) => setPending((p) => p.filter((_, k) => k !== i))}
            />
          )}
        </div>
      </EditorSidePanel>

      {search.open && (
        <form
          className={styles.searchBar}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            search.step(1);
          }}
        >
          <input
            autoFocus
            className={styles.searchInput}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") search.setOpen(false);
              else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                search.step(-1);
              }
            }}
          />
          <span className={styles.searchCount} aria-live="polite">
            {search.query === ""
              ? ""
              : search.results.total === 0
                ? search.searching
                  ? t("search.searching")
                  : t("search.none")
                : t("search.count", {
                    current: search.position,
                    total: search.results.total,
                  }) + (search.searching ? " …" : "")}
          </span>
          <Button
            variant="ghost"
            onClick={() => search.step(-1)}
            disabled={search.results.total === 0}
          >
            {t("search.prev")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => search.step(1)}
            disabled={search.results.total === 0}
          >
            {t("search.next")}
          </Button>
          <Button variant="ghost" onClick={() => search.setOpen(false)}>
            {t("search.close")}
          </Button>
        </form>
      )}

      <div
        ref={scrollerRef}
        className={styles.scroller}
        tabIndex={0}
        aria-label={t("viewer.label")}
        onScroll={onScroll}
        onMouseUp={highlightSelection}
        onKeyDown={(e) => {
          if (e.key === "Escape" && tool !== "select") setTool("select");
        }}
      >
        {pdf && (
          <div
            className={styles.inner}
            style={{ height: virtualizer.getTotalSize(), width: Math.max(maxWidth + 2 * PAD, 0) }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const page = v.index + 1;
              const g = geoms[v.index];
              if (!g) return null;
              return (
                <div
                  key={`${generation}-${v.key}`}
                  className={styles.slot}
                  style={{ transform: `translateY(${v.start}px)`, height: v.size - GAP }}
                >
                  <PageView
                    pdf={pdf}
                    pageNumber={page}
                    geometry={g}
                    tool={tool}
                    strokeColor={color}
                    pending={pendingByPage.get(page) ?? NONE}
                    matches={search.results.byPage.get(page) ?? NO_MATCHES}
                    currentMatch={search.cur?.page === page ? search.cur.index : null}
                    onDraft={onDraft}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("pages.menu")}
          items={pagesMenu}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.kind === "ranges" && (
        <RangesDialog
          pageCount={pageCount}
          onCancel={() => setDialog(null)}
          onSubmit={(ranges) => {
            setDialog(null);
            void ops.split(ranges);
          }}
        />
      )}
      {dialog?.kind === "merge" && path && (
        <MergeDialog
          current={path}
          onCancel={() => setDialog(null)}
          onSubmit={(choice) => {
            setDialog(null);
            void ops.merge(choice);
          }}
        />
      )}
      {dialog?.kind === "text" && (
        <TextPromptDialog
          title={t(dialog.mode === "note" ? "text.noteTitle" : "text.freeTextTitle")}
          label={t("text.label")}
          submitLabel={t("text.add")}
          multiline
          onCancel={() => setDialog(null)}
          onSubmit={(text) => submitText(dialog, text)}
        />
      )}
    </div>
  );
}

const NONE: PdfAnnotation[] = [];
const NO_MATCHES: TextMatch[] = [];
