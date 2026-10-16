import type { ReactNode } from "react";
import styles from "./ToolBar.module.css";

/** Barre d'outils d'éditeur : groupes séparés par un filet fin, retour à la ligne propre. */
export function ToolBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.bar} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export function ToolGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={styles.group} role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}
