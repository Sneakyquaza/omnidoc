import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "./Button";
import { closeDialog, useDialogs } from "./dialogStore";
import styles from "./Dialog.module.css";

/** Affiche le premier dialogue de la file (les suivants attendent). */
export function DialogHost() {
  const request = useDialogs((s) => s.queue[0]);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = ref.current?.querySelectorAll<HTMLElement>("button");
    // Dialogue destructif : focus initial sur Annuler, jamais sur le bouton dangereux.
    const lastIsDanger = request.actions[request.actions.length - 1]?.variant === "danger";
    const cancelAt = request.actions.findIndex((a) => a.id === "cancel");
    const index = lastIsDanger ? Math.max(cancelAt, 0) : (buttons?.length ?? 1) - 1;
    (buttons?.[index] ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, [request]);

  if (!request) return null;

  function onKeyDown(e: KeyboardEvent) {
    if (!request) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog(request, null);
    } else if (e.key === "Tab") {
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <div className={styles.overlay}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {request.title}
        </h2>
        {request.message && <p className={styles.message}>{request.message}</p>}
        <div className={styles.actions}>
          {request.actions.map((a) => (
            <Button
              key={a.id}
              variant={a.variant ?? "secondary"}
              onClick={() => closeDialog(request, a.id)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
