import { Button } from "./ui/Button";

export interface RemovedAgentPanelProps {
  agentName: string;
  onAdd: () => void;
}

/** Takes the composer's place in a saved session whose agent was removed: the transcript stays readable. */
export function RemovedAgentPanel({ agentName, onAdd }: RemovedAgentPanelProps) {
  return (
    <section
      aria-label={`${agentName} was removed`}
      className="flex w-full max-w-3xl items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 px-4 py-3 text-xs text-fg-secondary"
    >
      <p>{`${agentName} was removed. Add it again to continue this session.`}</p>
      <Button variant="primary" onClick={onAdd}>
        {`Add ${agentName}`}
      </Button>
    </section>
  );
}
