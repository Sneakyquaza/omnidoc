import { Component, createElement, lazy, Suspense, useMemo } from "react";
import type { ComponentType, ErrorInfo, ReactNode } from "react";
import { withTranslation } from "react-i18next";
import type { WithTranslation } from "react-i18next";
import { editors } from "../editors/registry";
import type { AnyEditorView, EditorProps } from "../editors/types";
import { useTabs } from "../stores/tabs";
import type { TabEntry } from "../stores/tabs";
import { NoEditor } from "./NoEditor";
import { registerSerializer, useRuntime } from "./runtime";
import { TabScope } from "./slots";
import styles from "./EditorHost.module.css";

const lazyCache = new WeakMap<AnyEditorView, ComponentType<EditorProps<unknown>>>();

function editorComponent(view: AnyEditorView): ComponentType<EditorProps<unknown>> {
  let component = lazyCache.get(view);
  if (!component) {
    component = lazy(view.load) as ComponentType<EditorProps<unknown>>;
    lazyCache.set(view, component);
  }
  return component;
}

class BoundaryBase extends Component<
  WithTranslation & { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className={styles.error} role="alert">
          <p>{this.props.t("editor.crashed")}</p>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
const Boundary = withTranslation()(BoundaryBase);

function TabEditor({ tab }: { tab: TabEntry }) {
  const view = editors[tab.modelKind];
  const id = tab.id;
  const api = useMemo(
    () => ({
      setDirty: (dirty: boolean) => useTabs.getState().setDirty(id, dirty),
      registerSerializer: (fn: () => unknown) => registerSerializer(id, fn),
      registerCommands: (cmds: Parameters<EditorProps<unknown>["registerCommands"]>[0]) =>
        useRuntime.getState().setCommands(id, cmds),
      setStatus: (items: Parameters<EditorProps<unknown>["setStatus"]>[0]) =>
        useRuntime.getState().setStatus(id, items),
    }),
    [id],
  );
  if (!view) return <NoEditor tab={tab} />;
  // createElement : le composant vient d'un cache de module, pas d'une création au rendu
  return createElement(editorComponent(view), {
    tab,
    model: tab.model,
    readOnly: tab.readOnly,
    ...api,
  });
}

/** Tous les éditeurs restent montés ; seul celui de l'onglet actif est visible. */
export function EditorHost() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  return (
    <>
      {tabs.map((tab) => (
        <TabScope key={tab.id} tabId={tab.id} active={tab.id === activeId}>
          <div
            className={styles.pane}
            style={{ display: tab.id === activeId ? undefined : "none" }}
            role="tabpanel"
            aria-label={tab.title}
          >
            <Boundary key={tab.reloadCount}>
              <Suspense fallback={<div className={styles.loading} />}>
                <TabEditor key={`${tab.id}-${tab.reloadCount}`} tab={tab} />
              </Suspense>
            </Boundary>
          </div>
        </TabScope>
      ))}
    </>
  );
}
