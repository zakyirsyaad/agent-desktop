import { Agents } from "../components/sections/Agents";
import { Control } from "../components/sections/Control";
import { Download } from "../components/sections/Download";
import { Features } from "../components/sections/Features";
import { Hero } from "../components/sections/Hero";
import { Privacy } from "../components/sections/Privacy";
import { SiteFooter } from "../components/sections/SiteFooter";
import { SiteHeader } from "../components/sections/SiteHeader";

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="focus-ring sr-only rounded-lg bg-primary px-3 py-2 text-sm text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-10"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex flex-col">
        <Hero />
        <Agents />
        <Features />
        <Control />
        <Privacy />
        <Download />
      </main>
      <SiteFooter />
    </>
  );
}
