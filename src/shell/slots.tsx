import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "../stores/settings";
import styles from "./slots.module.css";

type Slot = "toolbar" | "left" | "right";

interface SlotsValue {
  elements: Record<Slot, HTMLElement | null>;
  setElement(slot: Slot, el: HTMLElement | null): void;
}

const SlotsContext = createContext<SlotsValue | null>(null);

/** Onglet dans lequel un éditeur est rendu (l'éditeur reste monté même inactif). */
const TabScopeContext = createContext<{ tabId: string; active: boolean }>({
  tabId: "",
  active: false,
});

export function TabScope({
  tabId,
  active,
  children,
}: {
  tabId: string;
  active: boolean;
  children: ReactNode;
}) {
  return <TabScopeContext.Provider value={{ tabId, active }}>{children}</TabScopeContext.Provider>;
}

export function SlotsProvider({ children }: { children: ReactNode }) {
  const [elements, setElements] = useState<Record<Slot, HTMLElement | null>>({
    toolbar: null,
    left: null,
    right: null,
  });
  const setElement = useCallback(
    (slot: Slot, el: HTMLElement | null) =>
      setElements((prev) => (prev[slot] === el ? prev : { ...prev, [slot]: el })),
    [],
  );
  const value = useMemo<SlotsValue>(() => ({ elements, setElement }), [elements, setElement]);
  return <SlotsContext.Provider value={value}>{children}</SlotsContext.Provider>;
}

/** Conteneur du shell vers lequel les éditeurs envoient leurs portails. */
export function SlotTarget({
  slot,
  className,
  label,
}: {
  slot: Slot;
  className?: string;
  label?: string;
}) {
  const setElement = useContext(SlotsContext)?.setElement;
  const ref = useCallback(
    (el: HTMLDivElement | null) => setElement?.(slot, el),
    [setElement, slot],
  );
  return <div className={className} ref={ref} aria-label={label} />;
}

function usePortalTarget(slot: Slot): HTMLElement | null {
  const ctx = useContext(SlotsContext);
  const { active } = useContext(TabScopeContext);
  return active ? (ctx?.elements[slot] ?? null) : null;
}

/** Toolbar contextuelle de l'éditeur (sous la toolbar globale). */
export function EditorToolbar({ children }: { children: ReactNode }) {
  const target = usePortalTarget("toolbar");
  return target ? createPortal(children, target) : null;
}

/** Panneau latéral repliable de l'éditeur. */
export function EditorSidePanel({
  title,
  side = "right",
  children,
}: {
  title: string;
  side?: "left" | "right";
  children: ReactNode;
}) {
  const target = usePortalTarget(side);
  const open = useSettings((s) => s.sidePanelOpen);
  if (!target || !open) return null;
  return createPortal(
    <section aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {children}
    </section>,
    target,
  );
}
