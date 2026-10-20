import { Check, X, Wrench, AlertTriangle } from "lucide-react";
import { Button, type ButtonVariant } from "./ui/Button";
import type { ActionCard as ActionCardType, PermissionChoice } from "../types";

/** A permission request from an agent, answered with one of the agent's own options. */
export interface ActionCardProps {
  card: ActionCardType;
  /** Picks one of the agent's options. */
  onChoose?: (optionId: string) => void;
  disabled?: boolean;
}

function choiceVariant(kind: string): ButtonVariant {
  if (kind === "allow_once") return "primary";
  return kind.startsWith("allow") ? "outline" : "danger";
}

/** The agent's own answers to its permission request, or the one that was picked. */
function PermissionChoices({
  card,
  disabled,
  onChoose,
}: {
  card: ActionCardType;
  disabled: boolean;
  onChoose?: (optionId: string) => void;
}) {
  const options: PermissionChoice[] = card.options ?? [];
  if (card.status !== "pending") {
    const chosen = options.find((o) => o.optionId === card.chosenOptionId);
    return (
      <p className="mt-4 border-t border-border pt-2 text-xs text-fg-muted">
        {chosen ? `You chose: ${chosen.name}` : "This request was not answered."}
      </p>
    );
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-2">
      {options.map((option) => (
        <Button
          key={option.optionId}
          variant={choiceVariant(option.kind)}
          disabled={disabled}
          onClick={() => onChoose?.(option.optionId)}
          icon={option.kind.startsWith("allow") ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        >
          {option.name}
        </Button>
      ))}
    </div>
  );
}

export function ActionCard({ card, onChoose, disabled = false }: ActionCardProps) {
  return (
    <div
      data-testid={`action-card-${card.id}`}
      className="my-3 rounded-xl border border-attention-border bg-attention-surface p-4 text-left transition-all"
    >
      {/* Header with Title and Tool Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-status-attention shrink-0" />
          <h2 className="text-sm font-semibold tracking-wide text-fg">
            {card.title}
          </h2>
        </div>

        {card.toolName && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 border border-border px-2.5 py-0.5 text-xs font-mono text-fg-muted">
            <Wrench className="h-3 w-3 text-fg-subtle" />
            Tool: {card.toolName}
          </span>
        )}
      </div>

      {/* Description / Prompt */}
      <p className="mt-2 text-xs leading-relaxed text-fg-secondary">
        {card.prompt}
      </p>

      {/* Command Snippet */}
      {card.commandSnippet && (
        <div className="mt-3 rounded-lg border border-border bg-bg p-2.5 font-mono text-xs text-fg-secondary overflow-x-auto">
          <code>{card.commandSnippet}</code>
        </div>
      )}

      <PermissionChoices card={card} disabled={disabled} onChoose={onChoose} />
    </div>
  );
}
