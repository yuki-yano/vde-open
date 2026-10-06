import {
  validateAnswers,
  type Answers,
  type AnswerValue,
  type FeedbackForUi,
  type QuestionField,
} from '@vde-open/shared';
import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DetailsPopover } from '@/components/details-popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, type Api } from '@/lib/api';
import {
  describeIssues,
  emptyAnswerOf,
  optionLabel,
  summarize,
  withAnswer,
} from '@/lib/feedback-form';

// Up to this many options are shown as radios; more are shown as a select.
const RADIO_LIMIT = 6;
// Strings that allow long input use a multi-line field.
const TEXTAREA_LENGTH = 200;
// Delay after typing stops before the draft answer is saved.
const SAVE_DELAY_MS = 300;

const newSubmissionId = () => `sub_${crypto.randomUUID()}`;

interface FieldProps {
  name: string;
  field: QuestionField;
  required: boolean;
  value: AnswerValue | undefined;
  disabled: boolean;
  onChange: (value: AnswerValue | undefined) => void;
}

// A question field plus a control for explicitly answering with an empty value. Shown only for required fields where an empty answer is valid.
function FieldInput(props: FieldProps) {
  const { name, field, required, value, disabled, onChange } = props;
  const empty = emptyAnswerOf(field, required);
  if (empty === undefined) return <FieldControl {...props} />;
  const chosen = Array.isArray(empty) ? Array.isArray(value) && value.length === 0 : value === '';
  return (
    <>
      <FieldControl {...props} />
      <Label className="text-xs font-normal text-muted-foreground">
        <Checkbox
          checked={chosen}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked ? empty : undefined)}
          data-testid={`feedback-${name}-empty`}
        />
        {field.type === 'array' ? 'Answer with none selected' : 'Answer with an empty value'}
      </Label>
    </>
  );
}

// Build the input control from a question field (spec 11.5). Never preselect a required option.
// An empty control means not answered (the field is omitted). Empty answers are made explicit in FieldInput.
function FieldControl({ name, field, value, disabled, onChange }: FieldProps) {
  const id = `feedback-${name}`;
  switch (field.type) {
    case 'boolean':
      return (
        <Label htmlFor={id} className="font-normal">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
          />
          Yes
        </Label>
      );
    case 'number':
    case 'integer':
      return (
        <Input
          id={id}
          type="number"
          inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
          step={field.type === 'integer' ? 1 : 'any'}
          min={field.minimum}
          max={field.maximum}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(event) => {
            const text = event.target.value;
            const parsed = Number(text);
            onChange(text === '' || !Number.isFinite(parsed) ? undefined : parsed);
          }}
        />
      );
    case 'array': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-label`}>
          {field.items.enum.map((option) => (
            <Label key={option} className="font-normal">
              <Checkbox
                checked={selected.includes(option)}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const next = checked
                    ? [...selected, option]
                    : selected.filter((item) => item !== option);
                  onChange(next.length === 0 ? undefined : next);
                }}
              />
              {optionLabel(option)}
            </Label>
          ))}
        </div>
      );
    }
    case 'string': {
      if (field.enum !== undefined && field.enum.length <= RADIO_LIMIT) {
        return (
          <RadioGroup
            aria-labelledby={`${id}-label`}
            value={typeof value === 'string' ? value : null}
            disabled={disabled}
            onValueChange={(next) => onChange(typeof next === 'string' ? next : undefined)}
          >
            {field.enum.map((option) => (
              <Label key={option} className="font-normal">
                <RadioGroupItem value={option} />
                {optionLabel(option)}
              </Label>
            ))}
          </RadioGroup>
        );
      }
      if (field.enum !== undefined) {
        // Options are referenced by position, so an empty-string option is not confused with "not selected".
        const options = field.enum;
        const selected = typeof value === 'string' ? options.indexOf(value) : -1;
        return (
          <select
            id={id}
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            disabled={disabled}
            value={selected === -1 ? 'none' : String(selected)}
            onChange={(event) => {
              const index = Number(event.target.value);
              onChange(event.target.value === 'none' ? undefined : options[index]);
            }}
          >
            <option value="none">Select an option</option>
            {options.map((option, index) => (
              <option key={option} value={String(index)}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        );
      }
      const long = field.maxLength === undefined || field.maxLength > TEXTAREA_LENGTH;
      const props = {
        id,
        disabled,
        maxLength: field.maxLength,
        value: typeof value === 'string' ? value : '',
        onChange: (event: { target: { value: string } }) =>
          onChange(event.target.value === '' ? undefined : event.target.value),
      };
      return long ? <Textarea rows={4} {...props} /> : <Input {...props} />;
    }
  }
}

interface FeedbackPanelProps {
  api: Api;
  request: FeedbackForUi;
  reload: () => void;
}

// The panel for answering a question. Answers are finalized only with the submit button in the management UI (spec 11.8).
// Input is saved automatically as a draft answer. The server takes the content to finalize from the saved draft.
export function FeedbackPanel({ api, request, reload }: FeedbackPanelProps) {
  const { requestId, questionnaire } = request;
  const pending = request.status === 'pending';
  // The latest draft answer on the server that this panel knows of (either fetched or saved by this panel).
  // Saving input and submitting are based on this version.
  const [synced, setSynced] = useState({
    version: request.draftVersion,
    answers: request.draftAnswers,
  });
  // The answers being entered.
  const [answers, setAnswers] = useState<Answers>(request.draftAnswers);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'submitting'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  // The document's current revision at the time the user confirmed answering an older revision. If the revision changes again, confirm again.
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(null);
  // The submission ID. When resending after a connection failure, reuse the same ID (do not finalize twice).
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // Number of edits. If the user types while a save is in flight, stay unsaved after the save.
  const edits = useRef(0);

  // If another window updated the draft answer and this panel has no unsaved input, show the new draft.
  // Versions only increase, so a fetched result older than the known version (the state before this panel's save) is not used.
  if (request.draftVersion > synced.version && !dirty && phase === 'idle') {
    setSynced({ version: request.draftVersion, answers: request.draftAnswers });
    setAnswers(request.draftAnswers);
  }

  const newer = pending && request.currentRevision !== request.revision;
  const confirmed = newer && confirmedRevision === request.currentRevision;
  // For submitted or cancelled questions, show the server's content (the submitted answers, or the saved draft if none).
  // Do not present this panel's unsaved input as if it were the submitted answers.
  const shown = pending ? answers : (request.submission?.answers ?? request.draftAnswers);
  const issues = validateAnswers(questionnaire, shown, { complete: true });
  const summary = summarize(questionnaire, shown);

  const failWith = (reason: unknown, fallback: string) => {
    if (!(reason instanceof ApiError)) {
      setMessage(fallback);
      return;
    }
    switch (reason.code) {
      case 'E_DRAFT_CONFLICT':
        // Do not overwrite another window's draft with this panel's input. Show the latest draft instead.
        setDirty(false);
        setAnswers(synced.answers);
        setMessage(
          'The draft answer was updated in another window. Showing the latest content. Enter your answers again if needed.',
        );
        setSubmissionId(newSubmissionId());
        reload();
        return;
      case 'E_NEWER_REVISION':
        setConfirmedRevision(null);
        setSubmissionId(newSubmissionId());
        setMessage(
          'The document revision changed. Confirm again that this answer is for the revision shown.',
        );
        reload();
        return;
      case 'E_REQUEST_NOT_PENDING':
      case 'E_SUBMISSION_CONFLICT':
        setSubmissionId(newSubmissionId());
        setMessage(reason.message);
        reload();
        return;
      default:
        setMessage(reason.message);
    }
  };

  // Save the draft answer once typing stops.
  useEffect(() => {
    if (!dirty || phase !== 'idle' || !pending) return undefined;
    const timer = setTimeout(() => {
      const started = edits.current;
      const sent = answers;
      setPhase('saving');
      void api.saveDraft(requestId, synced.version, sent).then(
        (saved) => {
          // Remember the saved answers together with their version. If the user typed during the save, stay unsaved.
          setSynced({ version: saved.draftVersion, answers: sent });
          if (edits.current === started) setDirty(false);
          setPhase('idle');
        },
        (reason: unknown) => {
          setPhase('idle');
          failWith(reason, 'Could not save the draft answer.');
        },
      );
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });

  const change = (name: string, value: AnswerValue | undefined) => {
    edits.current += 1;
    setAnswers((current) => withAnswer(current, name, value));
    setDirty(true);
    setMessage(null);
  };

  const submit = () => {
    setPhase('submitting');
    setMessage(null);
    void api
      .submitFeedback(requestId, {
        submissionId,
        expectedDraftVersion: synced.version,
        revision: request.revision,
        // When a newer revision exists, send the confirmed revision. The server checks that it is the current one.
        currentRevision: newer ? confirmedRevision : request.currentRevision,
        confirmOlderRevision: confirmed,
      })
      .then(
        () => {
          setPhase('idle');
          reload();
        },
        (reason: unknown) => {
          setPhase('idle');
          // On a connection failure, keep the same submission ID so the user can resend.
          failWith(reason, 'Could not confirm whether the submission succeeded. Submit again.');
        },
      );
  };

  const cancel = () => {
    setConfirmingCancel(false);
    void api
      .cancelFeedback(requestId)
      .then(reload, (reason: unknown) => failWith(reason, 'Could not cancel.'));
  };

  const statusText =
    request.status === 'cancelled'
      ? 'Cancelled'
      : request.status === 'submitted'
        ? request.acknowledgedAt !== null
          ? 'The agent retrieved the answers'
          : 'Submitted. Waiting for the agent to retrieve it'
        : phase === 'submitting'
          ? 'Submitting…'
          : phase === 'saving'
            ? 'Saving draft answer…'
            : dirty
              ? 'Unsaved changes'
              : synced.version > 0
                ? 'Draft answer saved'
                : 'Not answered';
  const blocked =
    !pending || phase !== 'idle' || dirty || issues.length > 0 || (newer && !confirmed);

  return (
    <aside
      aria-label="Answer the question"
      className="flex max-h-[50svh] w-full shrink-0 flex-col border-t bg-background min-[900px]:max-h-none min-[900px]:w-96 min-[900px]:border-t-0 min-[900px]:border-l"
      data-testid="feedback-panel"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs text-muted-foreground">Question from the agent</p>
        <h2 className="mt-1 text-base font-semibold break-words">{questionnaire.title}</h2>
        {questionnaire.instructions && (
          <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">
            {questionnaire.instructions}
          </p>
        )}
        {newer && (
          <div role="alert" className="mt-3 rounded-md border border-warning/50 p-3 text-sm">
            <p>A newer revision is available. This answer is for the older revision shown.</p>
            {confirmedRevision !== null && !confirmed && (
              <p className="mt-1">
                The document was updated again after you confirmed. Confirm again.
              </p>
            )}
            <Label className="mt-2 font-normal">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) =>
                  setConfirmedRevision(checked ? request.currentRevision : null)
                }
              />
              I confirm that this answer is for the older revision
            </Label>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-5">
          {questionnaire.fieldOrder.map((name) => {
            const field = questionnaire.answerSchema.properties[name];
            if (!field) return null;
            const required = questionnaire.answerSchema.required.includes(name);
            return (
              <div key={name} className="flex flex-col gap-2" data-field={name}>
                <p id={`feedback-${name}-label`} className="text-sm font-medium">
                  <label htmlFor={`feedback-${name}`}>{field.title}</label>
                  {required && <span className="ml-1 text-xs text-destructive">(required)</span>}
                </p>
                {field.description && (
                  <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                    {field.description}
                  </p>
                )}
                <FieldInput
                  name={name}
                  field={field}
                  required={required}
                  value={shown[name]}
                  disabled={!pending || phase === 'submitting'}
                  onChange={(value) => change(name, value)}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="border-t px-4 py-3" data-testid="feedback-footer">
        <p className="text-xs text-muted-foreground">Submitting to</p>
        <p className="text-sm font-medium break-words">{questionnaire.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Target revision <code className="font-mono">{request.revision.slice(4, 16)}</code>
        </p>
        <dl className="mt-2 max-h-40 overflow-y-auto text-xs" aria-label="Answer summary">
          {summary.map((item) => (
            <div key={item.name} className="flex gap-2 py-0.5">
              <dt className="w-24 shrink-0 truncate text-muted-foreground">{item.title}</dt>
              <dd className="min-w-0 break-words">{item.value}</dd>
            </div>
          ))}
        </dl>
        {pending && issues.length > 0 && (
          <ul
            className="mt-2 text-xs text-muted-foreground"
            aria-label="Required before submitting"
          >
            {describeIssues(questionnaire, issues).map((issue) => (
              <li key={`${issue.name}:${issue.text}`}>{issue.text}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <p role="status" className="text-xs" data-testid="feedback-status">
            {statusText}
          </p>
          {message && (
            <DetailsPopover
              title="Answer needs attention"
              trigger={
                <Button variant="ghost" size="xs" className="text-destructive">
                  <CircleAlert aria-hidden="true" />
                  Details
                </Button>
              }
            >
              <p>{message}</p>
            </DetailsPopover>
          )}
          {message && (
            <span role="alert" className="sr-only">
              {message}
            </span>
          )}
        </div>
        {pending && (
          <div className="mt-3 flex gap-2">
            <Button type="button" className="flex-1" disabled={blocked} onClick={submit}>
              Send answers to the agent
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirmingCancel(true)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this question?</AlertDialogTitle>
            <AlertDialogDescription>
              After cancelling, this question can no longer be answered. The agent is told that it
              was cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={cancel}>Cancel question</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
