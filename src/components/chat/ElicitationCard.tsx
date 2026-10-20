import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/Button";
import { ElicitationFields } from "./ElicitationFields";
import { canSubmit, checkForm, initialValues, toContent, type FormValue } from "../../lib/elicitation-form";
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

/** Typed values are kept only while the card can still be sent or sent back. */
const KEEPS_VALUES: ElicitationStatus[] = ["pending", "submitted"];

export function ElicitationCard({ card, agentName, onAnswer, onReopen, disabled = false }: ElicitationCardProps) {
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(card.fields ?? []));
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  // Drop what the user typed once the card is answered for good.
  if (!KEEPS_VALUES.includes(card.status) && (Object.keys(values).length > 0 || Object.keys(clientErrors).length > 0)) {
    setValues({});
    setClientErrors({});
  }

  const summary = card.status === "pending" ? null : SUMMARIES[card.status];
  const pending = summary === null;
  const fields = card.fields ?? [];
  const isForm = card.mode === "form";
  const answer = (a: ElicitationAnswer) => onAnswer?.(card.key, a);

  const submit = () => {
    const errors = checkForm(fields, values);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    answer({ action: "accept", content: toContent(fields, values) });
  };

  const change = (name: string, value: FormValue) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setClientErrors(({ [name]: _cleared, ...rest }) => rest);
  };

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

      {isForm && pending && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit(fields) && !disabled) submit();
          }}
        >
          <ElicitationFields
            fields={fields}
            values={values}
            errors={{ ...card.errors, ...clientErrors }}
            onChange={change}
            disabled={disabled}
          />
          {!canSubmit(fields) && <p className="mt-3 text-xs text-fg-muted">{CANNOT_SHOW_MESSAGE}</p>}
          <Actions>
            {canSubmit(fields) && (
              <Button type="submit" variant="primary" disabled={disabled}>
                Submit
              </Button>
            )}
            <AnswerButtons disabled={disabled} onAnswer={answer} />
          </Actions>
        </form>
      )}

      {!isForm && pending && <UrlRequest card={card} disabled={disabled} onAnswer={answer} />}

      {summary !== null && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <p className="text-xs text-fg-muted">{summary}</p>
          {card.status === "opened" && (
            <Button disabled={disabled} onClick={() => onReopen?.(card.key)}>
              Open again
            </Button>
          )}
        </div>
      )}
    </div>
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
