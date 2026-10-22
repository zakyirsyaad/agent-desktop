import type { ToolExecution } from '../types';

/** How a kind of work reads in a summary row. */
interface KindPhrase {
  one: string;
  many: (count: number) => string;
}

const COMMAND: KindPhrase = { one: 'Ran a command', many: (n) => `Ran ${n} commands` };
const FILE: (verb: string) => KindPhrase = (verb) => ({
  one: `${verb} a file`,
  many: (n) => `${verb} ${n} files`,
});

const PHRASES: Readonly<Record<string, KindPhrase>> = {
  execute: COMMAND,
  read: FILE('Read'),
  edit: FILE('Edited'),
  delete: FILE('Deleted'),
  move: FILE('Moved'),
  search: { one: 'Searched the code', many: () => 'Searched the code' },
  fetch: { one: 'Fetched a page', many: (n) => `Fetched ${n} pages` },
};

const OTHER: KindPhrase = { one: 'Used a tool', many: (n) => `Used ${n} tools` };

/** The summary's key for a tool kind; null kinds and the rest share one phrase. */
function phraseOf(tool: ToolExecution): KindPhrase {
  return (tool.kind && PHRASES[tool.kind]) || OTHER;
}

/** "Ran 2 commands · 1 failed" for a part of a reply, in the order the kinds first appear. */
export function summarizeTools(tools: readonly ToolExecution[]): string {
  const counts = new Map<KindPhrase, number>();
  for (const tool of tools) {
    const phrase = phraseOf(tool);
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([phrase, count], index) => {
    const text = count === 1 ? phrase.one : phrase.many(count);
    return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  });
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const label = parts.join(', ');
  return failed > 0 ? `${label} · ${failed} failed` : label;
}