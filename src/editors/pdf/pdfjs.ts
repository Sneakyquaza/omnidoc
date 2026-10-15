import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Worker servi par le bundle (CSP : `worker-src 'self'`), aucun accès réseau.
GlobalWorkerOptions.workerSrc = workerUrl;

/** Unités CSS par point PDF à 100 % (96 dpi / 72 dpi). */
export const CSS_UNITS = 96 / 72;

export function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(bytes),
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    enableXfa: false,
  }).promise;
}
