import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../ipc/bindings";
import type { ExternalTool } from "../ipc/bindings";
import { useTabs } from "../stores/tabs";
import { useUi } from "../stores/ui";
import { exportExternal, exportInternal, handlerLabel } from "./documents";
import { externalOptions, formatKeyOf, internalOptions } from "./exportOptions";
import type { ExportOption } from "./exportOptions";
import { useHandlers } from "./handlers";
import { extOf } from "./paths";
import { Button } from "./ui/Button";
import styles from "./ExportDialog.module.css";

const ENGINE_NAMES = { libreoffice: "LibreOffice", pandoc: "pandoc" } as const;

/** Dialogue « Exporter vers… » : cibles internes puis conversions par moteurs externes. */
export function ExportDialog() {
  const tabId = useUi((s) => s.exportTabId);
  return tabId ? <ExportBody tabId={tabId} /> : null;
}

function ExportBody({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const close = useUi((s) => s.setExportTabId);
  const tab = useTabs((s) => s.tabs.find((x) => x.id === tabId));
  const handlers = useHandlers();
  const [tools, setTools] = useState<ExternalTool[] | null>(null);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    commands
      .externalTools()
      .then((list) => alive && setTools(list))
      .catch(() => alive && setTools([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);

  if (!tab) return null;

  const internal = internalOptions(handlers, tab.capabilities?.exportTo ?? [], tab.modelKind);
  const external = tab.path && tools ? externalOptions(extOf(tab.path), tools) : [];

  const formatLabel = (ext: string): string => {
    const key = formatKeyOf(ext);
    return key ? t(key) : ext.toUpperCase();
  };

  function labelOf(o: ExportOption): string {
    if (o.kind === "internal") {
      const ext = o.handler.extensions[0];
      return ext ? `${handlerLabel(o.handler)} (.${ext})` : handlerLabel(o.handler);
    }
    return `${formatLabel(o.ext)} (.${o.ext})`;
  }

  function choose(o: ExportOption) {
    close(null);
    if (o.kind === "internal") void exportInternal(tabId, o.handler.id);
    else void exportExternal(tabId, o.tool, o.ext, formatLabel(o.ext));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(null);
    } else if (e.key === "Tab") {
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button") ?? []);
      const first = items[0];
      const last = items[items.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  const empty = internal.length === 0 && external.length === 0 && tools !== null;

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
          {t("export.title", { name: tab.title })}
        </h2>
        {internal.length > 0 && (
          <section aria-label={t("export.internal")}>
            <h3 className={styles.heading}>{t("export.internal")}</h3>
            <ul className={styles.list}>
              {internal.map((o) => (
                <li key={o.id}>
                  <button type="button" className={styles.item} onClick={() => choose(o)}>
                    {labelOf(o)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {external.length > 0 && (
          <section aria-label={t("export.external")}>
            <h3 className={styles.heading}>{t("export.external")}</h3>
            <ul className={styles.list}>
              {external.map((o) => (
                <li key={o.id}>
                  <button type="button" className={styles.item} onClick={() => choose(o)}>
                    <span>{labelOf(o)}</span>
                    <span className={styles.engine}>
                      {o.kind === "external" ? ENGINE_NAMES[o.engine] : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {tab.dirty && <p className={styles.hint}>{t("export.externalNeedsSave")}</p>}
          </section>
        )}
        {tools === null && <p className={styles.hint}>{t("export.detecting")}</p>}
        {empty && <p className={styles.hint}>{t("export.noTarget")}</p>}
        <div className={styles.actions}>
          <Button onClick={() => close(null)}>{t("common.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
