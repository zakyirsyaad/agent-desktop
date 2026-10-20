import { useId, type ReactNode } from "react";
import type { ElicitationChoice, ElicitationField } from "../../types";
import type { FormValue } from "../../lib/elicitation-form";

/** A radio group holds up to this many options; more become a select. */
const MAX_RADIO_OPTIONS = 4;

const INPUT =
  "w-full rounded-lg border border-border-strong bg-surface-2 px-2.5 py-1.5 text-xs text-fg " +
  "placeholder:text-fg-subtle focus-ring disabled:opacity-40";

export interface ElicitationFieldsProps {
  fields: ElicitationField[];
  values: Record<string, FormValue>;
  /** Error message per field name. */
  errors: Record<string, string>;
  onChange: (name: string, value: FormValue) => void;
  disabled?: boolean;
}

/** The controls of an agent's form. Holds no state: the card owns the values. */
export function ElicitationFields({ fields, values, errors, onChange, disabled = false }: ElicitationFieldsProps) {
  return (
    <div className="mt-3 space-y-3">
      {fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          value={values[field.name]}
          error={errors[field.name]}
          onChange={(value) => onChange(field.name, value)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface FieldRowProps {
  field: ElicitationField;
  value: FormValue | undefined;
  error?: string;
  onChange: (value: FormValue) => void;
  disabled: boolean;
}

/**
 * A field's name, with a star when it is required. The star is hidden from
 * screen readers, which hear `aria-required` instead; `sayRequired` puts the
 * word in the name for a control that cannot carry `aria-required`.
 */
function Caption({ field, sayRequired = false }: { field: ElicitationField; sayRequired?: boolean }) {
  return (
    <>
      {field.title ?? field.name}
      {field.required && (
        <span aria-hidden="true" className="ml-0.5 text-status-attention">
          *
        </span>
      )}
      {field.required && sayRequired && <span className="sr-only">{" (required)"}</span>}
    </>
  );
}

function Help({ id, field, error, errorId }: { id: string; field: ElicitationField; error?: string; errorId: string }) {
  return (
    <>
      {field.description && (
        <p id={id} className="mt-1 text-xs text-fg-muted">
          {field.description}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/** What every control of a field shares: its id, help and accessible links. */
interface Control {
  id: string;
  describedBy?: string;
  shared: {
    id: string;
    disabled: boolean;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
    "aria-required"?: true;
  };
  help: ReactNode;
}

function FieldRow({ field, value, error, onChange, disabled }: FieldRowProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [field.description ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const control: Control = {
    id,
    describedBy,
    shared: {
      id,
      disabled,
      "aria-describedby": describedBy,
      "aria-invalid": error ? true : undefined,
      "aria-required": field.required || undefined,
    },
    help: <Help id={helpId} field={field} error={error} errorId={errorId} />,
  };
  const { kind } = field;
  const props = { field, value, onChange, disabled, control };

  if (kind.type === "unsupported") return null;
  if (kind.type === "boolean") return <BooleanField {...props} />;
  if (kind.type === "select" && kind.options.length <= MAX_RADIO_OPTIONS) return <RadioField {...props} options={kind.options} />;
  if (kind.type === "multiSelect") return <MultiField {...props} options={kind.options} />;
  return <InputField {...props} />;
}

interface ControlProps {
  field: ElicitationField;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  disabled: boolean;
  control: Control;
}

function BooleanField({ field, value, onChange, control }: ControlProps) {
  return (
    <div>
      <label className="flex items-center gap-2 text-xs font-medium text-fg-secondary">
        <input
          type="checkbox"
          {...control.shared}
          className="focus-ring h-3.5 w-3.5"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <Caption field={field} />
        </span>
      </label>
      {control.help}
    </div>
  );
}

function RadioField({ field, value, onChange, disabled, control, options }: ControlProps & { options: ElicitationChoice[] }) {
  return (
    <Group id={control.id} field={field} role="radiogroup" describedBy={control.describedBy}>
      {options.map((option) => (
        <Choice key={option.value} option={option} type="radio" name={control.id} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />
      ))}
      {control.help}
    </Group>
  );
}

function MultiField({ field, value, onChange, disabled, control, options }: ControlProps & { options: ElicitationChoice[] }) {
  const picked = Array.isArray(value) ? value : [];
  const toggle = (optionValue: string) =>
    onChange(picked.includes(optionValue) ? picked.filter((v) => v !== optionValue) : [...picked, optionValue]);
  return (
    <Group id={control.id} field={field} role="group" describedBy={control.describedBy}>
      {options.map((option) => (
        <Choice key={option.value} option={option} type="checkbox" checked={picked.includes(option.value)} disabled={disabled} onChange={() => toggle(option.value)} />
      ))}
      {control.help}
    </Group>
  );
}

/** A text, number or date input, or a select with more options than a radio group holds. */
function InputField({ field, value, onChange, control }: ControlProps) {
  const text = typeof value === "string" ? value : "";
  const { kind } = field;
  return (
    <div>
      <label htmlFor={control.id} className="block text-xs font-medium text-fg-secondary">
        <Caption field={field} />
      </label>
      <div className="mt-1">
        {kind.type === "select" ? (
          <select {...control.shared} className={INPUT} value={text} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose one</option>
            {kind.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.title}
              </option>
            ))}
          </select>
        ) : (
          <input {...control.shared} className={INPUT} {...inputProps(field)} value={text} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      {control.help}
    </div>
  );
}

function inputProps(field: ElicitationField): { type: string; step?: string } {
  const { kind } = field;
  if (kind.type === "number") return { type: "number", step: kind.integer ? "1" : "any" };
  if (kind.type === "text" && kind.format === "date") return { type: "date" };
  if (kind.type === "text" && kind.format === "date-time") return { type: "datetime-local", step: "1" };
  if (kind.type === "text" && kind.format === "email") return { type: "email" };
  if (kind.type === "text" && kind.format === "uri") return { type: "url" };
  return { type: "text" };
}

/** A radio group carries `aria-required`; a checkbox group (`group`) cannot, so its name says it. */
function Group({ id, field, role, describedBy, children }: { id: string; field: ElicitationField; role: "radiogroup" | "group"; describedBy?: string; children: ReactNode }) {
  const isRadio = role === "radiogroup";
  return (
    <div
      role={role}
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      aria-required={isRadio && field.required ? true : undefined}
    >
      <span id={`${id}-label`} className="block text-xs font-medium text-fg-secondary">
        <Caption field={field} sayRequired={!isRadio} />
      </span>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  );
}

function Choice({ option, type, name, checked, disabled, onChange }: { option: ElicitationChoice; type: "radio" | "checkbox"; name?: string; checked: boolean; disabled: boolean; onChange: () => void }) {
  return (
    <label className="flex items-start gap-2 text-xs text-fg-secondary">
      <input type={type} name={name} className="focus-ring mt-0.5 h-3.5 w-3.5" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        {option.title}
        {option.description && <span className="block text-fg-muted">{option.description}</span>}
      </span>
    </label>
  );
}
