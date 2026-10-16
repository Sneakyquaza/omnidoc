import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "../stores/settings";
import styles from "./slots.module.css";

type Slot = "toolbar" | "left" | "right";

type Side = "left" | "right";

interface SlotsValue {
  elements: Record<Slot, HTMLElement | null>;
  setElement(slot: Slot, el: HTMLElement | null): void;
  /** Nombre de panneaux latéraux affichés par côté (`:has()` n'est pas fiable sous WebKitGTK). */
  panels: Record<Side, number>;
  adjustPanels(side: Side, delta: number): void;
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
  const [panels, setPanels] = useState<Record<Side, number>>({ left: 0, right: 0 });
  const adjustPanels = useCallback(
    (side: Side, delta: number) =>
      setPanels((prev) => ({ ...prev, [side]: Math.max(0, prev[side] + delta) })),
    [],
  );
  const value = useMemo<SlotsValue>(
    () => ({ elements, setElement, panels, adjustPanels }),
    [elements, setElement, panels, adjustPanels],
  );
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
  const adjustPanels = useContext(SlotsContext)?.adjustPanels;
  const shown = target !== null && open;
  useEffect(() => {
    if (!shown || !adjustPanels) return;
    adjustPanels(side, 1);
    return () => adjustPanels(side, -1);
  }, [shown, side, adjustPanels]);
  if (!shown) return null;
  return createPortal(
    <section aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {children}
    </section>,
    target,
  );
}

/** Colonne latérale du shell, masquée quand aucun éditeur n'y envoie de panneau. */
export function SidePanelColumn({
  side,
  className,
  label,
}: {
  side: Side;
  className?: string;
  label: string;
}) {
  const count = useContext(SlotsContext)?.panels[side] ?? 0;
  return (
    <aside className={className} hidden={count === 0} aria-label={label}>
      <SlotTarget slot={side} />
    </aside>
  );
}
