import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/Icon";

/*
 * Pieces of the app drawn for the page's pictures. They sit inside a role="img"
 * container that carries the description, so nothing here is focusable or
 * announced: the "buttons" are spans that only look like the app's.
 */

type Status = "running" | "attention" | "unread";

const DOT: Record<Status, string> = {
  running: "bg-status-running animate-pulse-dot",
  attention: "bg-status-attention",
  unread: "bg-status-unread",
};

export function StatusDot({ status }: { status: Status }) {
  return <span className={`inline-block size-1.5 flex-none rounded-full ${DOT[status]}`} />;
}

type FakeButtonVariant = "primary" | "outline" | "danger";

const FAKE_BUTTON: Record<FakeButtonVariant, string> = {
  primary: "border-transparent bg-primary text-on-primary",
  outline: "border-border-strong text-fg-secondary",
  danger: "border-transparent bg-danger-surface text-danger",
};

function FakeButton({ variant, icon, children }: { variant: FakeButtonVariant; icon?: IconName; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs leading-4 font-medium ${FAKE_BUTTON[variant]}`}
    >
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

interface PermissionCardProps {
  title: string;
  body?: string;
  command: string;
}

/** The app's permission request, with the three choices the agent offers. */
export function PermissionCard({ title, body, command }: PermissionCardProps) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-attention-border bg-attention-surface p-3.5 text-left sm:p-4">
      <div className="flex items-center gap-2 text-sm leading-[22px] font-semibold text-fg">
        <Icon name="triangle-alert" className="text-status-attention" />
        {title}
      </div>
      {body && <p className="m-0 text-xs leading-[18px] text-fg-secondary">{body}</p>}
      <pre className="m-0 overflow-x-auto rounded-lg border border-border bg-bg p-2.5 font-mono text-xs leading-[18px] text-fg-secondary">
        {command}
      </pre>
      <div className="flex flex-wrap gap-2 border-t border-border pt-2.5">
        <FakeButton variant="primary" icon="check">Allow once</FakeButton>
        <FakeButton variant="outline">Always allow</FakeButton>
        <FakeButton variant="danger" icon="x">Deny</FakeButton>
      </div>
    </div>
  );
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
  /** Shown in a gutter when any line has one. */
  number?: number;
}

const LINE_BG: Record<DiffLine["kind"], string> = {
  context: "",
  added: "bg-diff-added",
  removed: "bg-diff-removed",
};

const LINE_MARK: Record<DiffLine["kind"], ReactNode> = {
  context: " ",
  added: <span className="text-status-running">+</span>,
  removed: <span className="text-danger">−</span>,
};

interface DiffCardProps {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** One changed file, as the app's diff view shows it. */
export function DiffCard({ path, added, removed, lines }: DiffCardProps) {
  const hasGutter = lines.some((line) => line.number !== undefined);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-2 text-left">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 font-mono text-[11px] leading-4">
        <span className="truncate text-fg-secondary">{path}</span>
        <span className="flex-none">
          <span className="text-status-running">+{added}</span>{" "}
          <span className="text-danger">−{removed}</span>
        </span>
      </div>
      <div className="overflow-x-auto py-1.5 font-mono text-xs leading-[18px] text-fg-secondary">
        {lines.map((line, index) => (
          <div key={index} className={`flex min-w-max ${LINE_BG[line.kind]}`}>
            {hasGutter && (
              <span className="w-10 flex-none pr-2.5 text-right text-fg-muted">{line.number}</span>
            )}
            <span className="pr-3 pl-3 whitespace-pre">
              {LINE_MARK[line.kind]}
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A label and a value inside the app's popover menu. */
export function MenuRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs leading-4 text-fg-secondary">
      <span>{label}</span>
      <span className="text-[11px] text-fg-subtle">{value}</span>
    </div>
  );
}
