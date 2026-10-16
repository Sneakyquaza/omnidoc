import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../ipc/bindings";
import type { PageRange } from "../../ipc/bindings";
import { reportError } from "../../shell/errors";
import { basename } from "../../shell/paths";
import { confirm } from "../../shell/ui/dialogStore";
import { pushToast } from "../../shell/ui/toastStore";
import type { MergeChoice } from "./Dialogs";

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];

interface Options {
  path: string | null;
  pageCount: number;
  hasPending: boolean;
  /** Recharge le document depuis le disque après une modification sur place. */
  reload(): Promise<void>;
}

/** Opérations de pages : chaque commande écrit un fichier ; `dest == path` remplace l'original. */
export function usePageOps({ path, pageCount, hasPending, reload }: Options) {
  const { t } = useTranslation("pdf");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      reportError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const inPlace = useCallback(
    async (confirmLabel: string, danger: boolean, fn: (path: string) => Promise<void>) => {
      if (!path) return false;
      if (hasPending) {
        pushToast({ kind: "info", text: t("pending.blocked") });
        return false;
      }
      const ok = await confirm({
        title: t("ops.confirmTitle"),
        message: t("ops.confirmMessage"),
        confirmLabel,
        danger,
      });
      if (!ok) return false;
      return run(async () => {
        await fn(path);
        await reload();
      });
    },
    [path, hasPending, reload, run, t],
  );

  const saved = (dest: string) =>
    pushToast({ kind: "success", text: t("ops.saved", { name: basename(dest) }) });

  const rotate = useCallback(
    (pages: number[], degrees: number) =>
      inPlace(t("ops.rotate"), false, (p) =>
        commands.pdfRotate(p, pages, degrees, p).then(() => {}),
      ),
    [inPlace, t],
  );

  const remove = useCallback(
    (pages: number[]) => {
      if (pages.length >= pageCount) {
        pushToast({ kind: "error", text: t("ops.deleteAll") });
        return Promise.resolve(false);
      }
      return inPlace(t("ops.delete"), true, (p) =>
        commands.pdfDeletePages(p, pages, p).then(() => {}),
      );
    },
    [inPlace, pageCount, t],
  );

  const reorder = useCallback(
    (order: number[]) =>
      inPlace(t("ops.reorder"), false, (p) => commands.pdfReorder(p, order, p).then(() => {})),
    [inPlace, t],
  );

  const extract = useCallback(
    async (pages: number[]) => {
      if (!path) return;
      const dest = await saveDialog({
        defaultPath: t("ops.extractName", { name: basename(path) }),
        filters: PDF_FILTER,
      });
      if (dest === null) return;
      if (await run(() => commands.pdfExtract(path, pages, dest).then(() => {}))) saved(dest);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, run, t],
  );

  const split = useCallback(
    async (ranges: PageRange[]) => {
      if (!path) return;
      const dir = await openDialog({ directory: true });
      if (typeof dir !== "string") return;
      await run(async () => {
        const files = await commands.pdfSplit(path, ranges, dir);
        pushToast({ kind: "success", text: t("ops.splitDone", { count: files.length, dir }) });
      });
    },
    [path, run, t],
  );

  const merge = useCallback(
    async ({ paths, append }: MergeChoice) => {
      if (!path) return;
      if (append) {
        await inPlace(t("ops.merge"), false, (p) => commands.pdfMerge(paths, p).then(() => {}));
        return;
      }
      const dest = await saveDialog({ defaultPath: t("ops.mergeName"), filters: PDF_FILTER });
      if (dest === null) return;
      if (await run(() => commands.pdfMerge(paths, dest).then(() => {}))) saved(dest);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, inPlace, run, t],
  );

  return { busy, run, inPlace, rotate, remove, reorder, extract, split, merge };
}
