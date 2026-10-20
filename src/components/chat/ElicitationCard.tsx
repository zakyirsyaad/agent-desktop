import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/Button";
import { ElicitationFields } from "./ElicitationFields";
import { canSubmit } from "../../lib/elicitation-form";
import { useElicitationForm } from "../../hooks/useElicitationForm";
import type {
  ElicitationAnswer,
  ElicitationCard as ElicitationCardData,
  ElicitationStatus,
} from "../../types";

export interface ElicitationCardProps {
  card: ElicitationCardData;
  agentName: string;
  onAnswer?: (key: string, answer: ElicitationAnswer) => void;
  /** Opens a URL request again after it was opened once. */
  onReopen?: (key: string) => void;
  disabled?: boolean;
}

export const CANNOT_SHOW_MESSAGE = "This form has a field Zorvo cannot show. You can decline or dismiss it.";

const WARNINGS = {
  punycode: "This address uses look-alike characters.",
  "ip-address": "This address is a bare IP address.",
  "user-info": "This address hides a name before the @.",
} as const;

const SUMMARIES: Record<Exclude<ElicitationStatus, "pending">, string> = {
  submitted: "You sent the form.",
  declined: "You declined.",
  dismissed: "You dismissed this request.",
  opened: "Opened in your browser.",
  completed: "Finished in your browser.",
  unanswered: "This request was not answered.",
};

export function ElicitationCard({ card, agentName, onAnswer, onReopen, disabled = false }: ElicitationCardProps) {
  const answer = (a: ElicitationAnswer) => onAnswer?.(card.key, a);
  const form = useElicitationForm(card, answer);
  const summary = card.status === "pending" ? null : SUMMARIES[card.status];
  const isForm = card.mode === "form";

  return (
    <div
      data-testid={`elicitation-card-${card.key}`}
      className="my-3 rounded-xl border border-attention-border bg-attention-surface p-4 text-left transition-all"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-status-attention" />
        <h2 className="text-sm font-semibold tracking-wide text-fg">
          {isForm ? `${agentName} asks for input` : `${agentName} wants to open a page`}
        </h2>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-secondary">{card.message}</p>

      {isForm && summary === null && <FormRequest form={form} disabled={disabled} onAnswer={answer} />}
      {!isForm && summary === null && <UrlRequest card={card} disabled={disabled} onAnswer={answer} />}

      {summary !== null && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <p className="text-xs text-fg-muted">{summary}</p>
          {card.status === "opened" && onReopen && !disabled && (
            <Button onClick={() => onReopen(card.key)}>
              Open again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FormRequest({
  form,
  disabled,
  onAnswer,
}: {
  form: ReturnType<typeof useElicitationForm>;
  disabled: boolean;
  onAnswer: (a: ElicitationAnswer) => void;
}) {
  const sendable = canSubmit(form.fields);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (sendable && !disabled) form.submit();
      }}
    >
      <ElicitationFields fields={form.fields} values={form.values} errors={form.errors} onChange={form.change} disabled={disabled} />
      {!sendable && <p className="mt-3 text-xs text-fg-muted">{CANNOT_SHOW_MESSAGE}</p>}
      <Actions>
        {sendable && (
          <Button type="submit" variant="primary" disabled={disabled}>
            Submit
          </Button>
        )}
        <AnswerButtons disabled={disabled} onAnswer={onAnswer} />
      </Actions>
    </form>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-2">{children}</div>;
}

function AnswerButtons({ disabled, onAnswer }: { disabled: boolean; onAnswer: (a: ElicitationAnswer) => void }) {
  return (
    <>
      <Button disabled={disabled} onClick={() => onAnswer({ action: "decline" })}>
        Decline
      </Button>
      <Button variant="ghost" disabled={disabled} onClick={() => onAnswer({ action: "cancel" })}>
        Dismiss
      </Button>
    </>
  );
}

function UrlRequest({ card, disabled, onAnswer }: { card: ElicitationCardData; disabled: boolean; onAnswer: (a: ElicitationAnswer) => void }) {
  return (
    <div>
      <div className="mt-3 rounded-lg border border-border bg-bg p-2.5 font-mono text-xs text-fg-secondary">
        <p>
          Host: <strong className="text-fg">{card.host}</strong>
        </p>
        <p className="mt-1 break-all">{card.url}</p>
      </div>
      {card.warnings?.map((warning) => (
        <p key={warning} className="mt-2 text-xs text-status-attention">
          {WARNINGS[warning]}
        </p>
      ))}
      {card.blocked && <p className="mt-2 text-xs text-danger">{card.blocked}</p>}
      <Actions>
        {!card.blocked && (
          <Button variant="primary" disabled={disabled} onClick={() => onAnswer({ action: "accept" })}>
            Open in browser
          </Button>
        )}
        <AnswerButtons disabled={disabled} onAnswer={onAnswer} />
      </Actions>
    </div>
  );
}
