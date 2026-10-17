import type {
  ActionCard,
  ChatMessage,
  PermissionChoice,
  PlanEntry,
  ToolExecution,
} from '../types';

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
function openReplyIndex(messages: readonly ChatMessage[]): number {
  const last = messages[messages.length - 1];
  const isOpen =
    last?.role === 'agent' && !last.isComplete && (!last.actionCard || last.actionCard.status === 'pending');
  return isOpen ? messages.length - 1 : -1;
}

/** Applies `change` to the open reply, creating one when needed. */
function withOpenReply(
  messages: readonly ChatMessage[],
  ctx: AcpReducerContext,
  change: (reply: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = openReplyIndex(messages);
  if (index >= 0) {
    return messages.map((m, i) => (i === index ? change(m) : m));
  }
  const fresh: ChatMessage = { id: ctx.createId('msg'), role: 'agent', content: '', timestamp: ctx.now };
  return [...messages, change(fresh)];
}

function addToolCall(messages: readonly ChatMessage[], update: Json, ctx: AcpReducerContext): ChatMessage[] {
  const id = str(update.toolCallId);
  if (!id) return [...messages];
  const tool: ToolExecution = {
    id,
    name: str(update.title) ?? 'Tool',
    args: '',
    status: toToolStatus(update.status) ?? 'running',
    kind: str(update.kind),
  };
  return withOpenReply(messages, ctx, (reply) => ({ ...reply, tools: [...(reply.tools ?? []), tool] }));
}

function updateToolCall(messages: readonly ChatMessage[], update: Json): ChatMessage[] {
  const id = str(update.toolCallId);
  const status = toToolStatus(update.status);
  const title = str(update.title);
  return messages.map((message) => {
    if (!message.tools?.some((t) => t.id === id)) return message;
    return {
      ...message,
      tools: message.tools.map((tool) =>
        tool.id === id ? { ...tool, status: status ?? tool.status, name: title ?? tool.name } : tool,
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
    approvalKey: '',
    rejectKey: '',
    timestamp: ctx.now,
    options: toChoices(payload.options),
    requestId: payload.requestId,
  };
  const withCard = (reply: ChatMessage) => ({ ...reply, actionCard: card });
  // A reply holds one card: a second request while the first waits gets its own message.
  const open = messages[openReplyIndex(messages)];
  if (open?.actionCard) {
    return [...messages, withCard({ id: ctx.createId('msg'), role: 'agent', content: '', timestamp: ctx.now })];
  }
  return withOpenReply(messages, ctx, withCard);
}

const isPendingRequest = (card: ActionCard | undefined): card is ActionCard =>
  card?.status === 'pending' && card.requestId !== undefined;

/** Permission requests the agent is still waiting on. */
export function pendingPermissionCards(messages: readonly ChatMessage[]): ActionCard[] {
  return messages.map((m) => m.actionCard).filter(isPendingRequest);
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
 * Ends the agent's turn: the last reply is complete, and permission requests
 * that were never answered can no longer be (the agent stopped waiting).
 */
export function closeTurn(messages: ChatMessage[]): ChatMessage[] {
  const lastIndex = messages.length - 1;
  return messages.map((message, index) => {
    const card = isPendingRequest(message.actionCard)
      ? { ...message.actionCard, status: 'rejected' as const }
      : message.actionCard;
    const isLastReply = index === lastIndex && message.role === 'agent';
    if (card === message.actionCard && !isLastReply) return message;
    return { ...message, actionCard: card, ...(isLastReply ? { isComplete: true } : {}) };
  });
}
