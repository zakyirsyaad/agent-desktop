import type { ReactNode } from "react";
import { Chip } from "../ui/Chip";
import { Icon, type IconName } from "../ui/Icon";
import { SectionIntro } from "../ui/SectionIntro";

const FEATURES: { icon: IconName; title: string; body: ReactNode }[] = [
  {
    icon: "layers",
    title: "The agent's own data",
    body: "Its real modes and models, permission requests with its own choices, slash commands and context usage. Sessions resume after a restart.",
  },
  {
    icon: "square-terminal",
    title: "Sign in from inside Zorvo",
    body: "An agent's own login runs in a terminal in the app. Your message is sent once you are signed in.",
  },
  {
    icon: "folder",
    title: "Workspaces and sessions",
    body: "Sessions group by folder and title themselves from the first message. Rename, pin and archive them. An unread mark shows which agent finished while you were away.",
  },
  {
    icon: "rotate-ccw",
    title: "Fork and rewind",
    body: "Fork any reply into a new session. Or rewind to before one of your messages and send it again, edited.",
  },
  {
    icon: "git-branch",
    title: "Worktrees",
    body: (
      <>
        Run a session in its own git worktree on an <Chip isCode>agent/&lt;title&gt;</Chip> branch,
        so agents in one repository never edit the same files.
      </>
    ),
  },
  {
    icon: "git-pull-request",
    title: "Review and commit",
    body: (
      <>
        Read each changed file&apos;s diff and commit the files you choose. The top bar shows the
        branch&apos;s pull request and its checks, read with your own <Chip isCode>gh</Chip>.
      </>
    ),
  },
];

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="border-t border-border py-[72px] md:py-28"
    >
      <div className="site-wrap flex flex-col gap-14">
        <SectionIntro
          id="features-title"
          eyebrow="features"
          title="One app. Each agent as it really is."
          lead="Sessions, worktrees, diffs and pull requests sit around the agent, never in its way."
          className="max-w-[640px]"
        />
        {/* Hairline grid: the list draws the top and left edges, each cell its right and bottom. */}
        <ul className="m-0 grid list-none grid-cols-1 border-t border-l border-border p-0 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon, title, body }) => (
            <li
              key={title}
              className="flex flex-col gap-3.5 border-r border-b border-border px-5 py-7 sm:px-7 sm:py-8"
            >
              <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-2 text-fg">
                <Icon name={icon} size={18} />
              </span>
              <h3 className="m-0 text-lg leading-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h3>
              <p className="t-body m-0">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
