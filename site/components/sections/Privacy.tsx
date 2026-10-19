import { Icon, type IconName } from "../ui/Icon";
import { SectionIntro } from "../ui/SectionIntro";

const PROMISES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "key-round",
    title: "Sign-in stays with the agents",
    body: "Zorvo never asks for or stores API keys or tokens. Agents sign in with their own tools.",
  },
  {
    icon: "wifi-off",
    title: "Few hosts, all named",
    body: "Zorvo contacts the ACP registry, and only when you install an agent, that agent's hash-checked download plus Node.js or uv if it needs them, with no telemetry and no requests from the window.",
  },
  {
    icon: "hard-drive",
    title: "Your data, on your Mac",
    body: "Sessions, transcripts and worktrees live in one folder you can open in Finder.",
  },
  {
    icon: "lock",
    title: "Only the folders you open",
    body: "The backend reads and runs only in folders you opened in the app.",
  },
];

const DATA_FOLDER = ["state.json", "transcripts/", "worktrees/"];

function DataFolderTerminal() {
  return (
    <div
      role="img"
      aria-label="The folder where Zorvo keeps its data: state.json, transcripts and worktrees"
      className="min-w-0 flex-[1_1_380px] overflow-hidden rounded-xl border border-terminal-border bg-terminal-bg"
    >
      <div className="flex h-9 items-center gap-2 border-b border-terminal-border px-3.5">
        <span className="size-2.5 rounded-full bg-terminal-border" />
        <span className="size-2.5 rounded-full bg-terminal-border" />
        <span className="size-2.5 rounded-full bg-terminal-border" />
        <span className="ml-2 font-mono text-[11px] leading-4 text-terminal-fg-subtle">zsh</span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-x-auto px-5 py-[18px] font-mono text-xs leading-[18px] text-terminal-fg">
        <div className="whitespace-nowrap">
          <span className="text-terminal-fg-subtle">~ %</span> ls ~/Library/Application\ Support/xyz.zorvo.desktop
        </div>
        {DATA_FOLDER.map((entry, index) => (
          <div key={entry} className={index === 0 ? "pt-2" : ""}>
            {entry}
          </div>
        ))}
        <div className="pt-3.5">
          <span className="text-terminal-fg-subtle">~ %</span>{" "}
          <span className="inline-block h-3.5 w-2 bg-terminal-fg align-[-2px]" />
        </div>
      </div>
    </div>
  );
}

export function Privacy() {
  return (
    <section
      id="privacy"
      aria-labelledby="privacy-title"
      className="border-t border-border py-[72px] md:py-28"
    >
      <div className="site-wrap flex flex-wrap items-center gap-12 lg:gap-16">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-10">
          <SectionIntro
            id="privacy-title"
            eyebrow="privacy"
            title="No lock-in. No API keys."
            lead="Zorvo sits between you and your agents and keeps nothing for itself."
            className="max-w-[520px]"
          />
          <ul className="m-0 grid list-none grid-cols-1 gap-x-8 gap-y-7 p-0 sm:grid-cols-2">
            {PROMISES.map(({ icon, title, body }) => (
              <li key={title} className="flex flex-col gap-2">
                <Icon name={icon} size={18} className="text-fg" />
                <h3 className="t-heading m-0">{title}</h3>
                <p className="t-body m-0">{body}</p>
              </li>
            ))}
          </ul>
        </div>
        <DataFolderTerminal />
      </div>
    </section>
  );
}
