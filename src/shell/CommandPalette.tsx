import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useUi } from "../stores/ui";
import { useShellCommands } from "./commands";
import { fuzzyFilter } from "./fuzzy";
import { formatShortcut } from "./shortcuts";
import styles from "./CommandPalette.module.css";

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const { t } = useTranslation();
  const setOpen = useUi((s) => s.setPaletteOpen);
  const { all } = useShellCommands();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () =>
      fuzzyFilter(
        all.filter((c) => !c.hidden),
        query,
        (c) => c.title,
      ),
    [all, query],
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  function run(i: number) {
    const cmd = results[i];
    if (!cmd) return;
    setOpen(false);
    // après fermeture, pour que le focus soit rendu avant l'action
    setTimeout(() => cmd.run(), 0);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, results.length - 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter") run(index);
    else if (e.key === "Escape") setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div className={styles.overlay} onMouseDown={() => setOpen(false)}>
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className={styles.input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
          aria-label={t("palette.placeholder")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        <ul id="palette-list" ref={listRef} role="listbox" className={styles.list}>
          {results.map((cmd, i) => (
            <li
              key={cmd.id}
              id={`palette-${cmd.id}`}
              role="option"
              aria-selected={i === index}
              className={`${styles.option} ${i === index ? styles.selected : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(i)}
            >
              <span>{cmd.title}</span>
              {cmd.shortcut && <kbd className={styles.kbd}>{formatShortcut(cmd.shortcut)}</kbd>}
            </li>
          ))}
          {results.length === 0 && <li className={styles.none}>{t("palette.noResult")}</li>}
        </ul>
      </div>
    </div>
  );
}
