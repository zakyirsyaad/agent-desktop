import type { ParsedStreamEvent } from '../types';

export interface StreamParserOptions {
  approvalPattern?: string | RegExp;
  toolPattern?: RegExp;
}

const DEFAULT_APPROVAL_PATTERN = /(?:Allow this action\?|\[y\/n\]|Run command\?|Confirm\?)/i;
const DEFAULT_TOOL_PATTERN = /^(?:Running\s+|Tool:\s+|🛠\s+Tool:\s*)([A-Za-z0-9_-]+)\(([^)]*)\)/m;

// Matches complete ANSI escape sequences:
// 1. CSI codes: \x1b\[ ... [A-Za-z]
// 2. OSC sequences: \x1b\] ... (\x07 | \x1b\\)
// 3. Two-char escapes: \x1b[@-Z\\-_]
// 4. Cursor / keypad / other mode controls
// Matching terminal escape codes is the point, so their control characters are meant.
const COMPLETE_ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\([B0-2])/g;

// Detects potential incomplete ANSI escape sequence at the end of a chunk:
// e.g. trailing \x1b, \x1b[, \x1b[3, \x1b], etc.
const TRAILING_PARTIAL_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[A-Z\\-_]?)$/;

// Upper bound on the unfinished line remembered between chunks, so a long
// stream without newlines cannot grow the probe string without limit.
const MAX_LINE_TAIL_LENGTH = 512;

export class StreamParser {
  private buffer: string = '';
  private lineTail: string = '';
  private approvalRegex: RegExp;
  private toolRegex: RegExp;

  constructor(options?: StreamParserOptions) {
    if (options?.approvalPattern) {
      this.approvalRegex =
        typeof options.approvalPattern === 'string'
          ? new RegExp(options.approvalPattern, 'i')
          : options.approvalPattern;
    } else {
      this.approvalRegex = DEFAULT_APPROVAL_PATTERN;
    }

    this.toolRegex = options?.toolPattern ?? DEFAULT_TOOL_PATTERN;
  }

  /**
   * Feeds a chunk of raw terminal output from PTY into the parser.
   * Strips ANSI escape codes, handles boundary fragmentation, and emits
   * typed stream events for UI display and action card prompts.
   */
  public feed(chunk: string): ParsedStreamEvent[] {
    const combined = this.buffer + chunk;
    this.buffer = '';

    // Check if combined ends with an incomplete escape sequence
    const partialMatch = combined.match(TRAILING_PARTIAL_ESCAPE_REGEX);
    let completeText = combined;

    if (partialMatch && partialMatch.index !== undefined) {
      completeText = combined.slice(0, partialMatch.index);
      this.buffer = combined.slice(partialMatch.index);
    }

    if (!completeText) {
      return [];
    }

    // Strip ANSI codes
    const cleanText = completeText.replace(COMPLETE_ANSI_REGEX, '');
    if (!cleanText) {
      return [];
    }

    const events: ParsedStreamEvent[] = [];

    // Check for approval prompt line by line. The first line is prefixed with the
    // unfinished line from earlier chunks, so a prompt split across PTY reads is found.
    // Captured before it is overwritten, because a prompt completed here means that
    // carried tail was already shown to the user as ordinary text.
    const carriedTail = this.lineTail;
    const lines = cleanText.split('\n');
    const probeLines = [carriedTail + lines[0], ...lines.slice(1)];
    const isApprovalLine = probeLines.map((line) => this.approvalRegex.test(line));
    this.lineTail = this.nextLineTail(lines, isApprovalLine[isApprovalLine.length - 1]);

    if (isApprovalLine.some(Boolean)) {
      const approvalLines = probeLines.filter((_, i) => isApprovalLine[i]);
      const nonApprovalLines = lines.filter((_, i) => !isApprovalLine[i]);

      if (nonApprovalLines.length > 0) {
        const textContent = nonApprovalLines.join('\n');
        if (textContent.trim()) {
          events.push({
            type: 'text',
            content: textContent,
          });
        }
      }

      const completedCarriedPrompt = isApprovalLine[0] && carriedTail.length > 0;

      events.push({
        type: 'approval_request',
        content: approvalLines.join('\n').trim() || cleanText.trim(),
        ...(completedCarriedPrompt ? { metadata: { retractedText: carriedTail } } : {}),
      });

      return events;
    }

    // Check for tool execution start
    const toolMatch = cleanText.match(this.toolRegex);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const toolArgs = toolMatch[2];
      const matchedString = toolMatch[0];

      // Split text around tool invocation if needed
      const toolStartIdx = cleanText.indexOf(matchedString);
      const preText = cleanText.slice(0, toolStartIdx);
      const postText = cleanText.slice(toolStartIdx + matchedString.length);

      if (preText.length > 0) {
        events.push({
          type: 'text',
          content: preText,
        });
      }

      events.push({
        type: 'tool_start',
        content: `${toolName}(${toolArgs})`,
        metadata: {
          tool: toolName,
          args: toolArgs,
        },
      });

      if (postText.length > 0) {
        events.push({
          type: 'text',
          content: postText,
        });
      }

      return events;
    }

    // Normal text
    events.push({
      type: 'text',
      content: cleanText,
    });

    return events;
  }

  /**
   * Resets the internal carryover buffer and the remembered unfinished line.
   */
  public reset(): void {
    this.buffer = '';
    this.lineTail = '';
  }

  /**
   * Computes the unfinished last line to carry into the next chunk. A line that
   * already produced an approval request is dropped so it is not raised twice.
   */
  private nextLineTail(lines: string[], lastLineWasApproval: boolean): string {
    if (lastLineWasApproval) return '';
    const lastLine = lines[lines.length - 1];
    const tail = lines.length === 1 ? this.lineTail + lastLine : lastLine;
    return tail.slice(-MAX_LINE_TAIL_LENGTH);
  }
}
