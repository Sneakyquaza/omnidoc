import { useTranslation } from "react-i18next";
import { useRecent } from "../stores/recent";
import { useUi } from "../stores/ui";
import { newDocument, openPath, openWithDialog } from "./documents";
import { NEW_DOCUMENTS } from "./newDocuments";
import { basename } from "./paths";
import { Button, IconButton } from "./ui/Button";
import styles from "./Welcome.module.css";

export function Welcome() {
  const { t } = useTranslation();
  const recent = useRecent((s) => s.paths);
  const removeRecent = useRecent((s) => s.remove);
  const dragging = useUi((s) => s.dragging);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>
        <img src="/icon.svg" alt="" className={styles.logo} />
        {t("app.title")}
      </h1>
      <p className={styles.subtitle}>{t("welcome.subtitle")}</p>

      <div className={`${styles.drop} ${dragging ? styles.dropActive : ""}`}>
        <Button variant="primary" icon="open" onClick={() => void openWithDialog()}>
          {t("welcome.open")}
        </Button>
        <span>{t("welcome.drop")}</span>
      </div>

      <div className={styles.columns}>
        <section aria-labelledby="welcome-new">
          <h2 id="welcome-new">{t("welcome.new")}</h2>
          <ul className={styles.list}>
            {NEW_DOCUMENTS.map((k) => (
              <li key={k.id}>
                <button type="button" className={styles.item} onClick={() => newDocument(k.id)}>
                  {t(k.labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="welcome-recent">
          <h2 id="welcome-recent">{t("welcome.recent")}</h2>
          {recent.length === 0 ? (
            <p className={styles.empty}>{t("welcome.noRecent")}</p>
          ) : (
            <ul className={styles.list}>
              {recent.map((path) => (
                <li key={path} className={styles.recent}>
                  <button
                    type="button"
                    className={styles.item}
                    title={path}
                    onClick={() => void openPath(path)}
                  >
                    <span>{basename(path)}</span>
                    <span className={styles.path}>{path}</span>
                  </button>
                  <IconButton
                    icon="close"
                    label={t("welcome.removeRecent", { name: basename(path) })}
                    onClick={() => removeRecent(path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
