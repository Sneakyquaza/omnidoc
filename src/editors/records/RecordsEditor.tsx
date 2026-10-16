import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecordComponent, RecordsDoc } from "../../ipc/bindings";
import { EditorSidePanel, EditorToolbar } from "../../shell/slots";
import { Button } from "../../shell/ui/Button";
import { confirm } from "../../shell/ui/dialogStore";
import type { EditorProps } from "../types";
import { ContactForm } from "./ContactForm";
import { EventForm } from "./EventForm";
import type { Change } from "./fields";
import { MonthView, summary } from "./MonthView";
import type { CalEntry } from "./MonthView";
import {
  decodeValue,
  newCalendar,
  newCalendarItem,
  newContact,
  parseIcsDateValue,
  parseStructured,
  sortKey,
  todayYmd,
} from "./logic";
import styles from "./RecordsEditor.module.css";

interface Entry extends CalEntry {
  path: number[];
}

function entriesOf(components: RecordComponent[], format: "ics" | "vcf"): Entry[] {
  if (format === "vcf") {
    return components
      .map((comp, i) => ({ key: String(i), path: [i], comp }))
      .filter((e) => e.comp.name.toUpperCase() === "VCARD");
  }
  return components.flatMap((cal, i) =>
    cal.name.toUpperCase() === "VCALENDAR"
      ? cal.children
          .map((comp, j) => ({ key: `${i}.${j}`, path: [i, j], comp }))
          .filter((e) => ["VEVENT", "VTODO"].includes(e.comp.name.toUpperCase()))
      : [],
  );
}

function replaceAt(
  components: RecordComponent[],
  path: number[],
  fn: (c: RecordComponent) => RecordComponent | null,
): RecordComponent[] {
  const [i, j] = path;
  if (path.length === 1) {
    return components.flatMap((c, k) => {
      if (k !== i) return [c];
      const r = fn(c);
      return r ? [r] : [];
    });
  }
  return components.map((cal, k) =>
    k === i
      ? {
          ...cal,
          children: cal.children.flatMap((c, l) => {
            if (l !== j) return [c];
            const r = fn(c);
            return r ? [r] : [];
          }),
        }
      : cal,
  );
}

function contactLabel(comp: RecordComponent): string {
  const get = (name: string) => comp.props.find((p) => p.name.toUpperCase() === name);
  const fn = decodeValue(get("FN")?.value ?? "").trim();
  if (fn) return fn;
  const n = parseStructured(get("N")?.value ?? "", 2);
  const joined = `${n[1] ?? ""} ${n[0] ?? ""}`.trim();
  if (joined) return joined;
  return parseStructured(get("ORG")?.value ?? "", 1)[0] ?? "";
}

function searchText(comp: RecordComponent): string {
  return comp.props
    .map((p) => decodeValue(p.value))
    .join(" ")
    .toLowerCase();
}

export default function RecordsEditor({
  model,
  readOnly,
  setDirty,
  registerSerializer,
  registerCommands,
  setStatus,
}: EditorProps<RecordsDoc>) {
  const { t } = useTranslation("records");
  const format = model.format;
  const [components, setComponents] = useState(model.components);
  const entries = useMemo(() => entriesOf(components, format), [components, format]);
  const sorted = useMemo(
    () =>
      format === "ics"
        ? [...entries].sort((a, b) => sortKey(a.comp).localeCompare(sortKey(b.comp)))
        : entries,
    [entries, format],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(entries[0]?.key ?? null);
  const [search, setSearch] = useState("");
  const [selectedDay, setSelectedDay] = useState(todayYmd());
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const selected = entries.find((e) => e.key === selectedKey) ?? null;

  useEffect(() => {
    registerSerializer(() => ({ format, components }));
  }, [registerSerializer, format, components]);

  const modify = useCallback(
    (fn: (c: RecordComponent[]) => RecordComponent[]) => {
      if (readOnly) return;
      setComponents(fn);
      setDirty(true);
    },
    [readOnly, setDirty],
  );

  const onChange: Change = useCallback(
    (fn) => {
      if (!selected) return;
      modify((cs) => replaceAt(cs, selected.path, fn));
    },
    [modify, selected],
  );

  const addContact = useCallback(() => {
    const key = String(components.length);
    modify((cs) => [...cs, newContact()]);
    setSelectedKey(key);
    setSearch("");
  }, [components.length, modify]);

  const addItem = useCallback(
    (name: "VEVENT" | "VTODO") => {
      const item = newCalendarItem(name, selectedDay);
      let calIndex = components.findIndex((c) => c.name.toUpperCase() === "VCALENDAR");
      let childIndex = 0;
      if (calIndex < 0) {
        calIndex = components.length;
        modify((cs) => [...cs, { ...newCalendar(), children: [item] }]);
      } else {
        childIndex = components[calIndex]?.children.length ?? 0;
        modify((cs) =>
          cs.map((c, i) => (i === calIndex ? { ...c, children: [...c.children, item] } : c)),
        );
      }
      setSelectedKey(`${calIndex}.${childIndex}`);
      setSearch("");
    },
    [components, modify, selectedDay],
  );

  const remove = useCallback(async () => {
    if (!selected || readOnly) return;
    const ok = await confirm({
      title: t("delete.title"),
      message: t("delete.message"),
      confirmLabel: t("delete.confirm"),
      danger: true,
    });
    if (!ok) return;
    modify((cs) => replaceAt(cs, selected.path, () => null));
    setSelectedKey(null);
  }, [selected, readOnly, modify, t]);

  useEffect(() => {
    registerCommands(
      format === "vcf"
        ? [
            { id: "records.addContact", title: t("commands.addContact"), run: addContact },
            { id: "records.delete", title: t("commands.delete"), run: () => void remove() },
          ]
        : [
            { id: "records.addEvent", title: t("commands.addEvent"), run: () => addItem("VEVENT") },
            { id: "records.addTodo", title: t("commands.addTodo"), run: () => addItem("VTODO") },
            { id: "records.delete", title: t("commands.delete"), run: () => void remove() },
          ],
    );
  }, [registerCommands, t, format, addContact, addItem, remove]);

  useEffect(() => {
    if (format === "vcf") {
      setStatus([{ id: "records.count", text: t("status.contacts", { count: entries.length }) }]);
    } else {
      const todos = entries.filter((e) => e.comp.name.toUpperCase() === "VTODO").length;
      setStatus([
        {
          id: "records.count",
          text: t("status.items", { events: entries.length - todos, todos }),
        },
      ]);
    }
  }, [setStatus, t, format, entries]);

  const q = search.trim().toLowerCase();
  const visible = q ? sorted.filter((e) => searchText(e.comp).includes(q)) : sorted;

  function itemLabel(e: Entry): { main: string; sub: string } {
    if (format === "vcf") return { main: contactLabel(e.comp) || t("vcf.unnamed"), sub: "" };
    const start = e.comp.props.find((p) => p.name.toUpperCase() === "DTSTART");
    const due = e.comp.props.find((p) => p.name.toUpperCase() === "DUE");
    const d = parseIcsDateValue((start ?? due)?.value ?? "");
    const prefix = e.comp.name.toUpperCase() === "VTODO" ? `${t("ics.taskMark")} ` : "";
    return {
      main: prefix + (summary(e.comp) || t("ics.untitled")),
      sub: d ? `${d.date}${d.time ? ` ${d.time.slice(0, 5)}` : ""}` : t("ics.noDate"),
    };
  }

  return (
    <div className={styles.root}>
      <EditorToolbar>
        {format === "vcf" ? (
          <Button icon="plus" disabled={readOnly} onClick={addContact}>
            {t("vcf.add")}
          </Button>
        ) : (
          <>
            <Button icon="plus" disabled={readOnly} onClick={() => addItem("VEVENT")}>
              {t("ics.addEvent")}
            </Button>
            <Button icon="plus" disabled={readOnly} onClick={() => addItem("VTODO")}>
              {t("ics.addTodo")}
            </Button>
          </>
        )}
        <Button variant="danger" disabled={readOnly || !selected} onClick={() => void remove()}>
          {t("delete.button")}
        </Button>
        {readOnly ? <span className={styles.hint}>{t("readOnly")}</span> : null}
      </EditorToolbar>
      <EditorSidePanel title={format === "vcf" ? t("vcf.title") : t("ics.title")} side="left">
        <input
          className={styles.input}
          type="search"
          value={search}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          onChange={(e) => setSearch(e.target.value)}
        />
        {visible.length === 0 ? <p className={styles.hint}>{t("list.empty")}</p> : null}
        <ul className={styles.list}>
          {visible.map((e) => {
            const l = itemLabel(e);
            return (
              <li key={e.key}>
                <button
                  type="button"
                  className={styles.listButton}
                  aria-current={e.key === selectedKey}
                  onClick={() => setSelectedKey(e.key)}
                >
                  <span className={styles.listMain}>{l.main}</span>
                  {l.sub ? <span className={styles.hint}>{l.sub}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </EditorSidePanel>
      <div className={styles.main}>
        {format === "ics" ? (
          <MonthView
            entries={entries}
            year={cursor.year}
            month={cursor.month}
            selectedKey={selectedKey}
            selectedDay={selectedDay}
            onNavigate={(year, month) => setCursor({ year, month })}
            onSelectDay={setSelectedDay}
            onSelectEntry={setSelectedKey}
          />
        ) : null}
        <div className={styles.formPane}>
          {selected ? (
            format === "vcf" ? (
              <ContactForm
                key={selected.key}
                comp={selected.comp}
                onChange={onChange}
                readOnly={readOnly}
              />
            ) : (
              <EventForm
                key={selected.key}
                comp={selected.comp}
                onChange={onChange}
                readOnly={readOnly}
              />
            )
          ) : (
            <p className={styles.hint}>{t("list.select")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
