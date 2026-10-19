import { TEXT_LINK } from "../ui/styles";
import { ZorvoLockup } from "../ui/ZorvoSymbol";
import { LINKS } from "../../lib/links";

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Agents", href: "#agents" },
      { label: "Features", href: "#features" },
      { label: "Privacy", href: "#privacy" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: LINKS.repo },
      { label: "Releases", href: LINKS.releases },
      { label: "Changelog", href: LINKS.changelog },
      { label: "Security", href: LINKS.security },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface-1">
      <div className="site-wrap flex flex-col gap-10 pt-12 pb-10">
        <div className="flex flex-wrap justify-between gap-10">
          <div className="flex max-w-[280px] flex-col gap-3">
            <ZorvoLockup />
            <p className="t-body m-0">Every coding agent. One desktop.</p>
          </div>
          <div className="flex flex-wrap gap-16">
            {COLUMNS.map(({ title, links }) => (
              <nav key={title} aria-labelledby={`footer-${title}`} className="flex flex-col gap-2.5">
                <h2 id={`footer-${title}`} className="m-0 text-xs leading-4 font-medium text-fg">
                  {title}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {links.map(({ label, href }) => (
                    <li key={label}>
                      <a className={TEXT_LINK} href={href}>
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-5">
          <p className="t-caption m-0">© 2026 Zorvo. All rights reserved.</p>
          <p className="t-caption m-0 max-w-[560px]">
            Claude Code, Codex, Qwen Code, Aider and Oh-My-Pi belong to their makers. Zorvo works
            with them and is not endorsed by them.
          </p>
        </div>
      </div>
    </footer>
  );
}
