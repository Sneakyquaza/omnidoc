import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { MenuItem } from "../../shell/ui/Menu";
import styles from "./ContextMenu.module.css";

/** Menu contextuel ancré à des coordonnées écran ; se ferme au clic extérieur ou Échap. */
export function ContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent) {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") focus(index + 1);
    else if (e.key === "ArrowUp") focus(index - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      onClose();
      if (e.key === "Escape") e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={styles.menu}
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) =>
        item.separator ? (
          <div key={item.id} role="separator" className={styles.separator} />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
