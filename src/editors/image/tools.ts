import type { ShapeKind } from "./annotations";

export type Tool = "select" | "crop" | "pen" | "text" | ShapeKind;

export const TOOLS: Tool[] = [
  "select",
  "crop",
  "arrow",
  "rect",
  "ellipse",
  "pen",
  "text",
  "highlight",
];

export interface ToolOptions {
  color: string;
  width: number;
  font: string;
  fontSize: number;
}

export const DEFAULT_OPTIONS: ToolOptions = {
  color: "#e53935",
  width: 4,
  font: "sans-serif",
  fontSize: 32,
};

export const FONTS = ["sans-serif", "serif", "monospace", "cursive"];
