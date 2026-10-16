import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles/tokens.css";
import "./styles/global.css";

// Build E2E (VITE_E2E=1) : capture des erreurs d'exécution, lues par les tests WebDriver.
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  const errors: string[] = [];
  (window as unknown as { __omnidocErrors: string[] }).__omnidocErrors = errors;
  window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
  document.addEventListener("securitypolicyviolation", (e) =>
    errors.push(`csp: ${e.violatedDirective} ${e.blockedURI}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    errors.push(`unhandledrejection: ${String(e.reason)}`),
  );
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(`console.error: ${args.map(String).join(" ")}`);
    original(...args);
  };
}

// Mesures de performance lues par tests/e2e/specs/perf.e2e.ts (build E2E uniquement).
if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
  const perf = {
    timeOrigin: performance.timeOrigin,
    shellMs: -1,
    editorMs: -1,
    maxFrameMs: 0,
    longFrames: [] as number[],
  };
  (window as unknown as { __omnidocPerf: typeof perf }).__omnidocPerf = perf;
  let last = performance.now();
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    if (gap > perf.maxFrameMs) perf.maxFrameMs = gap;
    if (gap > 200) perf.longFrames.push(Math.round(gap));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const observer = new MutationObserver(() => {
    const now = performance.now();
    if (perf.shellMs < 0 && document.getElementById("root")?.firstElementChild) perf.shellMs = now;
    if (perf.editorMs < 0 && document.querySelector('[data-testid^="editor-"]'))
      perf.editorMs = now;
    if (perf.shellMs >= 0 && perf.editorMs >= 0) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
