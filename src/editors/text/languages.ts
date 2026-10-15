import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";

/** Langages proposés dans le menu (identifiants du modèle `TextDoc.language`). */
export const LANGUAGES = [
  "plaintext",
  "python",
  "rust",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "c",
  "cpp",
  "csharp",
  "java",
  "kotlin",
  "go",
  "ruby",
  "php",
  "shell",
  "powershell",
  "batch",
  "css",
  "scss",
  "less",
  "html",
  "vue",
  "svelte",
  "sql",
  "lua",
  "r",
  "swift",
  "dart",
  "scala",
  "perl",
  "json",
  "yaml",
  "toml",
  "xml",
  "ini",
  "markdown",
  "dockerfile",
  "makefile",
] as const;

const stream = (p: StreamParser<unknown>): Extension => StreamLanguage.define(p);

/** Charge (import dynamique) la coloration d'un langage ; `[]` si aucune. */
export async function loadLanguage(id: string): Promise<Extension> {
  switch (id) {
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
        typescript: true,
      });
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "scss":
      return (await import("@codemirror/lang-sass")).sass({ indented: false });
    case "less":
      return (await import("@codemirror/lang-less")).less();
    case "html":
    case "svelte":
      return (await import("@codemirror/lang-html")).html();
    case "vue":
      return (await import("@codemirror/lang-vue")).vue();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "csharp":
      return stream((await import("@codemirror/legacy-modes/mode/clike")).csharp);
    case "kotlin":
      return stream((await import("@codemirror/legacy-modes/mode/clike")).kotlin);
    case "scala":
      return stream((await import("@codemirror/legacy-modes/mode/clike")).scala);
    case "dart":
      return stream((await import("@codemirror/legacy-modes/mode/clike")).dart);
    case "shell":
    case "makefile":
      return stream((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "powershell":
      return stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell);
    case "toml":
      return stream((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "ini":
      return stream((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "dockerfile":
      return stream((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "lua":
      return stream((await import("@codemirror/legacy-modes/mode/lua")).lua);
    case "r":
      return stream((await import("@codemirror/legacy-modes/mode/r")).r);
    case "swift":
      return stream((await import("@codemirror/legacy-modes/mode/swift")).swift);
    case "perl":
      return stream((await import("@codemirror/legacy-modes/mode/perl")).perl);
    case "ruby":
      return stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    default:
      // batch, plaintext, inconnu : pas de coloration
      return [];
  }
}
