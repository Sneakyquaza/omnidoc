import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderedProblem } from "../helpers";

// Mesures de performance (E2E_PERF=1), non bloquantes : seuils larges, temps journalisés.
// Résultats ajoutés à OMNIDOC_PERF_OUT (JSON lines) s'il est défini.

const KINDS: Record<string, string> = {
  rs: "text",
  csv: "sheet",
  json: "text",
  bin: "binary",
  pdf: "pdf",
  png: "image",
  zip: "archive",
  sqlite: "database",
  xlsx: "sheet",
};

interface PagePerf {
  timeOrigin: number;
  shellMs: number;
  editorMs: number;
  maxFrameMs: number;
  longFrames: number[];
}

/** Démarrage du processus (epoch ms) d'après /proc ; `null` hors Linux. */
function processStartMs(application: string): number | null {
  try {
    const pid = execFileSync("pgrep", ["-n", "-f", `^${application}`])
      .toString()
      .trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Date.now() - uptime * 1000 + (ticks * 1000) / 100;
  } catch {
    return null;
  }
}

function record(entry: Record<string, unknown>): void {
  console.log(`PERF ${JSON.stringify(entry)}`);
  if (process.env.OMNIDOC_PERF_OUT) {
    fs.appendFileSync(process.env.OMNIDOC_PERF_OUT, `${JSON.stringify(entry)}\n`);
  }
}

describe("performance", () => {
  const caps = browser.requestedCapabilities as {
    "tauri:options"?: { application?: string; args?: string[] };
  };
  const application = caps["tauri:options"]?.application ?? "omnidoc";
  const file = caps["tauri:options"]?.args?.[0] ?? "";
  const name = file ? path.basename(file) : "(démarrage à vide)";
  const kind = KINDS[path.extname(file).slice(1)];

  it(name, async () => {
    const t0 = Date.now();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (window as unknown as { __omnidocPerf?: PagePerf }).__omnidocPerf?.shellMs ?? -1,
        )) >= 0,
      { timeout: 30_000 },
    );
    let contentMs = -1;
    if (file) {
      if (!kind) throw new Error(`type inconnu : ${file}`);
      await browser.waitUntil(
        async () => {
          const ok = (await renderedProblem(kind)) === "";
          if (ok) contentMs = await browser.execute(() => performance.now());
          return ok;
        },
        { timeout: 120_000, interval: 50 },
      );
    }
    // laisse les travaux différés (miniatures, recalculs, arbres) s'exécuter
    await browser.pause(3000);
    const perf = await browser.execute(
      () => (window as unknown as { __omnidocPerf: PagePerf }).__omnidocPerf,
    );
    const start = processStartMs(application);
    const size = file ? fs.statSync(file).size : 0;
    record({
      file: name,
      sizeMb: Math.round(size / 1048576),
      procStartEpoch: start === null ? null : Math.round(start),
      timeOrigin: Math.round(perf.timeOrigin),
      nativeStartMs: start === null ? null : Math.round(perf.timeOrigin - start),
      shellMs: Math.round(perf.shellMs),
      editorMs: Math.round(perf.editorMs),
      contentMs: Math.round(contentMs),
      maxFrameMs: Math.round(perf.maxFrameMs),
      longFrames: perf.longFrames,
      waitedMs: Date.now() - t0,
    });
    // Seuils larges (non bloquants en CI : la spec n'est lancée que par `pnpm e2e:perf`).
    expect(perf.shellMs).toBeLessThan(5000);
    if (file) expect(perf.maxFrameMs).toBeLessThan(5000);
  });
});
