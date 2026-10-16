import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const fixtures = path.join(here, "fixtures");
// OMNIDOC_E2E_APP : binaire à tester (ex. build release pour les mesures de performance).
const application =
  process.env.OMNIDOC_E2E_APP ??
  path.join(
    root,
    "src-tauri/target/debug",
    process.platform === "win32" ? "omnidoc.exe" : "omnidoc",
  );

// Dossier de travail : copies des fixtures (les parcours modifient les fichiers)
// + profil isolé (données d'appli, préférences, récupération).
// Les workers rechargent ce fichier : le dossier est créé une fois (lanceur) puis partagé par l'env.
const work = process.env.OMNIDOC_E2E_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), "omnidoc-e2e-"));
process.env.OMNIDOC_E2E_WORK = work;
process.env.XDG_DATA_HOME = path.join(work, "xdg-data");
process.env.XDG_CONFIG_HOME = path.join(work, "xdg-config");
process.env.XDG_CACHE_HOME = path.join(work, "xdg-cache");

/** Parcours : [spec, fixture source]. */
const journeys: Array<[string, string]> = [
  ["text.journey.ts", "sample.txt"],
  ["docx.journey.ts", "sample.docx"],
  ["csv.journey.ts", "sample.csv"],
  ["image.journey.ts", "sample.png"],
  ["sheet.journey.ts", "sample.xlsx"],
  ["pdf.journey.ts", "sample.pdf"],
  ["archive.journey.ts", "sample.zip"],
  ["sqlite.journey.ts", "sample.sqlite"],
  ["records.journey.ts", "sample.vcf"],
  ["richtext.journey.ts", "sample.docx"],
  ["markdown.journey.ts", "sample.md"],
  ["search.journey.ts", "sample.txt"],
  ["prefs.journey.ts", "sample.txt"],
  ["shell.journey.ts", "sample.docx"],
];

/** Formats inscriptibles testés par save.e2e.ts (les autres sont en lecture seule). */
const writable = [
  "txt",
  "py",
  "json",
  "yaml",
  "md",
  "html",
  "docx",
  "odt",
  "csv",
  "xlsx",
  "ods",
  "ics",
  "vcf",
  "wav",
  "mp3",
];

function copyToWork(name: string, prefix: string): string {
  const dest = path.join(work, `${prefix}-${name}`);
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(fixtures, name), dest);
  return dest;
}

function capability(file: string, spec: string) {
  return {
    browserName: "wry",
    "wdio:enforceWebDriverClassic": true,
    "wdio:maxInstances": 1,
    "wdio:specs": [path.join(here, "specs", spec)],
    "tauri:options": { application, args: [file] },
  };
}

// E2E_DRIVER_PORT : port de tauri-driver (le driver natif utilise le suivant) ; évite les conflits
// entre plusieurs exécutions simultanées.
const port = Number(process.env.E2E_DRIVER_PORT ?? 4444);

// E2E_ONLY=regex : ne garde que les sessions dont le fichier correspond (débogage).
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

// E2E_PERF=1 : uniquement les mesures de performance (gros fichiers générés, non commités).
const perfDir = path.join(here, "fixtures-perf");
if (process.env.E2E_PERF) {
  const gen = spawnSync("python3", ["-I", path.join(here, "perf", "generate.py"), perfDir], {
    stdio: "inherit",
  });
  if (gen.status !== 0) throw new Error("génération des fixtures de performance échouée");
}
const perfCapabilities = process.env.E2E_PERF
  ? [
      capability("", "perf.e2e.ts"), // démarrage à vide
      ...fs
        .readdirSync(perfDir)
        .sort()
        .map((name) => capability(path.join(perfDir, name), "perf.e2e.ts")),
    ]
  : [];

const capabilities = [
  ...perfCapabilities,
  ...(process.env.E2E_PERF
    ? []
    : [
        ...fs
          .readdirSync(fixtures)
          .sort()
          .map((name) => capability(copyToWork(name, "open"), "open.e2e.ts")),
        ...writable.map((ext) => capability(copyToWork(`sample.${ext}`, "save"), "save.e2e.ts")),
        ...journeys.map(([spec, name]) =>
          capability(copyToWork(name, spec.split(".")[0] ?? "journey"), spec),
        ),
      ]),
].filter((c) => !only || only.test(c["tauri:options"].args[0] ?? ""));

let driver: ChildProcess | undefined;

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error("tauri-driver injoignable"));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port,
  path: "/",
  specs: [path.join(here, "specs", "*.ts")],
  maxInstances: 1,
  capabilities: capabilities as WebdriverIO.Capabilities[],
  logLevel: (process.env.WDIO_LOG as WebdriverIO.Config["logLevel"]) ?? "warn",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 150_000 },
  connectionRetryCount: 1,

  onPrepare: async () => {
    if (!fs.existsSync(application)) {
      throw new Error(`Binaire absent : ${application} (pnpm e2e:build)`);
    }
    const bin = fs.existsSync(path.join(os.homedir(), ".cargo/bin/tauri-driver"))
      ? path.join(os.homedir(), ".cargo/bin/tauri-driver")
      : "tauri-driver";
    driver = spawn(bin, ["--port", String(port), "--native-port", String(port + 1)], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForPort(port, 15_000);
  },
  onComplete: () => {
    driver?.kill();
    fs.rmSync(work, { recursive: true, force: true });
  },
};
