import type { ElicitationChoice, ElicitationField } from '../types';

/** A typed form value. Number and date inputs hold strings until `toContent`. */
export type FormValue = string | boolean | string[];

const REQUIRED = 'This field is required.';
const NOT_AN_OPTION = 'Pick one of the options.';
const WRONG_FORMAT = 'Use the format the agent asked for.';

/** The values a form starts with: the agent's defaults, else empty. */
export function initialValues(fields: ElicitationField[]): Record<string, FormValue> {
  return Object.fromEntries(fields.map((field) => [field.name, initialValue(field)]));
}

function initialValue({ kind, default: fallback }: ElicitationField): FormValue {
  switch (kind.type) {
    case 'boolean':
      return fallback === true;
    case 'multiSelect':
      return Array.isArray(fallback)
        ? fallback.filter((item): item is string => typeof item === 'string')
        : [];
    case 'number':
      return typeof fallback === 'number' ? String(fallback) : '';
    case 'text':
      if (typeof fallback !== 'string') return '';
      return kind.format === 'date-time' ? toLocalDateTime(fallback) : fallback;
    default:
      return typeof fallback === 'string' ? fallback : '';
  }
}

const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** An RFC 3339 time as local `YYYY-MM-DDTHH:MM:SS` for a datetime-local input; '' if it is not one. */
function toLocalDateTime(value: string): string {
  const time = RFC_3339.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) return '';
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** False when a field cannot be shown, so the form cannot be sent. */
export function canSubmit(fields: ElicitationField[]): boolean {
  return fields.every((field) => field.kind.type !== 'unsupported');
}

/** Error message per field name, for instant feedback. The backend checks again. */
export function checkForm(
  fields: ElicitationField[],
  values: Record<string, FormValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const message = checkField(field, values[field.name]);
    if (message) errors[field.name] = message;
  }
  return errors;
}

function checkField(field: ElicitationField, value: unknown): string | undefined {
  if (field.kind.type === 'unsupported') return undefined;
  if (value === undefined || value === null || value === '') {
    return field.required ? REQUIRED : undefined;
  }
  const { kind } = field;
  switch (kind.type) {
    case 'text':
      return checkText(value, kind);
    case 'number':
      return checkNumber(value, kind);
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Use yes or no.';
    case 'select':
      return typeof value === 'string' && isOption(kind.options, value) ? undefined : NOT_AN_OPTION;
    case 'multiSelect':
      return checkMulti(value, kind);
  }
}

function isOption(options: ElicitationChoice[], chosen: string): boolean {
  return options.some((option) => option.value === chosen);
}

function checkText(
  value: unknown,
  kind: { format?: string; minLength?: number; maxLength?: number },
): string | undefined {
  if (typeof value !== 'string') return WRONG_FORMAT;
  const length = [...value].length;
  if (kind.minLength !== undefined && length < kind.minLength) {
    return `Use at least ${kind.minLength} characters.`;
  }
  if (kind.maxLength !== undefined && length > kind.maxLength) {
    return `Use at most ${kind.maxLength} characters.`;
  }
  const format =
    kind.format !== undefined && Object.hasOwn(FORMATS, kind.format)
      ? FORMATS[kind.format]
      : undefined;
  return format && !format.valid(value) ? format.message : undefined;
}

function checkNumber(
  value: unknown,
  kind: { integer: boolean; minimum?: number; maximum?: number },
): string | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return 'Use a number.';
  if (kind.integer && !Number.isInteger(number)) return 'Use a whole number.';
  if (kind.minimum !== undefined && number < kind.minimum) return `Use ${kind.minimum} or more.`;
  if (kind.maximum !== undefined && number > kind.maximum) return `Use ${kind.maximum} or less.`;
  return undefined;
}

function checkMulti(
  value: unknown,
  kind: { options: ElicitationChoice[]; minItems?: number; maxItems?: number },
): string | undefined {
  if (!Array.isArray(value)) return NOT_AN_OPTION;
  if (!value.every((item) => typeof item === 'string' && isOption(kind.options, item))) {
    return NOT_AN_OPTION;
  }
  if (kind.minItems !== undefined && value.length < kind.minItems) {
    return `Pick at least ${kind.minItems}.`;
  }
  if (kind.maxItems !== undefined && value.length > kind.maxItems) {
    return `Pick at most ${kind.maxItems}.`;
  }
  return undefined;
}

const FORMATS: Record<string, { valid: (text: string) => boolean; message: string }> = {
  email: { valid: isEmail, message: 'Use an email address.' },
  uri: { valid: isUri, message: 'Use a full web address.' },
  date: { valid: isDate, message: 'Use a date.' },
  'date-time': { valid: isDateTime, message: 'Use a date and time.' },
};

/** One `@`, text on both sides, and a dot inside the domain. */
function isEmail(text: string): boolean {
  const parts = text.split('@');
  if (parts.length !== 2 || /\s/.test(text)) return false;
  const [local, domain] = parts;
  return local !== '' && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function isUri(text: string): boolean {
  if (/\s/.test(text) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/./.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` with a month of 1-12 and a day of 1-31. */
function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** What `<input type="datetime-local">` gives: `YYYY-MM-DDTHH:MM` or with `:SS`. */
function isDateTime(text: string): boolean {
  const match = /^(.{10})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return false;
  const [, date, hour, minute, second] = match;
  return (
    isDate(date) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59)
  );
}

/**
 * The content to send: typed values with numbers as numbers, date-times as
 * RFC 3339 and empty optional values left out. `offsetMinutes` overrides the
 * offset from UTC; by default it is the local offset at the entered date-time,
 * so daylight saving is respected.
 */
export function toContent(
  fields: ElicitationField[],
  values: Record<string, FormValue>,
  offsetMinutes?: number,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || field.kind.type === 'unsupported') continue;
    if (typeof value === 'boolean' || Array.isArray(value)) {
      if (Array.isArray(value) && value.length === 0 && !field.required) continue;
      content[field.name] = value;
    } else if (value !== '') {
      content[field.name] = convert(field, value, offsetMinutes);
    }
  }
  return content;
}

function convert(field: ElicitationField, value: string, offsetMinutes?: number): unknown {
  if (field.kind.type === 'number') return Number(value);
  if (field.kind.type === 'text' && field.kind.format === 'date-time') {
    return withOffset(value, offsetMinutes);
  }
  return value;
}

/** `2026-10-20T09:30` plus an offset becomes `2026-10-20T09:30:00+07:00`. */
function withOffset(local: string, override?: number): string {
  const offsetMinutes = override ?? localOffset(local);
  const withSeconds = /T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
  if (offsetMinutes === 0) return `${withSeconds}Z`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${withSeconds}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Minutes east of UTC for a local date-time, falling back to now if it does not parse. */
function localOffset(local: string): number {
  const date = new Date(local);
  return -(Number.isNaN(date.getTime()) ? new Date() : date).getTimezoneOffset();
}
