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
const COMPLETE_ANSI_REGEX =
  /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b\([B0-2])/g;

// Detects potential incomplete ANSI escape sequence at the end of a chunk:
// e.g. trailing \x1b, \x1b[, \x1b[3, \x1b], etc.
const TRAILING_PARTIAL_ESCAPE_REGEX =
  /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[A-Z\\-_]?)$/;

export class StreamParser {
  private buffer: string = '';
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

    // Check for approval prompt in clean text
    const hasApproval = this.approvalRegex.test(cleanText);
    if (hasApproval) {
      // Find the approval line or prompt
      const lines = cleanText.split('\n');
      const approvalLines: string[] = [];
      const nonApprovalLines: string[] = [];

      for (const line of lines) {
        if (this.approvalRegex.test(line)) {
          approvalLines.push(line);
        } else {
          nonApprovalLines.push(line);
        }
      }

      if (nonApprovalLines.length > 0) {
        const textContent = nonApprovalLines.join('\n');
        if (textContent.trim()) {
          events.push({
            type: 'text',
            content: textContent,
          });
        }
      }

      events.push({
        type: 'approval_request',
        content: approvalLines.join('\n').trim() || cleanText.trim(),
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

      if (preText.trim()) {
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

      if (postText.trim()) {
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
   * Resets the internal carryover buffer.
   */
  public reset(): void {
    this.buffer = '';
  }
}
