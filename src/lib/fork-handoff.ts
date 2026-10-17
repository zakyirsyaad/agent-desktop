/**
 * Builds the Markdown handoff document used to fork a conversation into a new
 * agent session, plus the one-line prompt that points the new agent at it.
 *
 * The prompt must stay on one line: text typed into an agent TUI through a PTY
 * is submitted at the first newline.
 */
import type { ChatMessage } from "../types";

/** Upper bound for the handoff document, in UTF-16 code units. */
export const MAX_HANDOFF_CHARS = 60000;

const SECTION_SEPARATOR = "\n\n";
const LINE_BREAK_PATTERN = /[\r\n]+/g;

export interface ForkHandoffMeta {
  sourceSessionName: string;
  agentName: string;
  cwd: string;
  createdAt: number;
}

function buildHeader(meta: ForkHandoffMeta): string {
  return [
    "# Session handoff",
    "",
    `- Source session: ${meta.sourceSessionName}`,
    `- Agent: ${meta.agentName}`,
    `- Folder: ${meta.cwd}`,
    `- Created: ${new Date(meta.createdAt).toISOString()}`,
    "",
    "> Note: files on disk may have changed since this point in the conversation.",
  ].join("\n");
}

function buildActivityLines(message: ChatMessage): string[] {
  const toolLines = (message.tools ?? []).map(
    (tool) => `- Tool: ${tool.name}(${tool.args})`,
  );
  const card = message.actionCard;
  const cardLines = card
    ? [`- Approval requested: ${card.prompt} (${card.status})`]
    : [];
  return [...toolLines, ...cardLines];
}

function buildSection(message: ChatMessage): string {
  const heading = message.role === "user" ? "### User" : "### Agent";
  const activity = buildActivityLines(message);
  const parts = [heading, activity.join("\n"), message.content].filter(
    (part) => part.length > 0,
  );
  return parts.join(SECTION_SEPARATOR);
}

function omittedNote(count: number): string {
  return `_${count} earlier messages omitted._`;
}

/** Number of oldest sections to drop so header, note and the rest fit the cap. */
function countSectionsToDrop(header: string, sections: readonly string[]): number {
  const separatorLength = SECTION_SEPARATOR.length;
  let remaining = sections.reduce(
    (total, section) => total + separatorLength + section.length,
    header.length,
  );
  if (remaining <= MAX_HANDOFF_CHARS) return 0;

  let dropped = 0;
  while (dropped < sections.length - 1) {
    remaining -= separatorLength + sections[dropped].length;
    dropped += 1;
    const noteLength = separatorLength + omittedNote(dropped).length;
    if (remaining + noteLength <= MAX_HANDOFF_CHARS) break;
  }
  return dropped;
}

/**
 * Renders the conversation up to and including `uptoMessageId` as Markdown,
 * dropping the oldest messages first when it would exceed `MAX_HANDOFF_CHARS`.
 */
export function buildForkHandoff(
  messages: readonly ChatMessage[],
  uptoMessageId: string,
  meta: ForkHandoffMeta,
): string {
  const uptoIndex = messages.findIndex((message) => message.id === uptoMessageId);
  if (uptoIndex === -1) {
    throw new Error(`Cannot fork: message "${uptoMessageId}" was not found`);
  }

  const header = buildHeader(meta);
  const sections = messages.slice(0, uptoIndex + 1).map(buildSection);
  const dropped = countSectionsToDrop(header, sections);
  const note = dropped > 0 ? [omittedNote(dropped)] : [];
  const document = [header, ...note, ...sections.slice(dropped)].join(
    SECTION_SEPARATOR,
  );
  return document.slice(0, MAX_HANDOFF_CHARS);
}

/**
 * One-line first prompt for the forked session. Never contains a newline. The
 * path is quoted because app data dirs often contain spaces
 * (e.g. "~/Library/Application Support/...").
 */
export function buildForkPrompt(handoffPath: string): string {
  const safePath = handoffPath.replace(LINE_BREAK_PATTERN, " ");
  return (
    `Read the file "${safePath}" for the context of a previous session, ` +
    "then continue from where it left off. Reply briefly that you are ready."
  );
}

/**
 * What a rewound session's fresh agent is told ahead of the user's message:
 * the conversation so far is in the handoff, and the message follows.
 */
export function buildRewindContext(handoffPath: string): string {
  const safePath = handoffPath.replace(LINE_BREAK_PATTERN, " ");
  return (
    `Read the file "${safePath}" for this conversation so far, then answer my message below. ` +
    "Do not mention the file."
  );
}
