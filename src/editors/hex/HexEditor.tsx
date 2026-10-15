import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BinaryDoc } from "../../ipc/bindings";
import { readRange } from "../../ipc/bytes";
import { handlerLabel, reopenTabAs } from "../../shell/documents";
import { useHandlers } from "../../shell/handlers";
import { EditorSidePanel } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import type { EditorProps } from "../types";
import { BLOCK_SIZE, BlockCache } from "./blockCache";
import {
  asciiChar,
  describeValues,
  formatOffset,
  formatSize,
  hex,
  parseHexPattern,
  parseOffset,
  textPattern,
} from "./format";
import { searchForward } from "./search";
import styles from "./HexEditor.module.css";

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;

type Bar = "goto" | "find" | null;

export default function HexEditor({
  tab,
  model,
  registerCommands,
  setStatus,
}: EditorProps<BinaryDoc>) {
  const { t } = useTranslation("hex");
  const handlers = useHandlers();
  const path = tab.path;
  const size = model.size;
  const rows = Math.ceil(size / BYTES_PER_ROW);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const searchToken = useRef({ cancelled: false });
  const [, setVersion] = useState(0);
  const [selected, setSelected] = useState<number | null>(size > 0 ? 0 : null);
  const [match, setMatch] = useState<{ start: number; length: number } | null>(null);
  const [bar, setBar] = useState<Bar>(null);
  const [barText, setBarText] = useState("");
  const [findMode, setFindMode] = useState<"hex" | "text">("hex");
  const [message, setMessage] = useState("");
  const [searching, setSearching] = useState(false);

  const fetchBlock = useCallback(
    async (index: number) => {
      if (path === null) return new Uint8Array(0);
      const offset = index * BLOCK_SIZE;
      return new Uint8Array(await readRange(path, offset, Math.min(BLOCK_SIZE, size - offset)));
    },
    [path, size],
  );
  const [cache] = useState(() => new BlockCache(fetchBlock, 64, () => setVersion((v) => v + 1)));

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  const firstRow = items[0]?.index ?? 0;
  const lastRow = items[items.length - 1]?.index ?? 0;

  // Chargement des blocs visibles
  useEffect(() => {
    if (size === 0) return;
    const from = Math.floor((firstRow * BYTES_PER_ROW) / BLOCK_SIZE);
    const to = Math.floor((lastRow * BYTES_PER_ROW) / BLOCK_SIZE);
    for (let b = from; b <= to; b++) {
      if (!cache.peek(b)) cache.load(b).catch(() => setMessage(t("loadError")));
    }
  }, [cache, firstRow, lastRow, size, t]);

  const byteAt = useCallback(
    (offset: number): number | undefined => {
      if (offset < 0 || offset >= size) return undefined;
      return cache.get(Math.floor(offset / BLOCK_SIZE))?.[offset % BLOCK_SIZE];
    },
    [cache, size],
  );

  const select = useCallback(
    (offset: number) => {
      if (size === 0) return;
      const clamped = Math.max(0, Math.min(size - 1, offset));
      setSelected(clamped);
      virtualizer.scrollToIndex(Math.floor(clamped / BYTES_PER_ROW), { align: "auto" });
    },
    [size, virtualizer],
  );

  // Barre d'état : offset, taille, valeurs
  const loadedValue = selected === null ? null : byteAt(selected);
  useEffect(() => {
    const items = [
      { id: "hex-size", text: t("status.size", { size: formatSize(size), bytes: size }) },
    ];
    if (selected !== null) {
      items.unshift({
        id: "hex-offset",
        text: t("status.offset", { hex: formatOffset(selected), dec: selected }),
      });
      const v = describeValues(byteAt, selected);
      if (v) {
        const parts = [`u8 ${v.u8}`, `i8 ${v.i8}`];
        if (v.u16 !== undefined) parts.push(`u16 ${v.u16}`);
        if (v.u32 !== undefined) parts.push(`u32 ${v.u32}`);
        items.push({ id: "hex-value", text: parts.join(" · ") });
      }
    }
    setStatus(items);
  }, [selected, loadedValue, size, byteAt, setStatus, t]);

  const openBar = useCallback((kind: Exclude<Bar, null>) => {
    setBar(kind);
    setMessage("");
    setTimeout(() => barInputRef.current?.select(), 0);
  }, []);

  useEffect(() => {
    registerCommands([
      { id: "hex.goto", title: t("commands.goto"), shortcut: "Mod+G", run: () => openBar("goto") },
      { id: "hex.find", title: t("commands.find"), shortcut: "Mod+F", run: () => openBar("find") },
    ]);
  }, [registerCommands, openBar, t]);

  function closeBar() {
    searchToken.current.cancelled = true;
    setBar(null);
    setSearching(false);
    scrollerRef.current?.focus();
  }

  async function findNext() {
    const pattern = findMode === "hex" ? parseHexPattern(barText) : textPattern(barText);
    if (!pattern) {
      setMessage(t("find.invalid"));
      return;
    }
    const token = { cancelled: false };
    searchToken.current = token;
    setSearching(true);
    setMessage(t("find.searching"));
    const getBlock = async (i: number) => cache.peek(i) ?? fetchBlock(i);
    const run = (start: number) =>
      searchForward({ size, start, pattern, getBlock, isCancelled: () => token.cancelled });
    try {
      const start = selected === null ? 0 : selected + 1;
      let result = await run(start);
      let wrapped = false;
      if (result.found === null && !result.truncated && start > 0 && !token.cancelled) {
        result = await run(0);
        wrapped = true;
      }
      if (token.cancelled) return;
      if (result.found !== null) {
        setMatch({ start: result.found, length: pattern.length });
        select(result.found);
        setMessage(wrapped ? t("find.wrapped") : "");
      } else {
        setMessage(result.truncated ? t("find.limit") : t("find.notFound"));
      }
    } catch {
      setMessage(t("loadError"));
    } finally {
      if (!token.cancelled) setSearching(false);
    }
  }

  function onBarSubmit(e: FormEvent) {
    e.preventDefault();
    if (bar === "goto") {
      const offset = parseOffset(barText);
      if (offset === null || offset >= size) {
        setMessage(t("goto.invalid", { max: size > 0 ? formatOffset(size - 1) : "0" }));
        return;
      }
      setMatch(null);
      select(offset);
      closeBar();
    } else {
      void findNext();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (selected === null || e.ctrlKey || e.metaKey || e.altKey) return;
    const page =
      Math.max(1, Math.floor((scrollerRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1) *
      BYTES_PER_ROW;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = selected + 1;
        break;
      case "ArrowLeft":
        next = selected - 1;
        break;
      case "ArrowDown":
        next = selected + BYTES_PER_ROW;
        break;
      case "ArrowUp":
        next = selected - BYTES_PER_ROW;
        break;
      case "PageDown":
        next = selected + page;
        break;
      case "PageUp":
        next = selected - page;
        break;
      case "Home":
        next = selected - (selected % BYTES_PER_ROW);
        break;
      case "End":
        next = selected - (selected % BYTES_PER_ROW) + BYTES_PER_ROW - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    select(next);
  }

  function onClick(e: MouseEvent) {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
    if (cell?.dataset.o) select(Number(cell.dataset.o));
    scrollerRef.current?.focus();
  }

  const inMatch = (o: number) =>
    match !== null && o >= match.start && o < match.start + match.length;

  return (
    <div className={styles.root}>
      <EditorSidePanel title={t("info.title")}>
        <dl className={styles.info}>
          <dt>{t("info.path")}</dt>
          <dd>{tab.path ?? "—"}</dd>
          <dt>{t("info.type")}</dt>
          <dd>
            {tab.detected
              ? t(tab.detected.labelKey, { ns: "common", defaultValue: tab.handlerId })
              : "—"}
          </dd>
          <dt>{t("info.mime")}</dt>
          <dd>{tab.detected?.mime ?? "—"}</dd>
          <dt>{t("info.size")}</dt>
          <dd>{t("status.size", { size: formatSize(size), bytes: size })}</dd>
        </dl>
        {tab.path && tab.detected && tab.detected.alternatives.length > 0 && (
          <>
            <h3 className={styles.subtitle}>{t("info.alternatives")}</h3>
            <ul className={styles.alternatives}>
              {tab.detected.alternatives.map((id) => {
                const handler = handlers.find((h) => h.id === id);
                const name = handler ? handlerLabel(handler) : id;
                return (
                  <li key={id}>
                    <Button onClick={() => void reopenTabAs(tab.id, id)}>
                      {t("info.openAs", { name })}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </EditorSidePanel>

      {bar && (
        <form
          className={styles.bar}
          onSubmit={onBarSubmit}
          onKeyDown={(e) => e.key === "Escape" && closeBar()}
        >
          <label>
            <span className={styles.barLabel}>
              {bar === "goto" ? t("goto.label") : t("find.label")}
            </span>
            <input
              ref={barInputRef}
              autoFocus
              className={styles.input}
              value={barText}
              placeholder={bar === "goto" ? t("goto.placeholder") : t("find.placeholder")}
              onChange={(e) => setBarText(e.target.value)}
            />
          </label>
          {bar === "find" && (
            <select
              className={styles.input}
              aria-label={t("find.mode")}
              value={findMode}
              onChange={(e) => setFindMode(e.target.value as "hex" | "text")}
            >
              <option value="hex">{t("find.hex")}</option>
              <option value="text">{t("find.text")}</option>
            </select>
          )}
          <Button type="submit" variant="primary" disabled={searching}>
            {bar === "goto" ? t("goto.go") : t("find.next")}
          </Button>
          <Button onClick={closeBar}>{t("bar.close")}</Button>
          <span role="status" className={styles.message}>
            {message}
          </span>
        </form>
      )}

      <div className={styles.header} aria-hidden="true">
        <span className={styles.offset}>{t("columns.offset")}</span>
        <span className={styles.bytes}>
          {Array.from({ length: BYTES_PER_ROW }, (_, i) => (
            <span key={i} className={`${styles.byte} ${i === 7 ? styles.gap : ""}`}>
              {hex(i)}
            </span>
          ))}
        </span>
        <span>{t("columns.ascii")}</span>
      </div>

      {size === 0 ? (
        <p className={styles.empty}>{t("empty")}</p>
      ) : (
        <div
          ref={scrollerRef}
          className={styles.scroller}
          tabIndex={0}
          role="grid"
          aria-label={t("grid.label")}
          aria-rowcount={rows}
          onKeyDown={onKeyDown}
          onClick={onClick}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const rowStart = vi.index * BYTES_PER_ROW;
              const block = cache.get(Math.floor(rowStart / BLOCK_SIZE));
              const base = Math.floor(rowStart / BLOCK_SIZE) * BLOCK_SIZE;
              const cells = Array.from({ length: BYTES_PER_ROW }, (_, c) => {
                const o = rowStart + c;
                if (o >= size) return null;
                return { o, c, b: block?.[o - base] };
              });
              return (
                <div
                  key={vi.key}
                  role="row"
                  aria-rowindex={vi.index + 1}
                  className={styles.row}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <span role="rowheader" className={styles.offset}>
                    {hex(rowStart, 8)}
                  </span>
                  <span className={styles.bytes}>
                    {cells.map((cell, c) =>
                      cell ? (
                        <span
                          key={c}
                          role="gridcell"
                          data-o={cell.o}
                          aria-selected={cell.o === selected}
                          className={`${styles.byte} ${c === 7 ? styles.gap : ""} ${cell.o === selected ? styles.selected : ""} ${inMatch(cell.o) ? styles.match : ""}`}
                        >
                          {cell.b === undefined ? "··" : hex(cell.b)}
                        </span>
                      ) : (
                        <span key={c} className={`${styles.byte} ${c === 7 ? styles.gap : ""}`} />
                      ),
                    )}
                  </span>
                  <span className={styles.ascii}>
                    {cells.map(
                      (cell, c) =>
                        cell && (
                          <span
                            key={c}
                            data-o={cell.o}
                            className={`${cell.o === selected ? styles.selected : ""} ${inMatch(cell.o) ? styles.match : ""}`}
                          >
                            {cell.b === undefined ? "·" : asciiChar(cell.b)}
                          </span>
                        ),
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
