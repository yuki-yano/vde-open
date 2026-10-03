import {
  validateAnswers,
  type Answers,
  type AnswerValue,
  type FeedbackForUi,
  type QuestionField,
} from '@vde-open/shared';
import { useEffect, useRef, useState } from 'react';

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

// 選択肢がこの数までならradio、それより多ければselectで表示する。
const RADIO_LIMIT = 6;
// 長い入力を許すstringは、複数行で入力する。
const TEXTAREA_LENGTH = 200;
// 入力が止まってから、回答案を保存するまでの時間。
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

// 質問のfieldと、空の回答を明示する欄。空の回答が有効な必須のfieldにだけ出す。
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
        {field.type === 'array' ? 'どれも選ばずに回答する' : '空欄のまま回答する'}
      </Label>
    </>
  );
}

// 質問のfieldから入力欄を作る（仕様11.5）。必須の選択肢を、勝手に選んだ状態にはしない。
// 入力欄が空なら未入力（fieldを省く）。空の回答は、FieldInputの欄で明示する。
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
          はい
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
        // 選択肢は位置で指す。空の文字列の選択肢を、未選択と取り違えない。
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
            <option value="none">選択してください</option>
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

// 質問への回答のpanel。回答は管理UIの送信buttonでだけ確定する（仕様11.8）。
// 入力は回答案として自動で保存する。確定する内容は、保存済みの回答案からserverが取る。
export function FeedbackPanel({ api, request, reload }: FeedbackPanelProps) {
  const { requestId, questionnaire } = request;
  const pending = request.status === 'pending';
  // この画面が知っている、serverの最新の回答案（取得した結果か、自分が保存した結果）。
  // 入力の保存と送信は、この版をもとにする。
  const [synced, setSynced] = useState({
    version: request.draftVersion,
    answers: request.draftAnswers,
  });
  // 入力中の回答。
  const [answers, setAnswers] = useState<Answers>(request.draftAnswers);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'submitting'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  // 旧版への回答であることを確認したときの、文書の現在の版。版がさらに変われば、確認し直す。
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(null);
  // 送信のID。通信が切れて再送するときは、同じIDを使う（二重に確定しない）。
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // 入力の回数。保存している間に入力されたら、保存の後も未保存のままにする。
  const edits = useRef(0);

  // 別の画面が回答案を更新し、こちらに未保存の入力がなければ、新しい回答案を表示する。
  // 版は増えるだけなので、知っている版より古い取得結果（自分の保存の前の状態）は使わない。
  if (request.draftVersion > synced.version && !dirty && phase === 'idle') {
    setSynced({ version: request.draftVersion, answers: request.draftAnswers });
    setAnswers(request.draftAnswers);
  }

  const newer = pending && request.currentRevision !== request.revision;
  const confirmed = newer && confirmedRevision === request.currentRevision;
  // 確定・中止した質問は、serverの内容（確定した回答、なければ保存済みの回答案）を表示する。
  // この画面の未保存の入力を、確定した回答のように見せない。
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
        // 自分の入力で、別の画面の回答案を上書きしない。最新の回答案を表示し直す。
        setDirty(false);
        setAnswers(synced.answers);
        setMessage(
          '別の画面で回答案が更新されました。最新の内容を表示しています。必要なら入力し直してください。',
        );
        setSubmissionId(newSubmissionId());
        reload();
        return;
      case 'E_NEWER_REVISION':
        setConfirmedRevision(null);
        setSubmissionId(newSubmissionId());
        setMessage(
          '文書の版が変わりました。表示中の版への回答であることを、もう一度確認してください。',
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

  // 入力が止まったら、回答案を保存する。
  useEffect(() => {
    if (!dirty || phase !== 'idle' || !pending) return undefined;
    const timer = setTimeout(() => {
      const started = edits.current;
      const sent = answers;
      setPhase('saving');
      void api.saveDraft(requestId, synced.version, sent).then(
        (saved) => {
          // 保存した回答と版を組で覚える。保存の間に入力されていれば、未保存のままにする。
          setSynced({ version: saved.draftVersion, answers: sent });
          if (edits.current === started) setDirty(false);
          setPhase('idle');
        },
        (reason: unknown) => {
          setPhase('idle');
          failWith(reason, '回答案を保存できませんでした。');
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
        // 新しい版があるときは、確認した版を送る。serverは、それが現在の版かを確かめる。
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
          // 通信が切れたときは、同じ送信IDのまま再送できるようにする。
          failWith(reason, '送信できたか確かめられませんでした。もう一度送信してください。');
        },
      );
  };

  const cancel = () => {
    setConfirmingCancel(false);
    void api
      .cancelFeedback(requestId)
      .then(reload, (reason: unknown) => failWith(reason, '中止できませんでした。'));
  };

  const statusText =
    request.status === 'cancelled'
      ? '中止されました'
      : request.status === 'submitted'
        ? request.acknowledgedAt !== null
          ? 'Agentが回答を取得しました'
          : '送信しました。Agentの取得を待っています'
        : phase === 'submitting'
          ? '送信中…'
          : phase === 'saving'
            ? '回答案を保存中…'
            : dirty
              ? '未保存の入力があります'
              : synced.version > 0
                ? '回答案を保存しました'
                : '未回答';
  const blocked =
    !pending || phase !== 'idle' || dirty || issues.length > 0 || (newer && !confirmed);

  return (
    <aside
      aria-label="質問への回答"
      className="flex max-h-[50svh] w-full shrink-0 flex-col border-t bg-background min-[900px]:max-h-none min-[900px]:w-96 min-[900px]:border-t-0 min-[900px]:border-l"
      data-testid="feedback-panel"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs text-muted-foreground">Agentからの質問</p>
        <h2 className="mt-1 text-base font-semibold break-words">{questionnaire.title}</h2>
        {questionnaire.instructions && (
          <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">
            {questionnaire.instructions}
          </p>
        )}
        {newer && (
          <div role="alert" className="mt-3 rounded-md border border-amber-500/50 p-3 text-sm">
            <p>新しい版があります。この回答は表示中の旧版に対するものです。</p>
            {confirmedRevision !== null && !confirmed && (
              <p className="mt-1">
                確認した後に、文書がさらに更新されました。もう一度確認してください。
              </p>
            )}
            <Label className="mt-2 font-normal">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(checked) =>
                  setConfirmedRevision(checked ? request.currentRevision : null)
                }
              />
              旧版への回答として送信することを確認しました
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
                  {required && <span className="ml-1 text-xs text-destructive">（必須）</span>}
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
        <p className="text-xs text-muted-foreground">送信先の質問</p>
        <p className="text-sm font-medium break-words">{questionnaire.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          対象の版 <code className="font-mono">{request.revision.slice(4, 16)}</code>
        </p>
        <dl className="mt-2 max-h-40 overflow-y-auto text-xs" aria-label="回答の要約">
          {summary.map((item) => (
            <div key={item.name} className="flex gap-2 py-0.5">
              <dt className="w-24 shrink-0 truncate text-muted-foreground">{item.title}</dt>
              <dd className="min-w-0 break-words">{item.value}</dd>
            </div>
          ))}
        </dl>
        {pending && issues.length > 0 && (
          <ul className="mt-2 text-xs text-muted-foreground" aria-label="送信の前に必要なこと">
            {describeIssues(questionnaire, issues).map((issue) => (
              <li key={`${issue.name}:${issue.text}`}>{issue.text}</li>
            ))}
          </ul>
        )}
        <p role="status" className="mt-2 text-xs" data-testid="feedback-status">
          {statusText}
        </p>
        {message && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {message}
          </p>
        )}
        {pending && (
          <div className="mt-3 flex gap-2">
            <Button type="button" className="flex-1" disabled={blocked} onClick={submit}>
              Agentへ回答を送信
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirmingCancel(true)}>
              中止
            </Button>
          </div>
        )}
      </div>
      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>質問を中止しますか</AlertDialogTitle>
            <AlertDialogDescription>
              中止すると、この質問には回答できなくなります。Agentには中止したことが伝わります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>戻る</AlertDialogCancel>
            <AlertDialogAction onClick={cancel}>中止する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
