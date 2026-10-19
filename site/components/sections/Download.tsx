import { ButtonLink } from "../ui/ButtonLink";
import { Icon } from "../ui/Icon";
import { ZorvoSymbol } from "../ui/ZorvoSymbol";
import { LINKS } from "../../lib/links";

export function Download() {
  return (
    <section id="download" aria-labelledby="download-title" className="border-t border-border">
      <div className="site-wrap flex flex-col items-center gap-6 py-[72px] text-center md:py-24">
        <ZorvoSymbol size={72} className="text-fg" />
        <h2
          id="download-title"
          className="m-0 text-[34px] leading-[38px] font-medium tracking-[-0.04em] text-fg md:text-[44px] md:leading-[48px]"
        >
          Every agent, one prompt.
        </h2>
        <p className="t-lead m-0 max-w-[480px]">
          Download Zorvo, open a folder and pick the agent you already use.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-2">
          <ButtonLink href={LINKS.releases} variant="primary" size="lg">
            <Icon name="download" size={16} />
            Download for Mac
          </ButtonLink>
          <ButtonLink href={LINKS.installGuide} variant="outline" size="lg">
            Read the install guide
          </ButtonLink>
        </div>
        <p className="t-caption m-0 max-w-[460px]">
          The build is not signed yet. The first time you open it, allow it in System Settings,
          Privacy and Security.
        </p>
      </div>
    </section>
  );
}
