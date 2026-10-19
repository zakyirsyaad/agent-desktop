import appPackage from "../../../package.json";
import { AppMockup } from "../mockups/AppMockup";
import { ButtonLink } from "../ui/ButtonLink";
import { Icon } from "../ui/Icon";
import { LINKS } from "../../lib/links";

export function Hero() {
  return (
    <>
      <section
        id="top"
        aria-labelledby="hero-title"
        className="site-wrap flex flex-col items-center gap-7 pt-16 pb-14 text-center md:pt-24 md:pb-[72px]"
      >
        {/* The release line reads the app's own version, so it moves with each release. */}
        <a
          href={LINKS.releases}
          className="focus-ring inline-flex items-center gap-2 rounded-sm font-mono text-xs leading-4 text-fg-muted no-underline transition-colors duration-150 hover:text-fg"
        >
          <span aria-hidden="true" className="text-fg-subtle">&gt;</span>
          <span>zorvo {appPackage.version} is out</span>
          <span aria-hidden="true" className="text-fg-subtle">→</span>
        </a>
        <h1 id="hero-title" className="t-display m-0 max-w-[760px]">
          Every coding agent.
          <br />
          One desktop.
        </h1>
        <p className="t-lead m-0 max-w-[560px]">
          Claude Code, Codex, Qwen and Aider in one native app. Bring the agent you already use. No
          lock-in, no API keys.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <ButtonLink href={LINKS.releases} variant="primary" size="lg">
            <Icon name="download" size={16} />
            Download for Mac
          </ButtonLink>
          <ButtonLink href={LINKS.repo} variant="outline" size="lg">
            View on GitHub
            <Icon name="arrow-up-right" size={16} />
          </ButtonLink>
        </div>
        <p className="t-caption m-0">
          Free · macOS, Apple silicon and Intel · Needs Node.js 22 and one agent CLI
        </p>
      </section>
      <div className="site-wrap">
        <AppMockup />
      </div>
    </>
  );
}
