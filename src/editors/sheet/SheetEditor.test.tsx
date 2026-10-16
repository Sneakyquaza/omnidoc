import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { Workbook } from "../../ipc/bindings";
import type { EditorProps } from "../types";
import SheetEditor from "./SheetEditor";

const model: Workbook = {
  sheets: [
    {
      name: "S1",
      rows: [
        [
          { v: { type: "number", value: 2 }, f: null, fmt: null },
          { v: { type: "number", value: 0 }, f: "A1*21", fmt: null },
        ],
      ],
      colWidths: [12],
    },
  ],
  csv: null,
  lossy: ["merges"],
};

describe("SheetEditor", () => {
  it("monte la grille et sérialise le modèle recalculé", () => {
    let serializer: (() => Workbook | Promise<Workbook>) | undefined;
    const props: EditorProps<Workbook> = {
      tab: {
        id: "t",
        path: null,
        title: "t",
        handlerId: "xlsx",
        modelKind: "sheet",
        readOnly: false,
        dirty: false,
      },
      model,
      readOnly: false,
      setDirty: vi.fn(),
      registerSerializer: (fn) => {
        serializer = fn;
      },
      registerCommands: vi.fn(),
      setStatus: vi.fn(),
    };
    render(<SheetEditor {...props} />);
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(screen.getAllByRole("tab").length).toBe(1);
    const out = serializer?.() as Workbook;
    expect(out.sheets[0]?.rows[0]?.[1]?.v).toEqual({ type: "number", value: 42 });
    expect(out.sheets[0]?.colWidths).toEqual([12]);
    expect(out.lossy).toEqual(["merges"]);
  });
});
