import { useTranslation } from "react-i18next";
import type { TabState } from "../editors/types";
import { reopenTabAs } from "./documents";
import { Button } from "./ui/Button";
import styles from "./NoEditor.module.css";

export function NoEditor({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  return (
    <div className={styles.box}>
      <p>{t("noEditor.message", { kind: tab.modelKind })}</p>
      {tab.path && (
        <Button variant="primary" onClick={() => void reopenTabAs(tab.id, "binary")}>
          {t("noEditor.openHex")}
        </Button>
      )}
    </div>
  );
}
