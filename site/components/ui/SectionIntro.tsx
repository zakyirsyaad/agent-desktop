interface SectionIntroProps {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  className?: string;
}

/** The `> eyebrow`, headline and lead that open every section; the headline labels the section. */
export function SectionIntro({ id, eyebrow, title, lead, className = "" }: SectionIntroProps) {
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <p className="m-0 inline-flex items-center gap-1.5 font-mono text-xs leading-4 text-fg-muted">
        <span aria-hidden="true" className="text-fg-subtle">
          &gt;
        </span>
        {eyebrow}
      </p>
      <h2 id={id} className="t-headline m-0">
        {title}
      </h2>
      <p className="t-lead m-0">{lead}</p>
    </div>
  );
}
