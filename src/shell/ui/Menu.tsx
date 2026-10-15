import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import styles from "./Menu.module.css";

export interface MenuItem {
  id: string;
  label: string;
  onSelect?(): void;
  disabled?: boolean;
  /** Titre de groupe non cliquable. */
  heading?: boolean;
  separator?: boolean;
}

interface MenuProps {
  label: string;
  icon: IconName;
  items: MenuItem[];
  disabled?: boolean;
}

export function Menu({ label, icon, items, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    popupRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    const buttons = Array.from(
      popupRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") focus(index + 1);
    else if (e.key === "ArrowUp") focus(index - 1);
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(-1);
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      triggerRef.current?.focus();
      if (e.key === "Escape") e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={icon} />
        <span className={styles.label}>{label}</span>
      </button>
      {open && (
        <div
          id={id}
          ref={popupRef}
          role="menu"
          aria-label={label}
          className={styles.popup}
          onKeyDown={onKeyDown}
        >
          {items.map((item) =>
            item.separator ? (
              <div key={item.id} role="separator" className={styles.separator} />
            ) : item.heading ? (
              <div key={item.id} className={styles.heading} role="presentation">
                {item.label}
              </div>
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={styles.item}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
