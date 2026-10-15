import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";
import { useToasts } from "./toastStore";
import styles from "./Toast.module.css";

export function ToastHost() {
  const { t } = useTranslation();
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${styles[toast.kind]}`}
          role={toast.kind === "error" ? "alert" : undefined}
        >
          <div className={styles.body}>
            <div>{toast.text}</div>
            {toast.detail && <div className={styles.detail}>{toast.detail}</div>}
          </div>
          <IconButton icon="close" label={t("common.close")} onClick={() => dismiss(toast.id)} />
        </div>
      ))}
    </div>
  );
}
