import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import styles from "./Toolbar.module.css";

interface PopoverProps {
  label: string;
  /** Contenu du bouton déclencheur (déjà traduit / symbole). */
  trigger: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  children: (close: () => void) => ReactNode;
}

/** Bouton de barre d'outils ouvrant un petit panneau (Échap / clic extérieur pour fermer). */
export function Popover({ label, trigger, disabled, pressed, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      className={styles.popoverRoot}
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.tool}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} className={styles.popover}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
