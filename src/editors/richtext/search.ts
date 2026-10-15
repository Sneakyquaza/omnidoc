import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  /** Index de la correspondance courante. */
  current: number;
}

export interface Match {
  from: number;
  to: number;
}

/** Cherche `query` dans chaque bloc de texte (pas de correspondance à cheval sur plusieurs blocs). */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push({ from: pos + 1 + i, to: pos + 1 + i + needle.length });
      i = hay.indexOf(needle, i + needle.length);
    }
    return false;
  });
  return out;
}

export const searchKey = new PluginKey<SearchState>("omnidocSearch");

export const SearchExtension = Extension.create({
  name: "omnidocSearch",
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => ({ query: "", caseSensitive: false, current: 0 }),
          apply(tr, prev) {
            const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
            return meta ? { ...prev, ...meta } : prev;
          },
        },
        props: {
          decorations(state) {
            const s = searchKey.getState(state);
            if (!s?.query) return null;
            const matches = findMatches(state.doc, s.query, s.caseSensitive);
            return DecorationSet.create(
              state.doc,
              matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === s.current ? "omnidoc-search-current" : "omnidoc-search-match",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
