import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { RecordComponent } from "../../ipc/bindings";
import { Button } from "../../shell/ui/Button";
import { addDays, dayRange, decodeValue, monthGrid, todayYmd } from "./logic";
import styles from "./RecordsEditor.module.css";

export interface CalEntry {
  key: string;
  comp: RecordComponent;
}

interface Props {
  entries: CalEntry[];
  year: number;
  month: number;
  selectedKey: string | null;
  selectedDay: string;
  onNavigate(year: number, month: number): void;
  onSelectDay(day: string): void;
  onSelectEntry(key: string): void;
}

const MAX_CHIPS = 3;

export function MonthView({
  entries,
  year,
  month,
  selectedKey,
  selectedDay,
  onNavigate,
  onSelectDay,
  onSelectEntry,
}: Props) {
  const { t, i18n } = useTranslation("records");
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const first = weeks[0]?.[0] ?? "";
  const last = weeks[weeks.length - 1]?.[6] ?? "";
  const byDay = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    for (const e of entries) {
      const r = dayRange(e.comp);
      if (!r) continue;
      let d = r.start < first ? first : r.start;
      const end = r.end > last ? last : r.end;
      while (d <= end) {
        const list = map.get(d) ?? [];
        list.push(e);
        map.set(d, list);
        d = addDays(d, 1);
      }
    }
    return map;
  }, [entries, first, last]);

  const title = new Intl.DateTimeFormat(i18n.language, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 9, 5 + i)),
    ),
  );
  const today = todayYmd();

  function shift(delta: number) {
    const d = new Date(Date.UTC(year, month + delta, 1));
    onNavigate(d.getUTCFullYear(), d.getUTCMonth());
  }

  return (
    <div className={styles.calendar}>
      <div className={styles.calBar}>
        <Button
          variant="ghost"
          aria-label={t("month.prev")}
          title={t("month.prev")}
          onClick={() => shift(-1)}
        >
          ‹
        </Button>
        <h3 className={styles.calTitle} aria-live="polite">
          {title}
        </h3>
        <Button
          variant="ghost"
          aria-label={t("month.next")}
          title={t("month.next")}
          onClick={() => shift(1)}
        >
          ›
        </Button>
        <Button
          onClick={() => {
            const n = new Date();
            onNavigate(n.getFullYear(), n.getMonth());
            onSelectDay(today);
          }}
        >
          {t("month.today")}
        </Button>
      </div>
      <div className={styles.calGrid} role="grid" aria-label={title}>
        <div className={styles.calRow} role="row">
          {weekdays.map((w) => (
            <div key={w} className={styles.calHead} role="columnheader">
              {w}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className={styles.calRow} role="row">
            {week.map((day) => {
              const list = byDay.get(day) ?? [];
              const inMonth = Number(day.slice(5, 7)) - 1 === month;
              return (
                <div
                  key={day}
                  role="gridcell"
                  aria-selected={day === selectedDay}
                  className={`${styles.calCell} ${inMonth ? "" : styles.calOut} ${day === selectedDay ? styles.calSel : ""}`}
                >
                  <button
                    type="button"
                    className={`${styles.calDay} ${day === today ? styles.calToday : ""}`}
                    onClick={() => onSelectDay(day)}
                    aria-label={day}
                  >
                    {Number(day.slice(8, 10))}
                  </button>
                  {list.slice(0, MAX_CHIPS).map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      className={`${styles.chip} ${e.comp.name === "VTODO" ? styles.chipTodo : ""} ${e.key === selectedKey ? styles.chipSel : ""}`}
                      onClick={() => onSelectEntry(e.key)}
                    >
                      {summary(e.comp) || t("ics.untitled")}
                    </button>
                  ))}
                  {list.length > MAX_CHIPS ? (
                    <span className={styles.more}>
                      {t("month.more", { count: list.length - MAX_CHIPS })}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function summary(comp: RecordComponent): string {
  const p = comp.props.find((q) => q.name.toUpperCase() === "SUMMARY");
  return p ? decodeValue(p.value) : "";
}
