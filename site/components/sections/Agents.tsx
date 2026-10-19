import claudeCodeLogo from "../../../src/assets/agents/claude-code.svg";
import codexLogo from "../../../src/assets/agents/codex.svg";
import qwenLogo from "../../../src/assets/agents/qwen.svg";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { SectionIntro } from "../ui/SectionIntro";

// Next imports an image as { src }, Vite (the app's tests render this page) as a URL string.
type LogoImport = string | { src: string };

const logoUrl = (logo: LogoImport) => (typeof logo === "string" ? logo : logo.src);

// The same logo files the app shows (see src/assets/agents/README.md for their source and licence).
const CHAT_AGENTS: { name: string; logo: LogoImport }[] = [
  { name: "Claude Code", logo: claudeCodeLogo },
  { name: "Codex", logo: codexLogo },
  { name: "Qwen Code", logo: qwenLogo },
];

const CHAT_FEATURES = ["Models", "Effort", "Modes", "Approvals", "Diffs", "Rewind", "Fork", "Resume"];

function ChatPanel() {
  return (
    <article
      aria-labelledby="agents-chat"
      className="flex min-w-0 flex-[1_1_560px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1"
    >
      <div className="flex flex-col gap-2.5 px-5 pt-6 pb-5 sm:px-7 sm:pt-7 sm:pb-6">
        <div className="flex items-center gap-2.5 text-fg">
          <Icon name="message-square" size={18} />
          <h3 id="agents-chat" className="t-title m-0">In a chat</h3>
        </div>
        <p className="t-body m-0 max-w-[460px]">
          Driven over the Agent Client Protocol, so you see each agent&apos;s own models, effort,
          modes and approvals.
        </p>
      </div>
      <ul className="m-0 list-none p-0">
        {CHAT_AGENTS.map(({ name, logo }) => (
          <li
            key={name}
            className="flex items-center gap-3.5 border-t border-border px-5 py-[18px] sm:px-7"
          >
            {/* The name beside it says which agent this is, so the logo itself is decorative. */}
            <img src={logoUrl(logo)} alt="" width={28} height={28} className="size-7 flex-none rounded-md" />
            <span className="text-xl leading-[26px] font-medium tracking-[-0.025em] text-fg sm:text-2xl sm:leading-[30px]">
              {name}
            </span>
          </li>
        ))}
      </ul>
      <ul
        aria-label="What the chat shows"
        className="m-0 mt-auto flex list-none flex-wrap gap-1.5 border-t border-border bg-surface-2 px-5 py-[18px] sm:px-7"
      >
        {CHAT_FEATURES.map((feature) => (
          <li key={feature}>
            <Chip>{feature}</Chip>
          </li>
        ))}
      </ul>
    </article>
  );
}

function TerminalTab({ name, isActive }: { name: string; isActive: boolean }) {
  const look = isActive ? "bg-terminal-tab text-terminal-fg-strong" : "text-terminal-fg-subtle";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] leading-4 ${look}`}>
      <Icon name="bot" className={isActive ? "text-terminal-fg-muted" : ""} />
      {name}
    </span>
  );
}

function TerminalPanel() {
  return (
    <article
      aria-labelledby="agents-terminal"
      className="flex min-w-0 flex-[1_1_420px] flex-col overflow-hidden rounded-xl border border-terminal-border bg-terminal-bg"
    >
      <div
        role="img"
        aria-label="Aider running in its own terminal tab, next to an Oh-My-Pi tab"
        className="flex flex-1 flex-col"
      >
        <div className="flex items-center gap-1 border-b border-terminal-border px-2.5 py-2">
          <TerminalTab name="Aider" isActive />
          <TerminalTab name="Oh-My-Pi" isActive={false} />
        </div>
        <div className="flex min-h-[120px] flex-1 flex-col gap-1 px-6 py-[22px] font-mono text-xs leading-[18px] text-terminal-fg">
          <div>
            <span className="text-terminal-fg-subtle">~/zorvo %</span> aider
          </div>
          <div className="pt-1.5">
            <span className="inline-block h-4 w-2 bg-terminal-fg align-[-3px]" />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 border-t border-terminal-border px-5 pt-6 pb-7 sm:px-7">
        <div className="flex items-center gap-2.5 text-terminal-fg-strong">
          <Icon name="square-terminal" size={18} />
          <h3 id="agents-terminal" className="m-0 text-xl leading-7 font-semibold tracking-[-0.02em] text-terminal-fg-strong">
            In their own terminal
          </h3>
        </div>
        <p className="m-0 text-sm leading-[22px] text-terminal-fg-muted">
          Aider and Oh-My-Pi run as their real TUI in the main view. Zorvo spots Oh-My-Pi&apos;s
          [y/n] prompts, and forks either one by handoff.
        </p>
      </div>
    </article>
  );
}

export function Agents() {
  return (
    <section id="agents" aria-labelledby="agents-title" className="py-[72px] md:py-28">
      <div className="site-wrap flex flex-col gap-12">
        <SectionIntro
          id="agents-title"
          eyebrow="agents"
          title="Bring the agent you already use."
          lead="Zorvo meets each agent where it lives. Agents that speak ACP get a real chat. Terminal agents keep their terminal."
          className="max-w-[600px]"
        />
        <div className="flex flex-wrap items-stretch gap-4">
          <ChatPanel />
          <TerminalPanel />
        </div>
        <p className="t-caption m-0">
          Each agent reports its own models and modes, so Zorvo offers whatever your install has.
          Agent names belong to their makers; Zorvo works with them and is not endorsed by them.
        </p>
      </div>
    </section>
  );
}
