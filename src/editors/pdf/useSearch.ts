import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { findMatches } from "./search";
import type { TextMatch } from "./search";

interface Results {
  byPage: Map<number, TextMatch[]>;
  total: number;
}

const EMPTY: Results = { byPage: new Map(), total: 0 };

export interface CurrentMatch {
  page: number;
  index: number;
}

/** Recherche plein texte : extraction page par page (au fil de l'eau), résultats triés par page. */
export function useSearch(pdf: PDFDocumentProxy | null, onNavigate: (page: number) => void) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [cur, setCur] = useState<CurrentMatch | null>(null);
  const [searching, setSearching] = useState(false);
  const cache = useRef<{ pdf: PDFDocumentProxy | null; pages: Map<number, string[]> }>({
    pdf: null,
    pages: new Map(),
  });
  const navigate = useRef(onNavigate);
  useEffect(() => {
    navigate.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const token = { cancelled: false };
    const timer = setTimeout(async () => {
      setResults(EMPTY);
      setCur(null);
      setSearching(false);
      if (!open || !pdf || query === "") return;
      if (cache.current.pdf !== pdf) cache.current = { pdf, pages: new Map() };
      const pages = cache.current.pages;
      const byPage = new Map<number, TextMatch[]>();
      let total = 0;
      setSearching(true);
      try {
        for (let p = 1; p <= pdf.numPages; p++) {
          if (token.cancelled) return;
          let strs = pages.get(p);
          if (!strs) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            strs = (content.items as { str?: string }[])
              .filter((i) => typeof i.str === "string")
              .map((i) => i.str as string);
            pages.set(p, strs);
            page.cleanup();
          }
          const found = findMatches(strs, query);
          if (found.length === 0) continue;
          if (token.cancelled) return;
          byPage.set(p, found);
          total += found.length;
          setResults({ byPage: new Map(byPage), total });
          if (total === found.length) {
            setCur({ page: p, index: 0 });
            navigate.current(p);
          }
        }
      } catch {
        // document détruit pendant la recherche
      }
      if (!token.cancelled) setSearching(false);
    }, 250);
    return () => {
      token.cancelled = true;
      clearTimeout(timer);
    };
  }, [open, pdf, query]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const pages = [...results.byPage.keys()].sort((a, b) => a - b);
      if (pages.length === 0) return;
      let next: CurrentMatch;
      if (!cur) {
        const page = dir > 0 ? pages[0]! : pages[pages.length - 1]!;
        next = { page, index: dir > 0 ? 0 : results.byPage.get(page)!.length - 1 };
      } else {
        const count = results.byPage.get(cur.page)?.length ?? 0;
        const idx = cur.index + dir;
        if (idx >= 0 && idx < count) {
          next = { page: cur.page, index: idx };
        } else {
          const at = pages.indexOf(cur.page);
          const page = pages[(at + dir + pages.length) % pages.length]!;
          next = { page, index: dir > 0 ? 0 : results.byPage.get(page)!.length - 1 };
        }
      }
      setCur(next);
      navigate.current(next.page);
    },
    [results, cur],
  );

  let position = 0;
  if (cur) {
    for (const [page, list] of results.byPage) if (page < cur.page) position += list.length;
    position += cur.index + 1;
  }

  return { open, setOpen, query, setQuery, results, cur, searching, step, position };
}
