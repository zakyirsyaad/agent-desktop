import { useState } from 'react';
import { checkForm, initialValues, toContent, type FormValue } from '../lib/elicitation-form';
import type { ElicitationAnswer, ElicitationCard, ElicitationStatus } from '../types';

/** Typed values are kept only while the card can still be sent or sent back. */
const KEEPS_VALUES: ElicitationStatus[] = ['pending', 'submitted'];

/**
 * What the user typed into an elicitation form, its errors and its submit.
 * Values live only here. A field with no value yet shows the agent's default,
 * so a card that mounted while its answer was on its way still has them.
 */
export function useElicitationForm(card: ElicitationCard, answer: (a: ElicitationAnswer) => void) {
  const fields = card.fields ?? [];
  const [typed, setTyped] = useState<Record<string, FormValue>>({});
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  // Fields edited since the backend's errors came, by their content: a popout
  // gets the same errors as a new object with every snapshot.
  const errorsKey = JSON.stringify(card.errors ?? {});
  const [editedSince, setEditedSince] = useState({ errorsKey, names: [] as string[] });
  const edited = editedSince.errorsKey === errorsKey ? editedSince.names : [];
  const backendErrors = Object.fromEntries(
    Object.entries(card.errors ?? {}).filter(([name]) => !edited.includes(name)),
  );

  // Drop what the user typed once the card is answered for good.
  if (!KEEPS_VALUES.includes(card.status) && (Object.keys(typed).length > 0 || Object.keys(clientErrors).length > 0)) {
    setTyped({});
    setClientErrors({});
  }

  const values = { ...initialValues(fields), ...typed };

  const submit = () => {
    const errors = checkForm(fields, values);
    setClientErrors(errors);
    if (Object.keys(errors).length > 0) return;
    // The backend's next errors show in full, even when they read the same.
    setEditedSince({ errorsKey, names: [] });
    answer({ action: 'accept', content: toContent(fields, values) });
  };

  const change = (name: string, value: FormValue) => {
    setTyped((prev) => ({ ...prev, [name]: value }));
    setClientErrors(({ [name]: _cleared, ...rest }) => rest);
    setEditedSince((prev) => {
      const names = prev.errorsKey === errorsKey ? prev.names : [];
      return names.includes(name) ? prev : { errorsKey, names: [...names, name] };
    });
  };

  return { fields, values, errors: { ...backendErrors, ...clientErrors }, submit, change };
}
