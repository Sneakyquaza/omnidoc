import type { Extensions } from "@tiptap/core";
import { CharacterCount } from "@tiptap/extension-character-count";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { StarterKit } from "@tiptap/starter-kit";
import { SearchExtension } from "./search";

/**
 * Extensions TipTap : doivent produire le schéma des handlers Rust
 * (le JSON est de toute façon ramené à ce schéma par `normalizeDoc`).
 */
export function buildExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({
      trailingNode: false,
      link: { openOnClick: false, autolink: true },
    }),
    TextAlign.configure({
      types: ["heading", "paragraph"],
      alignments: ["center", "right", "justify"],
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    Subscript,
    Superscript,
    Image.configure({ inline: true, allowBase64: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem,
    Placeholder.configure({ placeholder }),
    CharacterCount,
    SearchExtension,
  ];
}
