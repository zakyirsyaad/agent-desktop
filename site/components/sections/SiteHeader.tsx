import { ButtonLink } from "../ui/ButtonLink";
import { ZorvoLockup } from "../ui/ZorvoSymbol";
import { TEXT_LINK } from "../ui/styles";
import { LINKS } from "../../lib/links";

export function SiteHeader() {
  return (
    <header>
      <nav
        aria-label="Main"
        className="site-wrap flex min-h-16 items-center justify-between gap-4 py-3"
      >
        <ZorvoLockup />
        {/* On a phone the section links live in the footer; the two actions stay. */}
        <ul className="m-0 hidden list-none items-center gap-7 p-0 md:flex">
          <li><a className={TEXT_LINK} href="#agents">Agents</a></li>
          <li><a className={TEXT_LINK} href="#features">Features</a></li>
          <li><a className={TEXT_LINK} href="#privacy">Privacy</a></li>
          <li><a className={TEXT_LINK} href={LINKS.changelog}>Changelog</a></li>
        </ul>
        <div className="flex items-center gap-2">
          <ButtonLink href={LINKS.repo} variant="ghost">GitHub</ButtonLink>
          <ButtonLink href={LINKS.releases} variant="outline">Download</ButtonLink>
        </div>
      </nav>
    </header>
  );
}
