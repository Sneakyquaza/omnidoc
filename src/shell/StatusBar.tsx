import { useTranslation } from "react-i18next";
import { useTabs } from "../stores/tabs";
import { useRuntime } from "./runtime";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((x) => x.id === s.activeId));
  const items = useRuntime((s) => (tab ? s.status[tab.id] : undefined));
  const editable = useRuntime((s) => (tab ? s.editable[tab.id] : undefined));
  if (!tab) return <footer className={styles.bar} />;

  const detected = tab.detected;
  const encoding = tab.model.kind === "text" ? tab.model.encoding : null;
  return (
    <footer className={styles.bar}>
      {detected && (
        <span
          title={detected.mime ?? undefined}
          data-testid="status-detected"
          data-handler={detected.handlerId}
        >
          {t(detected.labelKey, { defaultValue: detected.handlerId })}
        </span>
      )}
      {(editable === undefined ? tab.readOnly : !editable) && (
        <span className={styles.flag} data-testid="status-readonly">
          {t("status.readOnly")}
        </span>
      )}
      {tab.capabilities?.fidelity === "partial" && (
        <span className={styles.flag} title={t("status.partialFidelityHint")}>
          {t("status.partialFidelity")}
        </span>
      )}
      {(tab.path === null || tab.dirty) && (
        <span className={styles.flag}>{t("status.unsaved")}</span>
      )}
      {encoding && <span>{encoding}</span>}
      <span className={styles.spacer} />
      {items?.map((item) => (
        <span key={item.id} title={item.title}>
          {item.text}
        </span>
      ))}
    </footer>
  );
}
