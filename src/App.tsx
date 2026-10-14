import { useState } from "react";
import { Terminal, Shield, Sparkles } from "lucide-react";

export default function App() {
  const [activeSession] = useState<string>("Claude Code Session #1");

  return (
    <main className="flex h-screen w-screen flex-col bg-[#0a0a0a] text-neutral-200">
      {/* Top Bar Window Drag / Header */}
      <header className="flex h-10 w-full items-center justify-between border-b border-neutral-800 bg-[#000000] px-4 text-xs select-none">
        <div className="flex items-center space-x-2">
          <span className="h-3 w-3 rounded-full bg-red-500/80 inline-block" />
          <span className="h-3 w-3 rounded-full bg-yellow-500/80 inline-block" />
          <span className="h-3 w-3 rounded-full bg-green-500/80 inline-block" />
          <span className="ml-3 font-medium text-neutral-400">{activeSession}</span>
        </div>
        <div className="flex items-center space-x-2 text-neutral-400">
          <button
            type="button"
            className="flex items-center gap-1 rounded bg-neutral-900 px-2 py-1 hover:bg-neutral-800 text-neutral-300"
            aria-label="Raw terminal toggle"
          >
            <Terminal size={14} />
            <span>Terminal</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <section className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-64 border-r border-neutral-800 bg-[#0d0d0d] p-3 flex flex-col justify-between">
          <div>
            <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Workspaces
            </div>
            <ul className="space-y-1 text-sm">
              <li className="rounded bg-neutral-800/60 px-2.5 py-1.5 text-neutral-200 flex items-center justify-between">
                <span>agent-desktop</span>
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
              </li>
            </ul>
          </div>
          <div className="border-t border-neutral-800 pt-3 text-xs text-neutral-500 flex items-center justify-between">
            <span>Agent Desktop v0.1.0</span>
            <Shield size={14} className="text-emerald-500" />
          </div>
        </aside>

        {/* Chat / Canvas Area */}
        <article className="flex-1 flex flex-col bg-[#000000]">
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 text-amber-500">
              <Sparkles size={24} />
            </div>
            <h1 className="text-xl font-medium text-neutral-100">Agent Desktop GUI</h1>
            <p className="mt-1 max-w-sm text-sm text-neutral-400">
              Generic terminal coding agent wrapper with authentic shell environment and interactive action cards.
            </p>
          </div>

          {/* Floating Composer Placeholder */}
          <footer className="p-4 flex justify-center">
            <div className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-[#121212] p-3 shadow-2xl flex items-center gap-2">
              <input
                type="text"
                readOnly
                placeholder="Type / for commands, or prompt the agent..."
                className="flex-1 bg-transparent text-sm text-neutral-300 placeholder-neutral-500 outline-none"
              />
              <div className="rounded-lg bg-neutral-800 px-2.5 py-1 text-xs text-neutral-400">
                Claude Code
              </div>
            </div>
          </footer>
        </article>
      </section>
    </main>
  );
}
