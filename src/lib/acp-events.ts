import type {
  ActionCard,
  ChatMessage,
  PermissionChoice,
  PlanEntry,
  ToolDetail,
  ToolExecution,
} from '../types';
import { fileNameOf } from './attachments';

/**
 * Folds Agent Client Protocol session updates into chat messages.
 *
 * Everything here comes from the agent process, so it is treated as untrusted:
 * shapes are checked and anything unexpected is ignored rather than rendered.
 */

export interface AcpReducerContext {
  sessionId: string;
  now: number;
  createId: (prefix: string) => string;
  /** False while folding a replay: the agent gives no per-message time. */
  hasKnownTime?: boolean;
}

export interface PermissionRequestPayload {
  requestId: string | number;
  toolCall: unknown;
  options: unknown;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The time fields for a new message: a replay's messages carry no known time. */
function messageTime(ctx: AcpReducerContext): Pick<ChatMessage, 'timestamp' | 'hasKnownTime'> {
  return ctx.hasKnownTime === false
    ? { timestamp: ctx.now, hasKnownTime: false }
    : { timestamp: ctx.now };
}

/** The text of a content block, or undefined for images, audio and the like. */
function textOf(content: unknown): string | undefined {
  return isObject(content) && content.type === 'text' ? str(content.text) : undefined;
}

function toToolStatus(status: unknown): ToolExecution['status'] | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return undefined;
}

/** The reply new agent output belongs to: the last agent message, unless it is finished. */
export function openReplyIndex(messages: readonly ChatMessage[]): number {
  const last = messages[messages.length - 1];
  const isOpen =
    last?.role === 'agent' &&
    !last.isComplete &&
    (!last.actionCard || last.actionCard.status === 'pending') &&
    (!last.elicitation || last.elicitation.status === 'pending');
  return isOpen ? messages.length - 1 : -1;
}

/** Applies `change` to the open reply, creating one when needed. */
export function withOpenReply(
  messages: readonly ChatMessage[],
  ctx: AcpReducerContext,
  change: (reply: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = openReplyIndex(messages);
  if (index >= 0) {
    return messages.map((m, i) => (i === index ? change(m) : m));
  }
  const fresh: ChatMessage = { id: ctx.createId('msg'), role: 'agent', content: '', ...messageTime(ctx) };
  return [...messages, change(fresh)];
}

/** Tool output is kept in memory and in the saved transcript, so it is bounded. */
const MAX_TOOL_TEXT = 50_000;
const MAX_DIFF_TEXT = 200_000;
const TRUNCATED_MARK = '… earlier output not shown\n';

/** The end of the output matters most (the result, the error), so that is what is kept. */
function boundedText(text: string): string {
  return text.length <= MAX_TOOL_TEXT ? text : TRUNCATED_MARK + text.slice(text.length - MAX_TOOL_TEXT);
}

/** Diffs and text output from a tool's `content`; terminals (not offered by this client) are skipped. */
function toDetails(content: unknown): ToolDetail[] | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.filter(isObject).flatMap((item): ToolDetail[] => {
    if (item.type === 'diff') {
      const path = str(item.path);
      const newText = str(item.newText);
      if (!path || newText === undefined) return [];
      const oldText = str(item.oldText) ?? null;
      if (newText.length + (oldText?.length ?? 0) > MAX_DIFF_TEXT) {
        return [{ kind: 'text', text: `Changed ${path} (too large to show)` }];
      }
      return [{ kind: 'diff', path, oldText, newText }];
    }
    if (item.type === 'content') {
      const text = textOf(item.content);
      return text ? [{ kind: 'text', text: boundedText(text) }] : [];
    }
    return [];
  });
}

function toLocations(locations: unknown): string[] | undefined {
  if (!Array.isArray(locations)) return undefined;
  return locations.filter(isObject).flatMap((location) => {
    const path = str(location.path);
    if (!path) return [];
    return [typeof location.line === 'number' ? `${path}:${location.line}` : path];
  });
}

function addToolCall(messages: readonly ChatMessage[], update: Json, ctx: AcpReducerContext): ChatMessage[] {
  const id = str(update.toolCallId);
  if (!id) return [...messages];
  const tool: ToolExecution = {
    id,
    name: str(update.title) ?? 'Tool',
    status: toToolStatus(update.status) ?? 'running',
    kind: str(update.kind),
    details: toDetails(update.content),
    locations: toLocations(update.locations),
  };
  return withOpenReply(messages, ctx, (reply) => ({ ...reply, tools: [...(reply.tools ?? []), tool] }));
}

/** Applies a tool_call_update: fields it carries replace the old ones (content as a whole), the rest stay. */
function updateToolCall(messages: readonly ChatMessage[], update: Json): ChatMessage[] {
  const id = str(update.toolCallId);
  const status = toToolStatus(update.status);
  const title = str(update.title);
  const details = toDetails(update.content);
  const locations = toLocations(update.locations);
  return messages.map((message) => {
    if (!message.tools?.some((t) => t.id === id)) return message;
    return {
      ...message,
      tools: message.tools.map((tool) =>
        tool.id === id
          ? {
              ...tool,
              status: status ?? tool.status,
              name: title ?? tool.name,
              details: details ?? tool.details,
              locations: locations ?? tool.locations,
            }
          : tool,
      ),
    };
  });
}

function toPlan(entries: unknown): PlanEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(isObject).flatMap((entry) => {
    const content = str(entry.content);
    const status = entry.status;
    if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return [];
    return [{ content, status, priority: str(entry.priority) }];
  });
}

/** Applies one `session/update` payload. Unknown or malformed updates leave `messages` as is. */
export function applyAcpUpdate(
  messages: ChatMessage[],
  update: unknown,
  ctx: AcpReducerContext,
): ChatMessage[] {
  if (!isObject(update)) return messages;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      // Agents send stray empty chunks (Qwen Code does after a turn); they must not open a blank reply.
      const chunk = textOf(update.content);
      if (!chunk) return messages;
      return withOpenReply(messages, ctx, (reply) => ({ ...reply, content: reply.content + chunk }));
    }
    case 'agent_thought_chunk': {
      const chunk = textOf(update.content);
      if (!chunk) return messages;
      return withOpenReply(messages, ctx, (reply) => ({ ...reply, thinking: (reply.thinking ?? '') + chunk }));
    }
    case 'tool_call':
      return addToolCall(messages, update, ctx);
    case 'tool_call_update':
      return updateToolCall(messages, update);
    case 'plan':
      return withOpenReply(messages, ctx, (reply) => ({ ...reply, plan: toPlan(update.entries) }));
    default:
      return messages;
  }
}

/** What a replayed user block shows: its text, or the file name of a block that has a URI. */
function replayContentOf(content: unknown): string | undefined {
  const text = textOf(content);
  if (text !== undefined) return text;
  const uri = isObject(content) ? str(content.uri) : undefined;
  return uri ? fileNameOf(uri) : undefined;
}

/**
 * Applies one `session/update` from a `session/load` replay. A user chunk ends
 * the agent's open reply and starts (or continues) the user's message; every
 * other update goes to the normal reducer.
 */
export function applyReplayUpdate(
  messages: ChatMessage[],
  update: unknown,
  ctx: AcpReducerContext,
): ChatMessage[] {
  // A replay carries no per-message time, so nothing it adds gets one.
  const replayCtx: AcpReducerContext = { ...ctx, hasKnownTime: false };
  if (!isObject(update) || update.sessionUpdate !== 'user_message_chunk') {
    return applyAcpUpdate(messages, update, replayCtx);
  }
  const chunk = replayContentOf(update.content);
  if (!chunk) return messages;
  const messageId = str(update.messageId);
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  // Chunks the agent gave a messageId continue that message; without one, adjacent chunks do.
  if (last?.role === 'user' && last.replayId === messageId) {
    return messages.map((m, i) => (i === lastIndex ? { ...m, content: m.content + chunk } : m));
  }
  const closed = messages.map((m, i) =>
    i === lastIndex && m.role === 'agent' && !m.isComplete ? { ...m, isComplete: true } : m,
  );
  return [
    ...closed,
    {
      id: ctx.createId('msg'),
      role: 'user',
      content: chunk,
      ...messageTime(replayCtx),
      ...(messageId === undefined ? {} : { replayId: messageId }),
    },
  ];
}

function toChoices(options: unknown): PermissionChoice[] {
  if (!Array.isArray(options)) return [];
  return options.filter(isObject).flatMap((option) => {
    const optionId = str(option.optionId);
    const name = str(option.name);
    return optionId && name ? [{ optionId, name, kind: str(option.kind) ?? 'allow_once' }] : [];
  });
}

/** Shows an agent's permission request as an action card on the current reply. */
export function applyPermissionRequest(
  messages: ChatMessage[],
  payload: PermissionRequestPayload,
  ctx: AcpReducerContext,
): ChatMessage[] {
  const toolCall = isObject(payload.toolCall) ? payload.toolCall : {};
  const rawInput = isObject(toolCall.rawInput) ? toolCall.rawInput : {};
  const title = str(toolCall.title) ?? 'The agent asks for permission';
  const card: ActionCard = {
    id: ctx.createId('act'),
    sessionId: ctx.sessionId,
    title: 'Permission requested',
    prompt: title,
    commandSnippet: str(rawInput.command),
    toolName: str(toolCall.kind),
    status: 'pending',
    timestamp: ctx.now,
    options: toChoices(payload.options),
    requestId: payload.requestId,
  };
  const withCard = (reply: ChatMessage) => ({ ...reply, actionCard: card });
  // A reply holds one card: a second request while the first waits gets its own message.
  const open = messages[openReplyIndex(messages)];
  if (open?.actionCard) {
    return [...messages, withCard({ id: ctx.createId('msg'), role: 'agent', content: '', ...messageTime(ctx) })];
  }
  return withOpenReply(messages, ctx, withCard);
}

const isPendingRequest = (card: ActionCard | undefined): card is ActionCard =>
  card?.status === 'pending' && card.requestId !== undefined;

/**
 * The unanswered cards of the current turn (after the last user message),
 * oldest first: only that turn can hold one, so the walk stops there instead
 * of scanning the whole transcript.
 */
export function pendingCardsInTurn(messages: readonly ChatMessage[]): ActionCard[] {
  const cards: ActionCard[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'user'; i--) {
    const card = messages[i].actionCard;
    if (isPendingRequest(card)) cards.unshift(card);
  }
  return cards;
}

/** Whether the agent waits on the user to answer a request in the current turn. */
export function isAwaitingPermission(messages: readonly ChatMessage[]): boolean {
  return pendingCardsInTurn(messages).length > 0;
}

/** Records the option the user picked on a permission card. */
export function resolvePermissionCard(
  messages: ChatMessage[],
  cardId: string,
  optionId: string,
): ChatMessage[] {
  return messages.map((message) => {
    const card = message.actionCard;
    if (card?.id !== cardId) return message;
    const kind = card.options?.find((o) => o.optionId === optionId)?.kind ?? '';
    const status: ActionCard['status'] = kind.startsWith('reject') ? 'rejected' : 'approved';
    return { ...message, actionCard: { ...card, status, chosenOptionId: optionId } };
  });
}

/** Puts an answered card back to pending, e.g. when the answer never reached the agent. */
export function reopenPermissionCard(messages: ChatMessage[], cardId: string): ChatMessage[] {
  return messages.map((message) => {
    const card = message.actionCard;
    if (card?.id !== cardId) return message;
    return { ...message, actionCard: { ...card, status: 'pending', chosenOptionId: undefined } };
  });
}

/**
 * Tools still running when an imported turn ended: a replay carries no terminal
 * update for a tool that was running when the agent stopped, so the tool never
 * reported success and is shown as failed rather than running forever.
 */
function settleTools(tools: ToolExecution[] | undefined): ToolExecution[] | undefined {
  if (!tools?.some((tool) => tool.status === 'running')) return tools;
  return tools.map((tool) => (tool.status === 'running' ? { ...tool, status: 'failed' } : tool));
}

/**
 * Ends the agent's turn: the last reply is complete and permission requests
 * that were never answered can no longer be (the agent stopped waiting).
 *
 * Tools still running keep their real state: a live turn can end while one is
 * genuinely running (the user stopped it, or it runs in the background).
 */
export function closeTurn(messages: ChatMessage[]): ChatMessage[] {
  const lastIndex = messages.length - 1;
  return messages.map((message, index) => {
    const card = isPendingRequest(message.actionCard)
      ? { ...message.actionCard, status: 'rejected' as const }
      : message.actionCard;
    const isLastReply = index === lastIndex && message.role === 'agent';
    if (card === message.actionCard && !isLastReply) return message;
    return {
      ...message,
      actionCard: card,
      ...(isLastReply ? { isComplete: true } : {}),
    };
  });
}

/**
 * Ends a turn folded from a `session/load` replay: like `closeTurn`, and tools
 * the replay left running are settled as failed — nothing is running now.
 */
export function closeImportedTurn(messages: ChatMessage[]): ChatMessage[] {
  return closeTurn(messages).map((message) => {
    const tools = settleTools(message.tools);
    return tools === message.tools ? message : { ...message, tools };
  });
}
