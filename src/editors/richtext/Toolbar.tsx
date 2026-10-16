import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Icon } from "../../shell/ui/icons";
import { Menu } from "../../shell/ui/Menu";
import type { MenuItem } from "../../shell/ui/Menu";
import { Popover } from "./Popover";
import {
  MAX_FONT_SIZE,
  MAX_ZOOM,
  MIN_FONT_SIZE,
  MIN_ZOOM,
  formatFontSize,
  parseFontSize,
} from "./normalize";
import styles from "./Toolbar.module.css";

const FONTS = [
  { id: "sans", value: "sans-serif" },
  { id: "serif", value: "serif" },
  { id: "mono", value: "monospace" },
  { id: "cursive", value: "cursive" },
];

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

const PALETTE = [
  "#000000",
  "#434343",
  "#808080",
  "#c0c0c0",
  "#c62828",
  "#e65100",
  "#f9a825",
  "#2e7d32",
  "#00838f",
  "#1565c0",
  "#6a1b9a",
  "#ad1457",
];

const HIGHLIGHTS = [
  "#fff59d",
  "#ffcc80",
  "#ef9a9a",
  "#f48fb1",
  "#ce93d8",
  "#90caf9",
  "#80deea",
  "#a5d6a7",
];

interface ToolbarProps {
  editor: Editor;
  zoom: number;
  onZoom(zoom: number): void;
  onPickImage(): void;
  onPrint(): void;
  onFind(replace: boolean): void;
}

function Tool({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.tool}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColorPanel({
  colors,
  labelReset,
  labelCustom,
  onPick,
  onReset,
}: {
  colors: string[];
  labelReset: string;
  labelCustom: string;
  onPick(color: string): void;
  onReset(): void;
}) {
  return (
    <div className={styles.colorPanel}>
      <div className={styles.swatches}>
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            className={styles.swatch}
            style={{ background: c }}
            aria-label={c}
            title={c}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      <label className={styles.field}>
        {labelCustom}
        <input type="color" onChange={(e) => onPick(e.target.value)} />
      </label>
      <button type="button" className={styles.textButton} onClick={onReset}>
        {labelReset}
      </button>
    </div>
  );
}

export function Toolbar({ editor, zoom, onZoom, onPickImage, onPrint, onFind }: ToolbarProps) {
  const { t } = useTranslation("richtext");
  const [linkUrl, setLinkUrl] = useState("");
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes("textStyle") as { fontFamily?: string; fontSize?: string };
      return {
        editable: e.isEditable,
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        sup: e.isActive("superscript"),
        sub: e.isActive("subscript"),
        link: e.isActive("link"),
        linkHref: (e.getAttributes("link") as { href?: string }).href ?? "",
        highlight: e.isActive("highlight"),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        task: e.isActive("taskList"),
        inTable: e.isActive("table"),
        alignCenter: e.isActive({ textAlign: "center" }),
        alignRight: e.isActive({ textAlign: "right" }),
        alignJustify: e.isActive({ textAlign: "justify" }),
        alignLeft:
          !e.isActive({ textAlign: "center" }) &&
          !e.isActive({ textAlign: "right" }) &&
          !e.isActive({ textAlign: "justify" }),
        heading:
          ([1, 2, 3, 4, 5, 6] as const).find((l) => e.isActive("heading", { level: l })) ?? 0,
        quote: e.isActive("blockquote"),
        codeBlock: e.isActive("codeBlock"),
        fontFamily: ts.fontFamily ?? "",
        fontSize: parseFontSize(ts.fontSize),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });
  const off = !s.editable;
  const run = () => editor.chain().focus();

  const styleItems: MenuItem[] = [
    { id: "p", label: t("style.paragraph"), onSelect: () => run().setParagraph().run() },
    ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
      id: `h${level}`,
      label: t("style.heading", { level }),
      onSelect: () => run().setHeading({ level }).run(),
    })),
    { id: "sep", label: "", separator: true },
    { id: "quote", label: t("style.quote"), onSelect: () => run().toggleBlockquote().run() },
    { id: "code", label: t("style.codeBlock"), onSelect: () => run().toggleCodeBlock().run() },
  ];
  const styleLabel = s.heading
    ? t("style.heading", { level: s.heading })
    : s.quote
      ? t("style.quote")
      : s.codeBlock
        ? t("style.codeBlock")
        : t("style.paragraph");

  const tableItems: MenuItem[] = [
    { id: "rb", label: t("table.rowBefore"), onSelect: () => run().addRowBefore().run() },
    { id: "ra", label: t("table.rowAfter"), onSelect: () => run().addRowAfter().run() },
    { id: "rd", label: t("table.deleteRow"), onSelect: () => run().deleteRow().run() },
    { id: "s1", label: "", separator: true },
    { id: "cb", label: t("table.colBefore"), onSelect: () => run().addColumnBefore().run() },
    { id: "ca", label: t("table.colAfter"), onSelect: () => run().addColumnAfter().run() },
    { id: "cd", label: t("table.deleteCol"), onSelect: () => run().deleteColumn().run() },
    { id: "s2", label: "", separator: true },
    { id: "merge", label: t("table.merge"), onSelect: () => run().mergeCells().run() },
    { id: "split", label: t("table.split"), onSelect: () => run().splitCell().run() },
    { id: "hdr", label: t("table.toggleHeader"), onSelect: () => run().toggleHeaderRow().run() },
    { id: "s3", label: "", separator: true },
    { id: "del", label: t("table.deleteTable"), onSelect: () => run().deleteTable().run() },
  ];

  const moreItems: MenuItem[] = [
    {
      id: "hr",
      label: t("toolbar.horizontalRule"),
      disabled: off,
      onSelect: () => run().setHorizontalRule().run(),
    },
    {
      id: "clear",
      label: t("toolbar.clearFormat"),
      disabled: off,
      onSelect: () => run().unsetAllMarks().clearNodes().run(),
    },
    { id: "print", label: t("toolbar.print"), onSelect: onPrint },
  ];

  function indent(sink: boolean) {
    const type = editor.isActive("taskItem") ? "taskItem" : "listItem";
    if (sink) run().sinkListItem(type).run();
    else run().liftListItem(type).run();
  }

  return (
    <div className={styles.toolbar} role="toolbar" aria-label={t("toolbar.label")}>
      <div className={styles.group}>
        <Tool
          label={t("toolbar.undo")}
          disabled={off || !s.canUndo}
          onClick={() => run().undo().run()}
        >
          <Icon name="undo" />
        </Tool>
        <Tool
          label={t("toolbar.redo")}
          disabled={off || !s.canRedo}
          onClick={() => run().redo().run()}
        >
          <Icon name="redo" />
        </Tool>
      </div>
      <div className={styles.group}>
        <Menu label={styleLabel} icon="text" items={styleItems} disabled={off} />
        <select
          className={styles.select}
          aria-label={t("toolbar.font")}
          value={s.fontFamily}
          disabled={off}
          onChange={(e) => {
            if (e.target.value) run().setFontFamily(e.target.value).run();
            else run().unsetFontFamily().run();
          }}
        >
          <option value="">{t("toolbar.fontDefault")}</option>
          {FONTS.map((f) => (
            <option key={f.id} value={f.value}>
              {t(`fonts.${f.id}`)}
            </option>
          ))}
        </select>
        <select
          className={styles.selectSmall}
          aria-label={t("toolbar.fontSize")}
          value={s.fontSize === null ? "" : String(s.fontSize)}
          disabled={off}
          onChange={(e) => {
            if (e.target.value)
              run()
                .setFontSize(formatFontSize(Number(e.target.value)))
                .run();
            else run().unsetFontSize().run();
          }}
        >
          <option value="">{t("toolbar.fontSizeDefault")}</option>
          {SIZES.filter((n) => n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.group}>
        <Tool
          label={t("toolbar.bold")}
          pressed={s.bold}
          disabled={off}
          onClick={() => run().toggleBold().run()}
        >
          <Icon name="bold" />
        </Tool>
        <Tool
          label={t("toolbar.italic")}
          pressed={s.italic}
          disabled={off}
          onClick={() => run().toggleItalic().run()}
        >
          <Icon name="italic" />
        </Tool>
        <Tool
          label={t("toolbar.underline")}
          pressed={s.underline}
          disabled={off}
          onClick={() => run().toggleUnderline().run()}
        >
          <Icon name="underline" />
        </Tool>
        <Tool
          label={t("toolbar.strike")}
          pressed={s.strike}
          disabled={off}
          onClick={() => run().toggleStrike().run()}
        >
          <Icon name="strike" />
        </Tool>
        <Tool
          label={t("toolbar.code")}
          pressed={s.code}
          disabled={off}
          onClick={() => run().toggleCode().run()}
        >
          <Icon name="code" />
        </Tool>
        <Tool
          label={t("toolbar.superscript")}
          pressed={s.sup}
          disabled={off}
          onClick={() => run().toggleSuperscript().run()}
        >
          <Icon name="sup" />
        </Tool>
        <Tool
          label={t("toolbar.subscript")}
          pressed={s.sub}
          disabled={off}
          onClick={() => run().toggleSubscript().run()}
        >
          <Icon name="sub" />
        </Tool>
        <Popover
          label={t("toolbar.textColor")}
          trigger={
            <span className={styles.colorA}>
              <Icon name="textColor" />
            </span>
          }
          disabled={off}
        >
          {(close) => (
            <ColorPanel
              colors={PALETTE}
              labelReset={t("toolbar.colorReset")}
              labelCustom={t("toolbar.colorCustom")}
              onPick={(c) => {
                run().setColor(c).run();
                close();
              }}
              onReset={() => {
                run().unsetColor().run();
                close();
              }}
            />
          )}
        </Popover>
        <Popover
          label={t("toolbar.highlight")}
          trigger={<Icon name="highlight" />}
          pressed={s.highlight}
          disabled={off}
        >
          {(close) => (
            <ColorPanel
              colors={HIGHLIGHTS}
              labelReset={t("toolbar.colorReset")}
              labelCustom={t("toolbar.colorCustom")}
              onPick={(c) => {
                run().setHighlight({ color: c }).run();
                close();
              }}
              onReset={() => {
                run().unsetHighlight().run();
                close();
              }}
            />
          )}
        </Popover>
      </div>
      <div className={styles.group}>
        <Tool
          label={t("toolbar.alignLeft")}
          pressed={s.alignLeft}
          disabled={off}
          onClick={() => run().unsetTextAlign().run()}
        >
          <Icon name="alignLeft" />
        </Tool>
        <Tool
          label={t("toolbar.alignCenter")}
          pressed={s.alignCenter}
          disabled={off}
          onClick={() => run().setTextAlign("center").run()}
        >
          <Icon name="alignCenter" />
        </Tool>
        <Tool
          label={t("toolbar.alignRight")}
          pressed={s.alignRight}
          disabled={off}
          onClick={() => run().setTextAlign("right").run()}
        >
          <Icon name="alignRight" />
        </Tool>
        <Tool
          label={t("toolbar.alignJustify")}
          pressed={s.alignJustify}
          disabled={off}
          onClick={() => run().setTextAlign("justify").run()}
        >
          <Icon name="alignJustify" />
        </Tool>
      </div>
      <div className={styles.group}>
        <Tool
          label={t("toolbar.bulletList")}
          pressed={s.bullet}
          disabled={off}
          onClick={() => run().toggleBulletList().run()}
        >
          <Icon name="bulletList" />
        </Tool>
        <Tool
          label={t("toolbar.orderedList")}
          pressed={s.ordered}
          disabled={off}
          onClick={() => run().toggleOrderedList().run()}
        >
          <Icon name="orderedList" />
        </Tool>
        <Tool
          label={t("toolbar.taskList")}
          pressed={s.task}
          disabled={off}
          onClick={() => run().toggleTaskList().run()}
        >
          <Icon name="taskList" />
        </Tool>
        <Tool label={t("toolbar.indent")} disabled={off} onClick={() => indent(true)}>
          <Icon name="indent" />
        </Tool>
        <Tool label={t("toolbar.outdent")} disabled={off} onClick={() => indent(false)}>
          <Icon name="outdent" />
        </Tool>
      </div>
      <div className={styles.group}>
        <Popover
          label={t("toolbar.link")}
          trigger={<Icon name="link" />}
          pressed={s.link}
          disabled={off}
        >
          {(close) => (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                const href = linkUrl.trim();
                if (href) run().extendMarkRange("link").setLink({ href }).run();
                setLinkUrl("");
                close();
              }}
            >
              <label className={styles.field}>
                {t("link.url")}
                <input
                  type="url"
                  autoFocus
                  value={linkUrl || s.linkHref}
                  placeholder="https://"
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.textButton}>
                  {t("link.apply")}
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={!s.link}
                  onClick={() => {
                    run().extendMarkRange("link").unsetLink().run();
                    setLinkUrl("");
                    close();
                  }}
                >
                  {t("link.remove")}
                </button>
              </div>
            </form>
          )}
        </Popover>
        <Tool label={t("toolbar.image")} disabled={off} onClick={onPickImage}>
          <Icon name="image" />
        </Tool>
        <Popover label={t("toolbar.insertTable")} trigger={<Icon name="table" />} disabled={off}>
          {(close) => (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                run().insertTable({ rows, cols, withHeaderRow: true }).run();
                close();
              }}
            >
              <label className={styles.field}>
                {t("table.rows")}
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={rows}
                  onChange={(e) => setRows(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              <label className={styles.field}>
                {t("table.cols")}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={cols}
                  onChange={(e) => setCols(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.textButton}>
                  {t("table.insert")}
                </button>
              </div>
            </form>
          )}
        </Popover>
        <Menu
          label={t("table.edit")}
          icon="sheet"
          iconOnly
          items={tableItems}
          disabled={off || !s.inTable}
        />
        <Menu label={t("toolbar.more")} icon="more" iconOnly items={moreItems} />
      </div>
      <div className={styles.group}>
        <Tool label={t("search.find")} onClick={() => onFind(false)}>
          <Icon name="search" />
        </Tool>
      </div>
      <div className={`${styles.group} ${styles.zoomGroup}`}>
        <Tool label={t("zoom.out")} disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(zoom - 10)}>
          <Icon name="minus" />
        </Tool>
        <span className={styles.zoomValue} aria-live="polite">
          {zoom} %
        </span>
        <Tool label={t("zoom.in")} disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(zoom + 10)}>
          <Icon name="plus" />
        </Tool>
      </div>
    </div>
  );
}
