import { describe, it, expect } from 'vitest';
import { applyParsedEvents, type ApplyParsedEventsContext } from '../lib/apply-parsed-events';
import { StreamParser } from '../lib/stream-parser';
import type { AgentProfile, ChatMessage } from '../types';

function makeContext(overrides: Partial<ApplyParsedEventsContext> = {}): ApplyParsedEventsContext {
  let counter = 0;
  return {
    sessionId: 's-1',
    now: 1_000,
    createId: (prefix) => `${prefix}-${++counter}`,
    ...overrides,
  };
}

describe('applyParsedEvents', () => {
  it('joins consecutive text chunks verbatim, because PTY reads do not end on line boundaries', () => {
    const ctx = makeContext();

    const afterFirst = applyParsedEvents([], [{ type: 'text', content: 'Hel' }], ctx);
    const afterSecond = applyParsedEvents(afterFirst, [{ type: 'text', content: 'lo world\n' }], ctx);

    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].content).toBe('Hello world\n');
  });

  it('starts a new agent message after a user message', () => {
    const userMessage: ChatMessage = { id: 'u-1', role: 'user', content: 'hi', timestamp: 1 };

    const result = applyParsedEvents([userMessage], [{ type: 'text', content: 'reply' }], makeContext());

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'agent', content: 'reply', id: 'msg-1' });
  });

  it('starts a new agent message once the last one carries an action card', () => {
    const ctx = makeContext();
    const withCard = applyParsedEvents([], [{ type: 'approval_request', content: 'Allow this action?' }], ctx);

    const result = applyParsedEvents(withCard, [{ type: 'text', content: 'next output' }], ctx);

    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('next output');
  });

  it('appends tool starts to the current agent message', () => {
    const ctx = makeContext();
    const result = applyParsedEvents(
      [],
      [
        { type: 'text', content: 'Looking around' },
        { type: 'tool_start', content: 'Glob(*.ts)', metadata: { tool: 'Glob', args: '*.ts' } },
      ],
      ctx,
    );

    expect(result).toHaveLength(1);
    expect(result[0].tools).toEqual([{ id: 'tool-2', name: 'Glob', args: '*.ts', status: 'running' }]);
  });

  it("builds approval cards with the profile's approval and reject keys", () => {
    const profile = { approval_key: '1\n', reject_key: '3\n' } as AgentProfile;

    const result = applyParsedEvents(
      [],
      [{ type: 'approval_request', content: 'Run command?' }],
      makeContext({ profile }),
    );

    expect(result[0].actionCard).toMatchObject({
      sessionId: 's-1',
      prompt: 'Run command?',
      status: 'pending',
      approvalKey: '1\n',
      rejectKey: '3\n',
    });
  });

  it('does not mutate the input messages', () => {
    const original: ChatMessage[] = [{ id: 'a-1', role: 'agent', content: 'start', timestamp: 1 }];
    const snapshot = structuredClone(original);

    applyParsedEvents(original, [{ type: 'text', content: ' more' }], makeContext());

    expect(original).toEqual(snapshot);
  });

  it('keeps newline-only text around a tool start so lines do not run together', () => {
    const parser = new StreamParser();
    const ctx = makeContext();

    let messages: ChatMessage[] = [];
    for (const chunk of ['Reading files', '\nRunning Read(a.ts)\n', 'Found it']) {
      messages = applyParsedEvents(messages, parser.feed(chunk), ctx);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('agent');
    expect(messages[0].content).toBe('Reading files\n\nFound it');
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools?.[0]).toMatchObject({ name: 'Read', args: 'a.ts', status: 'running' });
  });

  it('retracts the prompt fragment already appended before the action card', () => {
    const messages: ChatMessage[] = [
      { id: 'a-1', role: 'agent', content: 'Some output\nAllow this ac', timestamp: 1 },
    ];

    const result = applyParsedEvents(
      messages,
      [
        {
          type: 'approval_request',
          content: 'Allow this action?',
          metadata: { retractedText: 'Allow this ac' },
        },
      ],
      makeContext(),
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Some output\n');
    expect(result[0].actionCard).toMatchObject({ prompt: 'Allow this action?', status: 'pending' });
  });

  it('leaves content untouched when retractedText is not an exact suffix', () => {
    const messages: ChatMessage[] = [
      { id: 'a-1', role: 'agent', content: 'Some output\nAllow this ac', timestamp: 1 },
    ];

    const result = applyParsedEvents(
      messages,
      [
        {
          type: 'approval_request',
          content: 'Allow this action?',
          metadata: { retractedText: 'unrelated fragment' },
        },
      ],
      makeContext(),
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Some output\nAllow this ac');
    expect(result[0].actionCard).toBeDefined();
  });
});
