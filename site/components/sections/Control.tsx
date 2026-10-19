import type { ReactNode } from "react";
import { DiffCard, MenuRow, PermissionCard, type DiffLine } from "../mockups/parts";
import { Chip } from "../ui/Chip";
import { Icon, type IconName } from "../ui/Icon";
import { SectionIntro } from "../ui/SectionIntro";

const POINTS: { icon: IconName; title: string; body: ReactNode }[] = [
  {
    icon: "shield-check",
    title: "Approvals in the chat",
    body: "Allow once, always allow or deny, exactly as the agent offers them.",
  },
  {
    icon: "file-code",
    title: "A diff of every change",
    body: (
      <>
        Read each changed file against <Chip isCode>HEAD</Chip> or the branch&apos;s base, with line
        numbers and a path filter.
      </>
    ),
  },
  {
    icon: "gauge",
    title: "Context in plain numbers",
    body: "Tokens used, tokens left and the session's cost, one click away.",
  },
  {
    icon: "server",
    title: "Background tasks",
    body: "Agents mid-turn, terminals and the dev servers they started, with their port. Open one, or stop it.",
  },
];

const PIN_DIFF: DiffLine[] = [
  { kind: "context", number: 41, text: "  const visible = sessions.filter(" },
  { kind: "removed", number: 42, text: "   (s) => !s.archived," },
  { kind: "added", number: 42, text: "   (s) => !s.archived || s.pinned," },
  { kind: "added", number: 43, text: "  );" },
  { kind: "added", number: 44, text: "  const pinned = visible.filter((s) => s.pinned);" },
];

// Illustrative numbers: the bar is drawn at the same 38% the "used" figure gives.
const CONTEXT = { used: "76k", window: "200k", left: "124k", cost: "$0.42", percent: 38 };

function ContextMeter() {
  return (
    <div className="flex min-w-[240px] flex-col gap-2.5 self-end rounded-lg border border-border bg-surface-3 p-3 shadow-popover">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs leading-4 font-medium text-fg">Context</span>
        <span className="font-mono text-[11px] leading-4 text-fg-muted">
          {CONTEXT.used} of {CONTEXT.window}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-hover">
        <div className="h-full bg-fg-muted" style={{ width: `${CONTEXT.percent}%` }} />
      </div>
      <MenuRow label="Tokens left" value={CONTEXT.left} />
      <MenuRow label="Session cost" value={CONTEXT.cost} />
    </div>
  );
}

export function Control() {
  return (
    <section
      id="control"
      aria-labelledby="control-title"
      className="border-t border-border py-[72px] md:py-28"
    >
      <div className="site-wrap flex flex-wrap items-center gap-12 lg:gap-16">
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-8">
          <SectionIntro
            id="control-title"
            eyebrow="control"
            title="You approve every step."
            lead="Permission requests arrive with the agent's own choices. Every file it touches comes with a diff."
          />
          <ul className="m-0 flex list-none flex-col gap-5 p-0">
            {POINTS.map(({ icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <Icon name={icon} size={18} className="mt-[3px] text-fg" />
                <div className="flex flex-col gap-1">
                  <h3 className="t-heading m-0">{title}</h3>
                  <p className="t-body m-0">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div
          role="img"
          aria-label="A Codex permission request to edit a file, its diff, and the context meter"
          className="flex min-w-0 flex-[1_1_480px] flex-col gap-3.5 rounded-xl border border-border bg-surface-1 p-4 sm:p-7"
        >
          <PermissionCard
            title="Codex wants to edit a file"
            body="It will update the session list so archived sessions stay pinned."
            command="src/components/SessionList.tsx"
          />
          <DiffCard path="src/components/SessionList.tsx" added={3} removed={1} lines={PIN_DIFF} />
          <ContextMeter />
        </div>
      </div>
    </section>
  );
}
