import { useTranslation } from "react-i18next";
import type { RecordComponent } from "../../ipc/bindings";
import { Button } from "../../shell/ui/Button";
import { AdvancedProps, Field, Section } from "./fields";
import type { Change } from "./fields";
import {
  ADR_FIELDS,
  N_FIELDS,
  VCARD_MULTI,
  VCARD_SINGLE,
  addProp,
  formatStructured,
  getTypes,
  indicesOf,
  parseBday,
  parseStructured,
  photoDataUri,
  removeProp,
  setStructuredAt,
  setText,
  setTypes,
  textOf,
  updateProp,
} from "./logic";
import styles from "./RecordsEditor.module.css";

interface Props {
  comp: RecordComponent;
  onChange: Change;
  readOnly: boolean;
}

const TYPE_LIST = "records-vcard-types";

/** Écrit un champ structuré (N, ORG) : crée la propriété si besoin, garde le brut si inchangé. */
function setStructured(comp: RecordComponent, name: string, parts: string[], min: number) {
  const i = indicesOf(comp, name)[0];
  if (i === undefined) {
    return parts.every((p) => p === "")
      ? comp
      : addProp(comp, { name, params: [], value: formatStructured(parts) });
  }
  return setStructuredAt(comp, i, parts, min);
}

function TypedList({
  comp,
  name,
  label,
  addLabel,
  onChange,
  readOnly,
  typed,
  inputType,
}: Props & { name: string; label: string; addLabel: string; typed: boolean; inputType?: string }) {
  const { t } = useTranslation("records");
  const indices = indicesOf(comp, name);
  return (
    <Section
      title={label}
      actions={
        <Button
          icon="plus"
          disabled={readOnly}
          onClick={() => onChange((c) => addProp(c, { name, params: [], value: "" }))}
        >
          {addLabel}
        </Button>
      }
    >
      {indices.length === 0 ? <p className={styles.hint}>{t("contact.none")}</p> : null}
      {indices.map((i) => {
        const p = comp.props[i];
        if (!p) return null;
        return (
          <div key={i} className={styles.listRow}>
            {typed ? (
              <input
                className={`${styles.input} ${styles.typeInput}`}
                aria-label={t("contact.type")}
                placeholder={t("contact.type")}
                list={TYPE_LIST}
                value={getTypes(p)}
                readOnly={readOnly}
                onChange={(e) =>
                  onChange((c) => updateProp(c, i, (q) => setTypes(q, e.target.value)))
                }
              />
            ) : null}
            <input
              className={styles.input}
              type={inputType ?? "text"}
              aria-label={label}
              value={p.value}
              readOnly={readOnly}
              onChange={(e) =>
                onChange((c) => updateProp(c, i, (q) => ({ ...q, value: e.target.value })))
              }
            />
            <Button
              variant="ghost"
              aria-label={t("contact.remove")}
              title={t("contact.remove")}
              disabled={readOnly}
              onClick={() => onChange((c) => removeProp(c, i))}
            >
              ×
            </Button>
          </div>
        );
      })}
    </Section>
  );
}

export function ContactForm({ comp, onChange, readOnly }: Props) {
  const { t } = useTranslation("records");
  const nIdx = indicesOf(comp, "N")[0];
  const nParts = parseStructured(
    nIdx === undefined ? "" : (comp.props[nIdx]?.value ?? ""),
    N_FIELDS.length,
  );
  const orgIdx = indicesOf(comp, "ORG")[0];
  const orgParts = parseStructured(
    orgIdx === undefined ? "" : (comp.props[orgIdx]?.value ?? ""),
    2,
  );
  const bdayIdx = indicesOf(comp, "BDAY")[0];
  const bday = bdayIdx === undefined ? "" : (parseBday(comp.props[bdayIdx]?.value ?? "") ?? "");
  const photoIdx = indicesOf(comp, "PHOTO")[0];
  const photoProp = photoIdx === undefined ? undefined : comp.props[photoIdx];
  const photo = photoProp ? photoDataUri(photoProp) : null;
  const adrIndices = indicesOf(comp, "ADR");

  return (
    <div className={styles.form}>
      <datalist id={TYPE_LIST}>
        {["home", "work", "cell", "voice", "fax", "pref", "internet"].map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <Section title={t("contact.identity")}>
        {photo ? <img className={styles.photo} src={photo} alt={t("contact.photo")} /> : null}
        <Field
          label={t("contact.fn")}
          value={textOf(comp, "FN")}
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "FN", v, { keepEmpty: true }))}
        />
        <div className={styles.grid}>
          {N_FIELDS.map((f, k) => (
            <Field
              key={f}
              label={t(`contact.n.${f}`)}
              value={nParts[k] ?? ""}
              readOnly={readOnly}
              onChange={(v) =>
                onChange((c) =>
                  setStructured(
                    c,
                    "N",
                    nParts.map((p, j) => (j === k ? v : p)),
                    N_FIELDS.length,
                  ),
                )
              }
            />
          ))}
        </div>
      </Section>
      <Section title={t("contact.work")}>
        <div className={styles.grid}>
          <Field
            label={t("contact.org")}
            value={orgParts[0] ?? ""}
            readOnly={readOnly}
            onChange={(v) =>
              onChange((c) =>
                setStructured(
                  c,
                  "ORG",
                  orgParts.map((p, j) => (j === 0 ? v : p)),
                  2,
                ),
              )
            }
          />
          <Field
            label={t("contact.unit")}
            value={orgParts[1] ?? ""}
            readOnly={readOnly}
            onChange={(v) =>
              onChange((c) =>
                setStructured(
                  c,
                  "ORG",
                  orgParts.map((p, j) => (j === 1 ? v : p)),
                  2,
                ),
              )
            }
          />
          <Field
            label={t("contact.title")}
            value={textOf(comp, "TITLE")}
            readOnly={readOnly}
            onChange={(v) => onChange((c) => setText(c, "TITLE", v))}
          />
          <Field
            label={t("contact.bday")}
            type="date"
            value={bday}
            readOnly={readOnly}
            onChange={(v) =>
              onChange((c) => {
                const i = indicesOf(c, "BDAY")[0];
                if (i === undefined)
                  return v === "" ? c : addProp(c, { name: "BDAY", params: [], value: v });
                if (v === "") return removeProp(c, i);
                const compact = !(c.props[i]?.value ?? "").includes("-");
                return updateProp(c, i, (q) => ({
                  ...q,
                  value: compact ? v.replace(/-/g, "") : v,
                }));
              })
            }
          />
        </div>
      </Section>
      <TypedList
        comp={comp}
        name="TEL"
        label={t("contact.tel")}
        addLabel={t("contact.addTel")}
        onChange={onChange}
        readOnly={readOnly}
        typed
        inputType="tel"
      />
      <TypedList
        comp={comp}
        name="EMAIL"
        label={t("contact.email")}
        addLabel={t("contact.addEmail")}
        onChange={onChange}
        readOnly={readOnly}
        typed
        inputType="email"
      />
      <Section
        title={t("contact.adr")}
        actions={
          <Button
            icon="plus"
            disabled={readOnly}
            onClick={() =>
              onChange((c) =>
                addProp(c, { name: "ADR", params: [["TYPE", "home"]], value: ";;;;;;" }),
              )
            }
          >
            {t("contact.addAdr")}
          </Button>
        }
      >
        {adrIndices.length === 0 ? <p className={styles.hint}>{t("contact.none")}</p> : null}
        {adrIndices.map((i) => {
          const p = comp.props[i];
          if (!p) return null;
          const parts = parseStructured(p.value, ADR_FIELDS.length);
          return (
            <div key={i} className={styles.adr}>
              <div className={styles.listRow}>
                <input
                  className={`${styles.input} ${styles.typeInput}`}
                  aria-label={t("contact.type")}
                  placeholder={t("contact.type")}
                  list={TYPE_LIST}
                  value={getTypes(p)}
                  readOnly={readOnly}
                  onChange={(e) =>
                    onChange((c) => updateProp(c, i, (q) => setTypes(q, e.target.value)))
                  }
                />
                <Button
                  variant="ghost"
                  aria-label={t("contact.remove")}
                  title={t("contact.remove")}
                  disabled={readOnly}
                  onClick={() => onChange((c) => removeProp(c, i))}
                >
                  ×
                </Button>
              </div>
              <div className={styles.grid}>
                {ADR_FIELDS.map((f, k) => (
                  <Field
                    key={f}
                    label={t(`contact.adrFields.${f}`)}
                    value={parts[k] ?? ""}
                    readOnly={readOnly}
                    onChange={(v) =>
                      onChange((c) =>
                        setStructuredAt(
                          c,
                          i,
                          parts.map((q, j) => (j === k ? v : q)),
                          ADR_FIELDS.length,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
      </Section>
      <TypedList
        comp={comp}
        name="URL"
        label={t("contact.url")}
        addLabel={t("contact.addUrl")}
        onChange={onChange}
        readOnly={readOnly}
        typed={false}
        inputType="url"
      />
      <Section title={t("contact.note")}>
        <Field
          label={t("contact.note")}
          multiline
          value={textOf(comp, "NOTE")}
          readOnly={readOnly}
          onChange={(v) => onChange((c) => setText(c, "NOTE", v))}
        />
      </Section>
      <AdvancedProps
        comp={comp}
        single={VCARD_SINGLE}
        multi={VCARD_MULTI}
        onChange={onChange}
        readOnly={readOnly}
      />
    </div>
  );
}
