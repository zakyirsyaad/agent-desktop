import type { SlashCommand } from '../types';

/** The text typed after `/` while the user is still choosing a command, or null. */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
}

export function matchingCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  return commands.filter((c) => c.name.toLowerCase().startsWith(query));
}

/** The hint of the command the prompt starts with, while its input is still empty. */
export function pendingHint(commands: readonly SlashCommand[], text: string): string | undefined {
  const match = /^\/(\S+) $/.exec(text);
  return match ? commands.find((c) => c.name === match[1])?.hint : undefined;
}
