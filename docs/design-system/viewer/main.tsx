/// <reference types="vite/client" />
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import tokensJson from "../tokens.json";
import readme from "../README.md?raw";
import bundleUrl from "../components/bundle.css?url";
import { themeCss, valueIn, type ThemeId, type Token, type Tokens } from "./tokens-css";
import "./viewer.css";

const tokens = tokensJson as unknown as Tokens;
const THEME_CSS = themeCss(tokens);

const previews = import.meta.glob<string>("../components/*/preview.html", {
  query: "?raw",
  import: "default",
  eager: true,
});
const guidelines = import.meta.glob<string>("../components/*/README.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const logos = import.meta.glob<string>("../assets/Logos/*.{svg,png}", {
  query: "?url",
  import: "default",
  eager: true,
});

type ThemeChoice = "system" | ThemeId;
const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** The folder name a glob key points at: "../components/Button/README.md" → "Button". */
function componentName(path: string): string {
  return path.split("/").at(-2) ?? path;
}

/** `@dsCard group="Actions" height=80` on a preview's first line. */
function cardMeta(html: string): { group: string; height: number } {
  const first = html.split("\n", 1)[0];
  return {
    group: /group="([^"]+)"/.exec(first)?.[1] ?? "",
    height: Number(/height=(\d+)/.exec(first)?.[1] ?? 120),
  };
}

/** A preview as the artifact renders it: tokens and bundle.css injected, the theme pinned. */
function previewDoc(html: string, theme: ThemeChoice): string {
  const head = `<style>${THEME_CSS}</style><link rel="stylesheet" href="${bundleUrl}">`;
  const themed = theme === "system" ? html : html.replace("<html>", `<html data-theme="${theme}">`);
  return themed.replace("</head>", `${head}</head>`);
}

/** Usage notes mark token names with backticks; show them as code. */
function Usage({ text }: { text?: string }) {
  if (!text) return null;
  return <>{text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

function Preview({ path, theme }: { path: string; theme: ThemeChoice }) {
  const html = previews[path];
  const { height } = cardMeta(html);
  return (
    <iframe
      className="preview"
      title={`${componentName(path)} preview`}
      srcDoc={previewDoc(html, theme)}
      style={{ height }}
    />
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ token, theme }: { token: Token; theme: ThemeId }) {
  const value = valueIn(token.value, theme);
  return (
    <div className="swatch" data-theme={theme}>
      <span className="swatch-chip" style={{ background: value }} />
      <code>{value}</code>
    </div>
  );
}

function Colors() {
  return (
    <div className="table">
      {tokens.color.tokens.map((token) => (
        <div key={token.name} className="row">
          <code className="name">{token.name}</code>
          <Swatch token={token} theme="dark" />
          <Swatch token={token} theme="light" />
          <p className="usage"><Usage text={token.usage} /></p>
        </div>
      ))}
    </div>
  );
}

function Type() {
  return (
    <div className="table">
      {tokens.type.groups.flatMap((group) =>
        group.styles.map((style) => (
          <div key={style.name} className="row type-row">
            <code className="name">{style.name}</code>
            <p
              className="type-sample"
              style={{
                fontFamily: `var(--font-${group.family})`,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                fontWeight: style.fontWeight,
                letterSpacing: style.letterSpacing,
              }}
            >
              {style.sample}
            </p>
            <p className="usage">
              {group.name} · {style.fontSize}/{style.lineHeight} · {style.fontWeight}
              {style.letterSpacing ? ` · ${style.letterSpacing}` : ""}
              <br />
              <Usage text={style.usage} />
            </p>
          </div>
        ))
      )}
    </div>
  );
}

function Scale({ family, render }: { family: Token[]; render: (t: Token) => ReactNode }) {
  return (
    <div className="table">
      {family.map((token) => (
        <div key={token.name} className="row scale-row">
          <code className="name">{token.name}</code>
          <div className="scale-visual">{render(token)}</div>
          <p className="usage"><code>{valueIn(token.value, "dark")}</code> <Usage text={token.usage} /></p>
        </div>
      ))}
    </div>
  );
}

function Logos() {
  return (
    <div className="logos">
      {Object.entries(logos).map(([path, url]) => {
        const file = path.split("/").at(-1) ?? path;
        const ground = file.includes("-ink") ? "light" : "dark";
        return (
          <figure key={path} className="logo" data-theme={ground}>
            <img src={url} alt={file} />
            <figcaption><code>{file}</code></figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function Components({ theme }: { theme: ThemeChoice }) {
  const paths = Object.keys(previews).filter((p) => componentName(p) !== "Cover");
  return (
    <div className="components">
      {paths.map((path) => {
        const name = componentName(path);
        const guideline = guidelines[path.replace("preview.html", "README.md")] ?? "";
        return (
          <article key={path} id={name} className="component">
            <p className="group">{cardMeta(previews[path]).group}</p>
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{guideline}</ReactMarkdown>
            </div>
            <Preview path={path} theme={theme} />
          </article>
        );
      })}
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <>
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <path d="M6 7l10 7-10 7" />
            <path d="M18 19l10 7-10 7" />
            <path d="M30 33h5" />
          </svg>
          <span className="wordmark">zorvo</span>
          <span className="subtitle">Design system</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEME_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={theme === choice.id}
              onClick={() => setTheme(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </header>
      <nav className="toc" aria-label="Sections">
        {["Overview", "Colors", "Type", "Space and shape", "Logos", "Components"].map((title) => (
          <a key={title} href={`#${title.toLowerCase().replace(/ /g, "-")}`}>{title}</a>
        ))}
      </nav>
      <main>
        <Section id="overview" title="Overview">
          <Preview path="../components/Cover/preview.html" theme={theme} />
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>
          </div>
        </Section>
        <Section id="colors" title="Colors">
          <Colors />
        </Section>
        <Section id="type" title="Type">
          <Type />
        </Section>
        <Section id="space-and-shape" title="Space and shape">
          <h3>Spacing</h3>
          <Scale family={tokens.spacing.tokens} render={(t) => <span className="bar" style={{ width: `var(--${CSS.escape(t.name)})` }} />} />
          <h3>Radius</h3>
          <Scale family={tokens.radius.tokens} render={(t) => <span className="box" style={{ borderRadius: `var(--${t.name})` }} />} />
          <h3>Shadow</h3>
          <Scale family={tokens.shadow.tokens} render={(t) => <span className="box raised" style={{ boxShadow: `var(--${t.name})` }} />} />
          <h3>Size</h3>
          <Scale family={tokens.size.tokens} render={(t) => <span className="box" style={{ width: `var(--${t.name})`, height: `var(--${t.name})` }} />} />
        </Section>
        <Section id="logos" title="Logos">
          <Logos />
        </Section>
        <Section id="components" title="Components">
          <Components theme={theme} />
        </Section>
      </main>
    </>
  );
}

const style = document.createElement("style");
style.textContent = THEME_CSS;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
