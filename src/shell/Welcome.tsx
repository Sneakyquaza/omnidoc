import { useTranslation } from "react-i18next";
import { useRecent } from "../stores/recent";
import { useUi } from "../stores/ui";
import { newDocument, openRecent, openWithDialog } from "./documents";
import { NEW_DOCUMENTS } from "./newDocuments";
import { basename } from "./paths";
import { Button, IconButton } from "./ui/Button";
import { Icon } from "./ui/icons";
import type { IconName } from "./ui/icons";
import styles from "./Welcome.module.css";

const NEW_ICONS: Record<string, IconName> = {
  text: "text",
  rich: "richText",
  sheet: "sheet",
  markdown: "hash",
  json: "braces",
};

export function Welcome() {
  const { t } = useTranslation();
  const recent = useRecent((s) => s.paths);
  const removeRecent = useRecent((s) => s.remove);
  const dragging = useUi((s) => s.dragging);

  return (
    <div className={styles.page} data-testid="welcome">
      <div className={styles.content}>
        <header className={styles.header}>
          <img src="/icon.svg" alt="" className={styles.logo} />
          <div>
            <h1 className={styles.title}>{t("app.title")}</h1>
            <p className={styles.subtitle}>{t("welcome.subtitle")}</p>
          </div>
        </header>

        <div className={`${styles.drop} ${dragging ? styles.dropActive : ""}`}>
          <span className={styles.dropIcon}>
            <Icon name="upload" size={22} />
          </span>
          <span className={styles.dropText}>{t("welcome.drop")}</span>
          <Button variant="primary" icon="open" onClick={() => void openWithDialog()}>
            {t("welcome.open")}
          </Button>
        </div>

        <section aria-labelledby="welcome-new">
          <h2 id="welcome-new">{t("welcome.new")}</h2>
          <ul className={styles.cards}>
            {NEW_DOCUMENTS.map((k) => (
              <li key={k.id}>
                <button
                  type="button"
                  className={styles.card}
                  data-testid="welcome-new"
                  onClick={() => newDocument(k.id)}
                >
                  <span className={styles.cardIcon}>
                    <Icon name={NEW_ICONS[k.id] ?? "newFile"} size={20} />
                  </span>
                  <span>{t(k.labelKey)}</span>
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
                    onClick={() => void openRecent(path)}
                  >
                    <span className={styles.recentName}>{basename(path)}</span>
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
