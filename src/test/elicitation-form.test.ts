import { describe, expect, it } from 'vitest';
import { canSubmit, checkForm, initialValues, toContent } from '../lib/elicitation-form';
import type { ElicitationChoice, ElicitationField, ElicitationFieldKind } from '../types';

function field(
  name: string,
  kind: ElicitationFieldKind,
  extra: Partial<ElicitationField> = {},
): ElicitationField {
  return { name, required: false, kind, ...extra };
}

const choices: ElicitationChoice[] = [
  { value: 'a', title: 'A' },
  { value: 'b', title: 'B' },
];
const text = (extra: Partial<Extract<ElicitationFieldKind, { type: 'text' }>> = {}) =>
  ({ type: 'text', ...extra }) as ElicitationFieldKind;
const num = (extra: { integer?: boolean; minimum?: number; maximum?: number } = {}) =>
  ({ type: 'number', integer: false, ...extra }) as ElicitationFieldKind;

function msg(kind: ElicitationFieldKind, value: unknown, required = false): string | undefined {
  const f = field('f', kind, { required });
  return checkForm([f], { f: value as never }).f;
}

describe('initialValues', () => {
  it('pre-fills defaults', () => {
    const fields = [
      field('t', text(), { default: 'hi' }),
      field('b', { type: 'boolean' }, { default: true }),
      field('s', { type: 'select', options: choices }, { default: 'b' }),
      field('m', { type: 'multiSelect', options: choices }, { default: ['a'] }),
      field('n', num(), { default: 3 }),
    ];
    expect(initialValues(fields)).toEqual({ t: 'hi', b: true, s: 'b', m: ['a'], n: '3' });
  });

  it('falls back to empty values', () => {
    const fields = [
      field('t', text()),
      field('b', { type: 'boolean' }),
      field('s', { type: 'select', options: choices }),
      field('m', { type: 'multiSelect', options: choices }),
      field('n', num()),
    ];
    expect(initialValues(fields)).toEqual({ t: '', b: false, s: '', m: [], n: '' });
  });
});

describe('date-time defaults', () => {
  const f = field('d', text({ format: 'date-time' }), { default: '2026-10-20T02:30:00Z' });
  it('pre-fills a local value that passes the check and round-trips', () => {
    const values = initialValues([f]);
    expect(checkForm([f], values)).toEqual({});
    const sent = toContent([f], values).d as string;
    expect(Date.parse(sent)).toBe(Date.parse('2026-10-20T02:30:00Z'));
  });
  it('drops a default that is not RFC 3339', () => {
    const bad = field('d', text({ format: 'date-time' }), { default: 'tomorrow' });
    expect(initialValues([bad])).toEqual({ d: '' });
  });
});

describe('checkForm', () => {
  it('requires a value', () => {
    expect(msg(text(), '', true)).toBe('This field is required.');
    expect(msg(text(), '', false)).toBeUndefined();
  });
  it('checks text length in characters', () => {
    expect(msg(text({ minLength: 3 }), 'ab')).toBe('Use at least 3 characters.');
    expect(msg(text({ maxLength: 2 }), 'abc')).toBe('Use at most 2 characters.');
    expect(msg(text({ maxLength: 1 }), '😀')).toBeUndefined();
  });
  it('rejects a non-string text value', () => {
    expect(msg(text(), 5)).toBe('Use the format the agent asked for.');
  });
  it('checks numbers', () => {
    expect(msg(num(), 'x')).toBe('Use a number.');
    expect(msg(num({ integer: true }), '1.5')).toBe('Use a whole number.');
    expect(msg(num({ minimum: 2 }), '1')).toBe('Use 2 or more.');
    expect(msg(num({ maximum: 2.5 }), '3')).toBe('Use 2.5 or less.');
    expect(msg(num({ minimum: 0, maximum: 5 }), '3')).toBeUndefined();
  });
  it('checks booleans', () => {
    expect(msg({ type: 'boolean' }, 'yes')).toBe('Use yes or no.');
    expect(msg({ type: 'boolean' }, false)).toBeUndefined();
  });
  it('checks formats', () => {
    expect(msg(text({ format: 'email' }), 'a@b')).toBe('Use an email address.');
    expect(msg(text({ format: 'email' }), 'a@b.co')).toBeUndefined();
    expect(msg(text({ format: 'uri' }), 'x.y')).toBe('Use a full web address.');
    expect(msg(text({ format: 'uri' }), 'https://x.y')).toBeUndefined();
    expect(msg(text({ format: 'date' }), '20-10-2026')).toBe('Use a date.');
    expect(msg(text({ format: 'date' }), '2026-13-01')).toBe('Use a date.');
    expect(msg(text({ format: 'date' }), '2026-10-20')).toBeUndefined();
    expect(msg(text({ format: 'date-time' }), '2026-10-20')).toBe('Use a date and time.');
    expect(msg(text({ format: 'date-time' }), '2026-10-20T09:30')).toBeUndefined();
    expect(msg(text({ format: 'date-time' }), '2026-10-20T09:30:15')).toBeUndefined();
  });
  it('treats unknown or inherited formats as annotations', () => {
    for (const format of ['constructor', 'toString', '__proto__', 'phone']) {
      expect(msg(text({ format }), 'anything')).toBeUndefined();
    }
  });
  it('checks select options', () => {
    const kind: ElicitationFieldKind = { type: 'select', options: choices };
    expect(msg(kind, 'z')).toBe('Pick one of the options.');
    expect(msg(kind, 'a')).toBeUndefined();
  });
  it('checks multi-select options and counts', () => {
    const kind = (extra = {}): ElicitationFieldKind => ({
      type: 'multiSelect',
      options: choices,
      ...extra,
    });
    expect(msg(kind(), ['z'])).toBe('Pick one of the options.');
    expect(msg(kind({ minItems: 2 }), ['a'])).toBe('Pick at least 2.');
    expect(msg(kind({ maxItems: 1 }), ['a', 'b'])).toBe('Pick at most 1.');
    expect(msg(kind(), ['a', 'a'])).toBeUndefined();
  });
  it('lets an optional multi-select with a minimum stay empty; a required one still needs the minimum', () => {
    const kind: ElicitationFieldKind = { type: 'multiSelect', options: choices, minItems: 1 };
    expect(msg(kind, [])).toBeUndefined();
    expect(msg(kind, [], true)).toBe('Pick at least 1.');
    expect(toContent([field('f', kind)], { f: [] })).toEqual({});
  });
  it('keeps typed values out of messages', () => {
    expect(msg(text({ format: 'email' }), 'secret-value')).not.toContain('secret');
  });
});

describe('toContent', () => {
  it('converts numbers and omits empty optional values', () => {
    const fields = [
      field('n', num()),
      field('t', text()),
      field('e', num()),
      field('s', { type: 'select', options: choices }),
      field('b', { type: 'boolean' }),
    ];
    expect(toContent(fields, { n: '4.5', t: '', e: '', s: '', b: false })).toEqual({
      n: 4.5,
      b: false,
    });
  });
  it('adds the offset to date-time values', () => {
    const f = [field('d', text({ format: 'date-time' }))];
    expect(toContent(f, { d: '2026-10-20T09:30' }, 420)).toEqual({ d: '2026-10-20T09:30:00+07:00' });
    expect(toContent(f, { d: '2026-10-20T09:30' }, 0)).toEqual({ d: '2026-10-20T09:30:00Z' });
    expect(toContent(f, { d: '2026-10-20T09:30:15' }, -330)).toEqual({
      d: '2026-10-20T09:30:15-05:30',
    });
  });
  it('uses the offset at the entered date by default', () => {
    const f = [field('d', text({ format: 'date-time' }))];
    for (const d of ['2026-01-15T12:00', '2026-07-15T12:00']) {
      const sent = toContent(f, { d }).d as string;
      expect(Date.parse(sent)).toBe(new Date(d).getTime());
    }
  });
  it('keeps multi-select as an array', () => {
    const f = [field('m', { type: 'multiSelect', options: choices })];
    expect(toContent(f, { m: ['a', 'b'] })).toEqual({ m: ['a', 'b'] });
  });
});

describe('canSubmit', () => {
  it('is false with an unsupported field', () => {
    expect(canSubmit([field('u', { type: 'unsupported', rawType: 'object' })])).toBe(false);
    expect(canSubmit([field('t', text())])).toBe(true);
  });
});
