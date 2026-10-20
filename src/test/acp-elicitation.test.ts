import { describe, it, expect } from 'vitest';
import {
  applyElicitation,
  completeElicitation,
  dismissPendingElicitations,
  hasPendingElicitation,
  isAwaitingUser,
  markElicitationsUnanswered,
  parseInvalidElicitation,
  rejectElicitationSubmit,
  setElicitationStatus,
  toElicitationCard,
} from '../lib/acp-elicitation';
import { closeTurn, type AcpReducerContext } from '../lib/acp-events';
import type { ChatMessage, ElicitationCard } from '../types';

let counter = 0;
const ctx: AcpReducerContext = { sessionId: 's-1', now: 100, createId: (p) => `${p}-${++counter}` };

const formRequest = {
  mode: 'form',
  message: 'Which date?',
  fields: [
    {
      name: 'when',
      title: 'When',
      description: null,
      required: true,
      kind: { type: 'text', format: 'date', minLength: null, maxLength: null },
      default: null,
    },
    { name: 'weird', title: null, description: null, required: false, kind: { type: 'mystery' }, default: null },
    {
      name: 'tags',
      title: null,
      description: null,
      required: false,
      kind: { type: 'multiSelect', options: [{ value: 'a', title: 'A', description: null }], minItems: 1, maxItems: null },
      default: null,
    },
  ],
};

const urlRequest = { mode: 'url', message: 'Sign in', url: 'https://example.com/auth', host: 'example.com', warnings: ['punycode'], blocked: null };

const card = (key: string, extra: Partial<ElicitationCard> = {}): ElicitationCard =>
  ({ key, sessionId: 's-1', mode: 'url', message: 'm', status: 'pending', timestamp: 1, url: 'https://x.test', host: 'x.test', ...extra });

const reply = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'a1', role: 'agent', content: '', timestamp: 1, ...extra });

describe('toElicitationCard', () => {
  it('builds_a_card_from_a_form_payload', () => {
    const result = toElicitationCard('s-1', 'k1', formRequest, 5);

    expect(result).toMatchObject({ key: 'k1', sessionId: 's-1', mode: 'form', message: 'Which date?', status: 'pending', timestamp: 5 });
    expect(result?.fields?.map((f) => f.name)).toEqual(['when', 'weird', 'tags']);
    expect(result?.fields?.[0]).toEqual({ name: 'when', title: 'When', required: true, kind: { type: 'text', format: 'date' } });
    expect(result?.fields?.[1].kind).toEqual({ type: 'unsupported', rawType: 'mystery' });
    expect(result?.fields?.[2].kind).toEqual({ type: 'multiSelect', options: [{ value: 'a', title: 'A' }], minItems: 1 });
  });

  it('builds a card from a url payload', () => {
    const result = toElicitationCard('s-1', 'k1', urlRequest, 5);

    expect(result).toMatchObject({ mode: 'url', url: 'https://example.com/auth', host: 'example.com', warnings: ['punycode'] });
    expect(result?.blocked).toBeUndefined();
  });

  it('returns_null_for_malformed_payloads', () => {
    expect(toElicitationCard('s-1', undefined, formRequest, 1)).toBeNull();
    expect(toElicitationCard('s-1', '', formRequest, 1)).toBeNull();
    expect(toElicitationCard('s-1', 'k', { message: 'x', fields: [] }, 1)).toBeNull();
    expect(toElicitationCard('s-1', 'k', { mode: 'form', message: 'x', fields: 'nope' }, 1)).toBeNull();
    expect(toElicitationCard('s-1', 'k', { mode: 'url', message: 'x' }, 1)).toBeNull();
    expect(toElicitationCard('s-1', 'k', null, 1)).toBeNull();
  });

  const withField = (field: unknown) => toElicitationCard('s-1', 'k', { mode: 'form', message: 'm', fields: [field] }, 1);

  it('returns null when a field has no usable name', () => {
    expect(withField({ required: true, kind: { type: 'boolean' } })).toBeNull();
    expect(withField({ name: 3, kind: { type: 'boolean' } })).toBeNull();
    expect(withField('nope')).toBeNull();
  });

  it('keeps a field with a malformed option list as unsupported', () => {
    const result = withField({
      name: 'pick',
      required: true,
      kind: { type: 'select', options: [{ value: 'a', title: 'A' }, { value: 1 }] },
    });

    expect(result?.fields?.[0]).toMatchObject({ name: 'pick', required: true, kind: { type: 'unsupported', rawType: 'select' } });
  });

  it('gives an unsupported kind without rawType the rawType invalid', () => {
    expect(withField({ name: 'x', kind: { type: 'unsupported' } })?.fields?.[0].kind).toEqual({ type: 'unsupported', rawType: 'invalid' });
    expect(withField({ name: 'x', kind: 'bad' })?.fields?.[0].kind).toEqual({ type: 'unsupported', rawType: 'invalid' });
  });
});

describe('applyElicitation', () => {
  it('attaches_to_the_open_reply', () => {
    const result = applyElicitation([reply()], card('k1'), ctx);

    expect(result).toHaveLength(1);
    expect(result[0].elicitation?.key).toBe('k1');
  });

  it('starts_a_new_reply_when_the_open_one_already_has_an_elicitation', () => {
    const result = applyElicitation([reply({ elicitation: card('k1') })], card('k2'), ctx);

    expect(result).toHaveLength(2);
    expect(result[1].elicitation?.key).toBe('k2');
  });

  it('starts_a_new_reply_after_a_finished_turn', () => {
    const result = applyElicitation([reply({ isComplete: true })], card('k1'), ctx);

    expect(result).toHaveLength(2);
  });

  it('does not mutate the messages it was given', () => {
    const input = [reply()];
    applyElicitation(input, card('k1'), ctx);

    expect(input[0].elicitation).toBeUndefined();
  });
});

describe('status changes', () => {
  const two = (): ChatMessage[] => [reply({ id: 'a', elicitation: card('k1') }), reply({ id: 'b', elicitation: card('k2') })];

  it('keeps_two_cards_apart', () => {
    const result = setElicitationStatus(two(), 'k1', 'opened');

    expect(result[0].elicitation?.status).toBe('opened');
    expect(result[1].elicitation?.status).toBe('pending');
  });

  it('strips_fields_and_url_once_answered', () => {
    const opened = setElicitationStatus(two(), 'k1', 'opened');
    expect(opened[0].elicitation).not.toHaveProperty('url');
    expect(opened[0].elicitation?.host).toBe('x.test');

    const form = [reply({ elicitation: card('f', { mode: 'form', fields: [{ name: 'a', required: false, kind: { type: 'boolean' } }], errors: { a: 'x' } }) })];
    const submitted = setElicitationStatus(form, 'f', 'submitted');
    expect(submitted[0].elicitation).not.toHaveProperty('fields');
    expect(submitted[0].elicitation).not.toHaveProperty('errors');
  });

  it('rejectElicitationSubmit puts the card back to pending with errors', () => {
    const form = [reply({ elicitation: card('f', { mode: 'form', status: 'submitted' }) })];
    const result = rejectElicitationSubmit(form, 'f', { name: 'Use a date.' });

    expect(result[0].elicitation).toMatchObject({ status: 'pending', errors: { name: 'Use a date.' } });
  });

  it('completeElicitation moves opened to completed and leaves other statuses alone', () => {
    const messages = [reply({ id: 'a', elicitation: card('k1', { status: 'opened' }) }), reply({ id: 'b', elicitation: card('k2') })];

    expect(completeElicitation(messages, 'k1')[0].elicitation?.status).toBe('completed');
    expect(completeElicitation(messages, 'k2')[1].elicitation?.status).toBe('pending');
  });

  it('dismissPendingElicitations dismisses only pending cards', () => {
    const messages = [reply({ id: 'a', elicitation: card('k1') }), reply({ id: 'b', elicitation: card('k2', { status: 'opened' }) })];
    const result = dismissPendingElicitations(messages);

    expect(result[0].elicitation?.status).toBe('dismissed');
    expect(result[1].elicitation?.status).toBe('opened');
  });

  it('markElicitationsUnanswered settles pending and opened cards', () => {
    const messages = [reply({ id: 'a', elicitation: card('k1') }), reply({ id: 'b', elicitation: card('k2', { status: 'opened' }) }), reply({ id: 'c', elicitation: card('k3', { status: 'completed' }) })];
    const result = markElicitationsUnanswered(messages);

    expect(result.map((m) => m.elicitation?.status)).toEqual(['unanswered', 'unanswered', 'completed']);
    expect(result[0].elicitation).not.toHaveProperty('url');
  });
});

describe('parseInvalidElicitation', () => {
  it('reads the field errors', () => {
    expect(parseInvalidElicitation('ELICITATION_INVALID:{"name":"Use a date."}')).toEqual({ name: 'Use a date.' });
    expect(parseInvalidElicitation(new Error('ELICITATION_INVALID:{"a":"b"}'))).toEqual({ a: 'b' });
  });

  it('returns null for other strings', () => {
    expect(parseInvalidElicitation('boom')).toBeNull();
    expect(parseInvalidElicitation('ELICITATION_INVALID:not json')).toBeNull();
    expect(parseInvalidElicitation(42)).toBeNull();
  });
});

describe('waiting on the user', () => {
  it('isAwaitingUser is true for a pending permission card', () => {
    const permission = reply({ actionCard: { id: 'c', sessionId: 's', title: 't', prompt: 'p', status: 'pending', timestamp: 1, requestId: 1 } });

    expect(isAwaitingUser([{ id: 'u', role: 'user', content: 'hi', timestamp: 0 }, permission])).toBe(true);
  });

  it('isAwaitingUser is true for a pending elicitation even before the last user message', () => {
    const messages: ChatMessage[] = [reply({ elicitation: card('k1') }), { id: 'u', role: 'user', content: 'hi', timestamp: 2 }];

    expect(isAwaitingUser(messages)).toBe(true);
    expect(hasPendingElicitation(messages)).toBe(true);
  });

  it('isAwaitingUser is false otherwise', () => {
    expect(isAwaitingUser([reply({ elicitation: card('k1', { status: 'opened' }) })])).toBe(false);
    expect(hasPendingElicitation([reply()])).toBe(false);
  });

  it('closeTurn leaves a pending elicitation pending', () => {
    const result = closeTurn([reply({ elicitation: card('k1') })]);

    expect(result[0].elicitation?.status).toBe('pending');
    expect(result[0].isComplete).toBe(true);
  });
});
