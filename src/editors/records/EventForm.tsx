import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { RecordComponent, RecordProp } from "../../ipc/bindings";
import { AdvancedProps, Field, Section } from "./fields";
import type { Change } from "./fields";
import {
  EVENT_SINGLE,
  TODO_SINGLE,
  indicesOf,
  readDateField,
  removeProp,
  setText,
  textOf,
  addProp,
  updateProp,
  writeDateField,
} from "./logic";
import styles from "./RecordsEditor.module.css";

interface Props {
  comp: RecordComponent;
  onChange: Change;
  readOnly: boolean;
}

const EVENT_STATUS = ["TENTATIVE", "CONFIRMED", "CANCELLED"];
const TODO_STATUS = ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"];

function propOf(comp: RecordComponent, name: string): RecordProp | undefined {
  const i = indicesOf(comp, name)[0];
  return i === undefined ? undefined : comp.props[i];
}

/** Écrit (ou supprime si `date` est vide) une propriété date/heure. */
function setDate(
  comp: RecordComponent,
  name: string,
  f: { date: string; time: string; allDay: boolean },
): RecordComponent {
  const i = indicesOf(comp, name)[0];
  if (f.date === "") return i === undefined ? comp : removeProp(comp, i);
  if (i === undefined) return addProp(comp, writeDateField(undefined, name, f));
  return updateProp(comp, i, (p) => writeDateField(p, name, f));
}

function DateTime({
  label,
  name,
  comp,
  allDay,
  onChange,
  readOnly,
}: Props & { label: string; name: string; allDay: boolean }) {
  const { t } = useTranslation("records");
  const dateId = useId();
  const timeId = useId();
  const field = readDateField(propOf(comp, name));
  const date = field?.date ?? "";
  const time = field?.time ?? "";
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.dateRow}>
        <label htmlFor={dateId} className={styles.srOnly}>
          {t("event.date", { label })}
        </label>
        <input
          id={dateId}
          className={styles.input}
          type="date"
          value={date}
          readOnly={readOnly}
          onChange={(e) =>
            onChange((c) => setDate(c, name, { date: e.target.value, time, allDay }))
          }
        />
        <label htmlFor={timeId} className={styles.srOnly}>
          {t("event.time", { label })}
        </label>
        <input
          id={timeId}
          className={styles.input}
          type="time"
          value={allDay ? "" : time.slice(0, 5)}
          disabled={allDay || date === ""}
          readOnly={readOnly}
          onChange={(e) =>
            onChange((c) =>
              setDate(c, name, {
                date,
                time: e.target.value === "" ? "" : `${e.target.value}:00`,
                allDay: false,
              }),
            )
          }
        />
      </div>
      {field?.tzid ? (
        <span className={styles.hint}>{t("event.tz", { tz: field.tzid })}</span>
      ) : null}
      {field?.utc && !field.allDay ? <span className={styles.hint}>{t("event.utc")}</span> : null}
    </div>
  );
}

export function EventForm({ comp, onChange, readOnly }: Props) {
  const { t } = useTranslation("records");
  const isTodo = comp.name === "VTODO";
  const endName = isTodo ? "DUE" : "DTEND";
  const startField = readDateField(propOf(comp, "DTSTART"));
  const allDay = startField ? startField.allDay : true;
  const status = textOf(comp, "STATUS", false);
  const statuses = isTodo ? TODO_STATUS : EVENT_STATUS;
  const statusId = useId();

  function toggleAllDay(checked: boolean) {
    onChange((c) => {
      let next = c;
      for (const name of ["DTSTART", endName]) {
        const f = readDateField(propOf(next, name));
        if (f)
          next = setDate(next, name, {
            date: f.date,
            time: checked ? "" : f.time,
            allDay: checked,
          });
      }
      return next;
    });
  }

  return (
    <div className={styles.form}>
      <Section title={isTodo ? t("event.todo") : t("event.event")}>
        <Field
          label={t("event.summary")}
          value={textOf(comp, "SUMMARY")}
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "SUMMARY", v, { keepEmpty: true }))}
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={allDay}
            disabled={readOnly}
            onChange={(e) => toggleAllDay(e.target.checked)}
          />
          {t("event.allDay")}
        </label>
        <DateTime
          label={t("event.start")}
          name="DTSTART"
          comp={comp}
          allDay={allDay}
          onChange={onChange}
          readOnly={readOnly}
        />
        <DateTime
          label={isTodo ? t("event.due") : t("event.end")}
          name={endName}
          comp={comp}
          allDay={allDay}
          onChange={onChange}
          readOnly={readOnly}
        />
        {allDay ? <p className={styles.hint}>{t("event.allDayHint")}</p> : null}
        <Field
          label={t("event.location")}
          value={textOf(comp, "LOCATION")}
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "LOCATION", v))}
        />
        <Field
          label={t("event.description")}
          multiline
          value={textOf(comp, "DESCRIPTION")}
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "DESCRIPTION", v))}
        />
        <Field
          label={t("event.rrule")}
          value={textOf(comp, "RRULE", false)}
          placeholder="FREQ=WEEKLY;BYDAY=MO"
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "RRULE", v, { encoded: false }))}
        />
        <div className={styles.field}>
          <label htmlFor={statusId} className={styles.label}>
            {t("event.status")}
          </label>
          <select
            id={statusId}
            className={styles.input}
            value={status}
            disabled={readOnly}
            onChange={(e) =>
              onChange((c) => setText(c, "STATUS", e.target.value, { encoded: false }))
            }
          >
            <option value="">{t("event.statusNone")}</option>
            {(statuses.includes(status) || status === "" ? statuses : [...statuses, status]).map(
              (s) => (
                <option key={s} value={s}>
                  {t(`event.statuses.${s}`, { defaultValue: s })}
                </option>
              ),
            )}
          </select>
        </div>
      </Section>
      <AdvancedProps
        comp={comp}
        single={isTodo ? TODO_SINGLE : EVENT_SINGLE}
        multi={[]}
        onChange={onChange}
        readOnly={readOnly}
      />
    </div>
  );
}
