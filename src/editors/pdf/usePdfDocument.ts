import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readBytes } from "../../ipc/bytes";
import { openPdf } from "./pdfjs";

export interface PageInfo {
  view: [number, number, number, number];
  rotate: number;
}

export const DEFAULT_PAGE: PageInfo = { view: [0, 0, 595, 842], rotate: 0 };

interface DocState {
  pdf: PDFDocumentProxy | null;
  /** Dimensions des pages, `null` tant qu'elles ne sont pas connues. */
  infos: (PageInfo | null)[];
  generation: number;
  loading: boolean;
  failed: boolean;
}

const INITIAL: DocState = { pdf: null, infos: [], generation: 0, loading: true, failed: false };

/** Charge le PDF depuis le disque (octets bruts) et ses dimensions de pages ; `reload` relit le fichier. */
export function usePdfDocument(path: string | null, enabled: boolean) {
  const [state, setState] = useState<DocState>(INITIAL);
  const current = useRef<PDFDocumentProxy | null>(null);
  const token = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    if (path === null || !enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    setState((s) => ({ ...s, loading: true, failed: false }));
    let pdf: PDFDocumentProxy;
    try {
      pdf = await openPdf(await readBytes(path));
    } catch {
      if (mine === token.current) setState((s) => ({ ...s, loading: false, failed: true }));
      return;
    }
    if (mine !== token.current) {
      void pdf.loadingTask.destroy();
      return;
    }
    const old = current.current;
    current.current = pdf;
    const infos: (PageInfo | null)[] = new Array<PageInfo | null>(pdf.numPages).fill(null);
    setState((s) => ({
      pdf,
      infos,
      generation: s.generation + 1,
      loading: false,
      failed: false,
    }));
    if (old) void old.loadingTask.destroy();
    // Dimensions de toutes les pages, par lots, pour une hauteur de défilement exacte.
    for (let i = 1; i <= pdf.numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        infos[i - 1] = { view: page.view as PageInfo["view"], rotate: page.rotate };
        page.cleanup();
      } catch {
        return;
      }
      if (mine !== token.current) return;
      if (i % 25 === 0 || i === pdf.numPages) {
        const snapshot = infos.slice();
        setState((s) => (s.pdf === pdf ? { ...s, infos: snapshot } : s));
      }
    }
  }, [path, enabled]);

  const cancel = useCallback(() => {
    token.current++;
  }, []);

  useEffect(() => {
    void Promise.resolve().then(reload);
    return cancel;
  }, [reload, cancel]);

  useEffect(
    () => () => {
      void current.current?.loadingTask.destroy();
      current.current = null;
    },
    [],
  );

  return { ...state, reload };
}
