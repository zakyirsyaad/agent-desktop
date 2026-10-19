import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { DiffCard, PermissionCard, StatusDot, type DiffLine } from "./parts";

const RENAME_DIFF: DiffLine[] = [
  { kind: "removed", text: '  "productName": "Agent Desktop",' },
  { kind: "added", text: '  "productName": "Zorvo",' },
  { kind: "removed", text: '  "identifier": "com.agentdesktop.app",' },
  { kind: "added", text: '  "identifier": "xyz.zorvo.desktop",' },
];

interface SessionRow {
  title: string;
  meta: "running" | "attention" | "unread" | string;
  isCurrent?: boolean;
}

const WORKSPACES: { folder: string; sessions: SessionRow[] }[] = [
  {
    folder: "agent-desktop",
    sessions: [
      { title: "Rename the app to Zorvo", meta: "running", isCurrent: true },
      { title: "Fix the flaky transcripts test", meta: "attention" },
      { title: "Add @-mentions to the composer", meta: "unread" },
      { title: "Show PR checks in the top bar", meta: "2d" },
    ],
  },
  {
    folder: "landing-site",
    sessions: [
      { title: "Draft the hero copy", meta: "Aider" },
      { title: "Set up the favicon", meta: "Codex" },
    ],
  },
];

function SessionMeta({ meta }: { meta: SessionRow["meta"] }) {
  if (meta === "running" || meta === "attention" || meta === "unread") return <StatusDot status={meta} />;
  return <>{meta}</>;
}

function Sidebar() {
  return (
    <div className="hidden w-[248px] flex-none flex-col gap-0.5 border-r border-border bg-surface-1 p-2 md:flex">
      {WORKSPACES.map(({ folder, sessions }, index) => (
        <div key={folder} className="flex flex-col gap-0.5">
          <div
            className={`flex items-center gap-1.5 px-2 pb-1.5 text-[11px] leading-4 text-fg-subtle ${index === 0 ? "pt-1.5" : "pt-3.5"}`}
          >
            <Icon name="folder" />
            {folder}
          </div>
          {sessions.map((session) => (
            <div
              key={session.title}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs leading-4 ${session.isCurrent ? "bg-surface-hover text-fg" : "text-fg-muted"}`}
            >
              <span className="truncate">{session.title}</span>
              <span className="flex flex-none items-center text-[11px] text-fg-subtle">
                <SessionMeta meta={session.meta} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FakeSelect({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs leading-4 text-fg-secondary">
      {label}
      <Icon name="chevron-down" />
    </span>
  );
}

function Composer() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3 text-left shadow-popover">
      <span className="truncate text-sm leading-[22px] text-fg-subtle">
        Ask Claude Code to change something, @ to mention a file
      </span>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="inline-flex size-7 items-center justify-center text-fg-muted">
            <Icon name="plus" />
          </span>
          <FakeSelect label="Claude Code" />
          <span className="hidden sm:inline-flex"><FakeSelect label="Sonnet 5.5" /></span>
          <span className="hidden sm:inline-flex"><FakeSelect label="Ask first" /></span>
        </div>
        <span className="inline-flex size-7 flex-none items-center justify-center rounded-lg bg-primary text-on-primary">
          <Icon name="arrow-up" />
        </span>
      </div>
    </div>
  );
}

/** The app as a picture: a session list, a Claude Code chat with a diff and a permission request, and the composer. */
export function AppMockup() {
  return (
    <div
      role="img"
      aria-label="The Zorvo app: a session list, a Claude Code chat with a file diff and a permission request, and the composer"
      className="mx-auto flex max-w-[1100px] flex-col overflow-hidden rounded-t-xl border border-b-0 border-border bg-bg shadow-dialog md:h-[600px]"
    >
      <div className="flex h-10 flex-none items-center gap-3 border-b border-border bg-surface-1 px-3.5">
        <div className="flex gap-2">
          <span className="size-3 rounded-full bg-surface-hover" />
          <span className="size-3 rounded-full bg-surface-hover" />
          <span className="size-3 rounded-full bg-surface-hover" />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <span className="truncate text-xs leading-4 text-fg">Rename the app to Zorvo</span>
          <span className="hidden lg:inline-flex">
            <Chip isCode>agent/rename-the-app-to-zorvo</Chip>
          </span>
        </div>
        <span className="hidden flex-none sm:inline-flex">
          <Chip>
            <StatusDot status="running" />
            <span className="pl-0.5">PR #32 · checks passed</span>
          </Chip>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-3.5 px-4 pt-5 pb-4 text-left sm:px-7">
          <div className="max-w-[420px] self-end rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-[22px] text-fg">
            Rename the app to Zorvo and move existing sessions to the new data folder.
          </div>
          <p className="m-0 max-w-[620px] text-sm leading-[22px] text-fg-secondary">
            I updated the product name and bundle identifier, and added a one-time migration for
            sessions and transcripts.
          </p>
          <div className="max-w-[620px]">
            <DiffCard path="src-tauri/tauri.conf.json" added={2} removed={2} lines={RENAME_DIFF} />
          </div>
          <div className="max-w-[620px]">
            <PermissionCard title="Claude Code wants to run a command" command="pnpm test" />
          </div>
          <Composer />
        </div>
      </div>
    </div>
  );
}
