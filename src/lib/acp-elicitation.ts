import type {
  ChatMessage,
  ElicitationCard,
  ElicitationChoice,
  ElicitationField,
  ElicitationFieldKind,
  ElicitationStatus,
} from '../types';
import { isAwaitingPermission, openReplyIndex, withOpenReply, type AcpReducerContext } from './acp-events';

/**
 * Elicitation cards: questions an agent asks the user. The payload comes from
 * the agent, so it is shape-checked. A card never holds what the user typed,
 * and once answered it drops its fields and url.
 */

/** Prefix of the backend error that carries field errors as JSON. */
export const ELICITATION_INVALID_PREFIX = 'ELICITATION_INVALID:';
/** The backend error for a request that is no longer waiting. */
export const ELICITATION_GONE = 'This request can no longer be answered.';

type Json = Record<string, unknown>;
type Warning = NonNullable<ElicitationCard['warnings']>[number];

const WARNINGS: readonly Warning[] = ['punycode', 'ip-address', 'user-info'];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Keeps only the entries whose value is defined, so absent stays absent. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function toChoices(options: unknown): ElicitationChoice[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const choices: ElicitationChoice[] = [];
  for (const option of options) {
    if (!isObject(option)) return undefined;
    const value = str(option.value);
    const title = str(option.title);
    if (value === undefined || title === undefined) return undefined;
    choices.push(defined({ value, title, description: str(option.description) }));
  }
  return choices;
}

/** A kind that could not be read; the card blocks Submit rather than hide the field. */
const unreadable = (rawType: string): ElicitationFieldKind => ({ type: 'unsupported', rawType });

/** Never undefined: anything unparseable becomes an `unsupported` kind. */
function toKind(kind: unknown): ElicitationFieldKind {
  if (!isObject(kind)) return unreadable('invalid');
  const rawType = str(kind.type) ?? 'invalid';
  switch (kind.type) {
    case 'text':
      return defined({
        type: 'text' as const,
        format: str(kind.format),
        minLength: num(kind.minLength),
        maxLength: num(kind.maxLength),
      });
    case 'number':
      return defined({
        type: 'number' as const,
        integer: kind.integer === true,
        minimum: num(kind.minimum),
        maximum: num(kind.maximum),
      });
    case 'boolean':
      return { type: 'boolean' };
    case 'select': {
      const options = toChoices(kind.options);
      return options ? { type: 'select', options } : unreadable(rawType);
    }
    case 'multiSelect': {
      const options = toChoices(kind.options);
      return options
        ? defined({ type: 'multiSelect' as const, options, minItems: num(kind.minItems), maxItems: num(kind.maxItems) })
        : unreadable(rawType);
    }
    case 'unsupported':
      return unreadable(str(kind.rawType) ?? 'invalid');
    default:
      return unreadable(rawType);
  }
}

/** A field, or undefined when it has no usable name (the whole card is then malformed). */
function toField(field: unknown): ElicitationField | undefined {
  if (!isObject(field)) return undefined;
  const name = str(field.name);
  if (!name) return undefined;
  return defined({
    name,
    title: str(field.title),
    description: str(field.description),
    required: field.required === true,
    kind: toKind(field.kind),
    default: field.default ?? undefined,
  });
}

/** A card for a request from the agent, or null when the payload is malformed. */
export function toElicitationCard(
  sessionId: string,
  key: unknown,
  request: unknown,
  now: number,
): ElicitationCard | null {
  if (typeof key !== 'string' || !key || !isObject(request)) return null;
  const message = str(request.message);
  if (message === undefined) return null;
  const base = { key, sessionId, message, status: 'pending' as const, timestamp: now };
  if (request.mode === 'form') {
    if (!Array.isArray(request.fields)) return null;
    const fields = request.fields.map(toField);
    if (fields.some((f) => f === undefined)) return null;
    return { ...base, mode: 'form', fields: fields as ElicitationField[] };
  }
  if (request.mode === 'url') {
    const url = str(request.url);
    const host = str(request.host);
    if (!url || host === undefined) return null;
    const warnings = Array.isArray(request.warnings)
      ? request.warnings.filter((w): w is Warning => WARNINGS.includes(w as Warning))
      : [];
    return defined({ ...base, mode: 'url' as const, url, host, warnings, blocked: str(request.blocked) });
  }
  return null;
}

/** The field errors in a refused submit, or null for any other error. */
export function parseInvalidElicitation(error: unknown): Record<string, string> | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!text.startsWith(ELICITATION_INVALID_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(ELICITATION_INVALID_PREFIX.length));
    if (!isObject(parsed)) return null;
    const errors: Record<string, string> = {};
    for (const [name, message] of Object.entries(parsed)) {
      if (typeof message === 'string') errors[name] = message;
    }
    return errors;
  } catch {
    return null;
  }
}

/** Shows an elicitation on the current reply; a reply holds one, so a second gets its own message. */
export function applyElicitation(
  messages: ChatMessage[],
  card: ElicitationCard,
  ctx: AcpReducerContext,
): ChatMessage[] {
  const withCard = (reply: ChatMessage): ChatMessage => ({ ...reply, elicitation: card });
  const open = messages[openReplyIndex(messages)];
  if (open?.elicitation) {
    return [...messages, withCard({ id: ctx.createId('msg'), role: 'agent', content: '', timestamp: ctx.now })];
  }
  return withOpenReply(messages, ctx, withCard);
}

/** The card as it is kept once it is no longer waiting: no fields, url or errors; the host stays. */
function settled(card: ElicitationCard, status: ElicitationStatus): ElicitationCard {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { fields, url, errors, ...rest } = card;
  return { ...rest, status };
}

function mapCard(
  messages: readonly ChatMessage[],
  matches: (card: ElicitationCard) => boolean,
  change: (card: ElicitationCard) => ElicitationCard,
): ChatMessage[] {
  return messages.map((message) =>
    message.elicitation && matches(message.elicitation)
      ? { ...message, elicitation: change(message.elicitation) }
      : message,
  );
}

/** Moves one card to `status`. A card that is no longer pending loses its fields and url. */
export function setElicitationStatus(
  messages: ChatMessage[],
  key: string,
  status: ElicitationStatus,
): ChatMessage[] {
  return mapCard(
    messages,
    (card) => card.key === key,
    (card) => (status === 'pending' ? { ...card, status } : settled(card, status)),
  );
}

/** Puts a refused submit back to pending with the field errors to show. */
export function rejectElicitationSubmit(
  messages: ChatMessage[],
  key: string,
  errors: Record<string, string>,
): ChatMessage[] {
  return mapCard(
    messages,
    (card) => card.key === key,
    (card) => ({ ...card, status: 'pending', errors }),
  );
}

/** The agent reported a URL elicitation done; only a card the user opened can complete. */
export function completeElicitation(messages: ChatMessage[], key: string): ChatMessage[] {
  return mapCard(
    messages,
    (card) => card.key === key && card.status === 'opened',
    (card) => settled(card, 'completed'),
  );
}

/** Dismisses every card still waiting, e.g. when the user stops the turn. */
export function dismissPendingElicitations(messages: ChatMessage[]): ChatMessage[] {
  return mapCard(messages, (card) => card.status === 'pending', (card) => settled(card, 'dismissed'));
}

/** Cards that were open when the app closed can no longer be answered. */
export function markElicitationsUnanswered(messages: ChatMessage[]): ChatMessage[] {
  return mapCard(
    messages,
    (card) => card.status === 'pending' || card.status === 'opened',
    (card) => settled(card, 'unanswered'),
  );
}

/** Whether any elicitation is still waiting for an answer. */
export function hasPendingElicitation(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.elicitation?.status === 'pending');
}

/** Whether the agent waits on the user: a permission request this turn, or any open elicitation. */
export function isAwaitingUser(messages: readonly ChatMessage[]): boolean {
  return isAwaitingPermission(messages) || hasPendingElicitation(messages);
}
