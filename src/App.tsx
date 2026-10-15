import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "./ipc/bindings";
import type { Detected } from "./ipc/bindings";

export default function App() {
  const { t } = useTranslation();
  const [detected, setDetected] = useState<Detected | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onOpen() {
    setError(null);
    try {
      const path = await open({ multiple: false });
      if (typeof path === "string") {
        setDetected(await commands.detectFile(path));
      }
    } catch (e) {
      setError(JSON.stringify(e));
    }
  }

  return (
    <main className="app">
      <h1>{t("app.title")}</h1>
      <button onClick={() => void onOpen()}>{t("app.openFile")}</button>
      {error && <pre role="alert">{error}</pre>}
      {detected && <pre>{JSON.stringify(detected, null, 2)}</pre>}
    </main>
  );
}
