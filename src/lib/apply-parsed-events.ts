import type {
  ActionCard,
  AgentProfile,
  ChatMessage,
  ParsedStreamEvent,
  ToolExecution,
} from '../types';

export interface ApplyParsedEventsContext {
  sessionId: string;
  profile?: AgentProfile;
  now: number;
  createId: (prefix: string) => string;
}

const APPROVAL_CARD_TITLE = '⚠️ Agent Action Approval Required';
const DEFAULT_APPROVAL_KEY = 'y\n';
const DEFAULT_REJECT_KEY = 'n\n';

function lastAgentMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  const last = messages[messages.length - 1];
  return last?.role === 'agent' ? last : undefined;
}

function replaceLast(messages: readonly ChatMessage[], next: ChatMessage): ChatMessage[] {
  return [...messages.slice(0, -1), next];
}

function newAgentMessage(
  ctx: ApplyParsedEventsContext,
  fields: Partial<ChatMessage>,
): ChatMessage {
  return {
    id: ctx.createId('msg'),
    role: 'agent',
    content: '',
    timestamp: ctx.now,
    ...fields,
  };
}

function applyText(
  messages: readonly ChatMessage[],
  content: string,
  ctx: ApplyParsedEventsContext,
): ChatMessage[] {
  const last = lastAgentMessage(messages);
  if (last && !last.actionCard) {
    // Chunks are raw PTY reads, so they already carry their own newlines.
    return replaceLast(messages, { ...last, content: last.content + content });
  }
  return [...messages, newAgentMessage(ctx, { content })];
}

function applyToolStart(
  messages: readonly ChatMessage[],
  event: ParsedStreamEvent,
  ctx: ApplyParsedEventsContext,
): ChatMessage[] {
  const tool: ToolExecution = {
    id: ctx.createId('tool'),
    name: event.metadata?.tool || 'Tool',
    args: event.metadata?.args || '',
    status: 'running',
  };
  const last = lastAgentMessage(messages);
  if (last) {
    return replaceLast(messages, { ...last, tools: [...(last.tools ?? []), tool] });
  }
  return [...messages, newAgentMessage(ctx, { tools: [tool] })];
}

function applyApprovalRequest(
  messages: readonly ChatMessage[],
  event: ParsedStreamEvent,
  ctx: ApplyParsedEventsContext,
): ChatMessage[] {
  const actionCard: ActionCard = {
    id: ctx.createId('act'),
    sessionId: ctx.sessionId,
    title: APPROVAL_CARD_TITLE,
    prompt: event.content,
    commandSnippet: event.metadata?.commandSnippet,
    toolName: event.metadata?.tool,
    status: 'pending',
    approvalKey: ctx.profile?.approval_key || DEFAULT_APPROVAL_KEY,
    rejectKey: ctx.profile?.reject_key || DEFAULT_REJECT_KEY,
    timestamp: ctx.now,
  };
  const last = lastAgentMessage(messages);
  if (last) {
    return replaceLast(messages, { ...last, actionCard });
  }
  return [...messages, newAgentMessage(ctx, { actionCard })];
}

/**
 * Folds parsed PTY stream events into a session's chat messages without
 * mutating the input array.
 */
export function applyParsedEvents(
  messages: readonly ChatMessage[],
  events: readonly ParsedStreamEvent[],
  ctx: ApplyParsedEventsContext,
): ChatMessage[] {
  return events.reduce<ChatMessage[]>((acc, event) => {
    switch (event.type) {
      case 'text':
        return applyText(acc, event.content, ctx);
      case 'tool_start':
        return applyToolStart(acc, event, ctx);
      case 'approval_request':
        return applyApprovalRequest(acc, event, ctx);
      case 'idle':
        return acc;
    }
  }, [...messages]);
}
