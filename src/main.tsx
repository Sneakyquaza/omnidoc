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

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
