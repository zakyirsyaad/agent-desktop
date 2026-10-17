import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Check } from "lucide-react";
import { readyAgents, resolveDefaultAgentId, type AgentSummary } from "../lib/agent-readiness";
import { AgentsStep } from "./onboarding/AgentsStep";
import { DefaultAgentStep } from "./onboarding/DefaultAgentStep";
import { FolderStep } from "./onboarding/FolderStep";
import { toFolderOption, type FolderOption, type OnboardingResult } from "./onboarding/types";

export type { FolderOption, OnboardingResult } from "./onboarding/types";

export interface OnboardingProps {
  agents: readonly AgentSummary[];
  recentFolders: readonly FolderOption[];
  suggestedFolders: readonly FolderOption[];
  onRecheckAgents: () => void | Promise<void>;
  onPickFolder: () => Promise<FolderOption | null>;
  onComplete: (result: OnboardingResult) => void;
}

const STEPS = [
  {
    label: "Agents",
    title: "Check your agents",
    description: "Agent Desktop drives coding agents installed on this machine.",
  },
  {
    label: "Folder",
    title: "Choose a project folder",
    description: "Sessions start in this folder. You can switch folders later.",
  },
  {
    label: "Default agent",
    title: "Pick a default agent",
    description: "New sessions use this agent unless you choose another.",
  },
] as const;

const LAST_STEP = STEPS.length - 1;
const GATE_HINT_ID = "onboarding-gate-hint";

const GATE_MESSAGES = [
  "Install at least one agent to continue.",
  "Choose a folder to continue.",
  "No ready agent to start with.",
] as const;

function StepIndicator({ current }: { current: number }) {
  return (
    <ol aria-label="Setup progress" className="flex items-center gap-2 text-[11px]">
      {STEPS.map((step, index) => {
        const isCurrent = index === current;
        const isDone = index < current;
        return (
          <li
            key={step.label}
            aria-current={isCurrent ? "step" : undefined}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
              isCurrent
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : isDone
                  ? "border-neutral-800 text-neutral-300"
                  : "border-neutral-800/60 text-neutral-500"
            }`}
          >
            {isDone ? (
              <Check size={11} className="text-emerald-400" aria-hidden="true" />
            ) : (
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            )}
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

interface NavButtonProps {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  describedBy?: string;
  children: ReactNode;
}

function NavButton({ onClick, disabled, primary, describedBy, children }: NavButtonProps) {
  const tone = primary
    ? "bg-amber-500 text-black hover:bg-amber-400 disabled:bg-neutral-800 disabled:text-neutral-500"
    : "border border-neutral-800 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-amber-500/40 ${tone}`}
    >
      {children}
    </button>
  );
}

export function Onboarding({
  agents,
  recentFolders,
  suggestedFolders,
  onRecheckAgents,
  onPickFolder,
  onComplete,
}: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<FolderOption | null>(null);
  const [preferredAgentId, setPreferredAgentId] = useState<string | null>(null);

  const defaultAgentId = resolveDefaultAgentId(agents, preferredAgentId);
  const canAdvance = [readyAgents(agents).length > 0, folder !== null, defaultAgentId !== null][step];
  const current = STEPS[step];

  const handleSelectFolder = (selected: FolderOption) => setFolder(toFolderOption(selected));
  const goBack = () => setStep((value) => Math.max(0, value - 1));
  const goNext = () => setStep((value) => Math.min(LAST_STEP, value + 1));
  const handleStart = () => {
    if (folder && defaultAgentId) onComplete({ defaultAgentId, folder });
  };

  return (
    // Top-anchored (not vertically centered) so the header stays put as step heights change.
    <main className="flex h-screen w-full items-start justify-center overflow-y-auto bg-[#000000] px-4 pt-[12vh] pb-8 text-neutral-200 select-none">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <header className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <Bot size={15} className="text-amber-500" aria-hidden="true" />
            <h1 className="font-semibold text-neutral-200">Set up Agent Desktop</h1>
          </div>
          <StepIndicator current={step} />
        </header>

        <section className="flex flex-col gap-4 rounded-xl border border-[#262626] bg-[#0d0d0d] p-5 shadow-2xl">
          <div>
            <h2 className="text-base font-semibold text-neutral-100">{current.title}</h2>
            <p className="mt-1 text-xs text-neutral-500">{current.description}</p>
          </div>
          {step === 0 && <AgentsStep agents={agents} onRecheckAgents={onRecheckAgents} />}
          {step === 1 && (
            <FolderStep
              recentFolders={recentFolders}
              suggestedFolders={suggestedFolders}
              selectedFolder={folder}
              onSelectFolder={handleSelectFolder}
              onPickFolder={onPickFolder}
            />
          )}
          {step === 2 && (
            <DefaultAgentStep
              agents={agents}
              selectedAgentId={defaultAgentId}
              onSelectAgent={setPreferredAgentId}
            />
          )}
        </section>

        <footer className="flex items-center justify-between gap-3">
          <div>
            {step > 0 && (
              <NavButton onClick={goBack}>
                <ArrowLeft size={13} aria-hidden="true" />
                Back
              </NavButton>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!canAdvance && (
              <p id={GATE_HINT_ID} className="text-[11px] text-neutral-500">
                {GATE_MESSAGES[step]}
              </p>
            )}
            {step < LAST_STEP ? (
              <NavButton
                primary
                onClick={goNext}
                disabled={!canAdvance}
                describedBy={canAdvance ? undefined : GATE_HINT_ID}
              >
                Continue
                <ArrowRight size={13} aria-hidden="true" />
              </NavButton>
            ) : (
              <NavButton
                primary
                onClick={handleStart}
                disabled={!canAdvance}
                describedBy={canAdvance ? undefined : GATE_HINT_ID}
              >
                Start
              </NavButton>
            )}
          </div>
        </footer>
      </div>
    </main>
  );
}
