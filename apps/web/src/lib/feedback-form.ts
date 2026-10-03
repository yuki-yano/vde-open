import type {
  AnswerIssue,
  Answers,
  AnswerValue,
  QuestionField,
  Questionnaire,
} from '@vde-open/shared';

// Change one field of the answers. undefined means not answered (the field is omitted).
export function withAnswer(
  answers: Answers,
  name: string,
  value: AnswerValue | undefined,
): Answers {
  const next: Answers = {};
  for (const [key, current] of Object.entries(answers)) {
    if (key !== name) next[key] = current;
  }
  if (value !== undefined) next[name] = value;
  return next;
}

// For a required field where an empty value (empty string or empty array) is a valid answer, that empty value (spec 11.2).
// An empty control cannot be told apart from "not answered", so an empty answer is used only when the user makes it explicit.
export function emptyAnswerOf(field: QuestionField, required: boolean): '' | [] | undefined {
  if (!required) return undefined;
  if (field.type === 'string' && field.enum === undefined && (field.minLength ?? 0) === 0) {
    return '';
  }
  if (field.type === 'array' && (field.minItems ?? 0) === 0) return [];
  return undefined;
}

// Display text for an option. An empty-string option is made visible too.
export const optionLabel = (option: string): string => (option === '' ? '(empty)' : option);

// Display text for a value in the answer summary. Values are shown as text.
export function displayValue(field: QuestionField, value: AnswerValue | undefined): string {
  if (value === undefined) return 'Not answered';
  if (field.type === 'boolean') return value === true ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? '(none selected)' : value.join(', ');
  if (value === '') return '(empty)';
  return String(value);
}

export interface SummaryItem {
  name: string;
  title: string;
  value: string;
  required: boolean;
}

export function summarize(questionnaire: Questionnaire, answers: Answers): SummaryItem[] {
  const { properties, required } = questionnaire.answerSchema;
  return questionnaire.fieldOrder.flatMap((name) => {
    const field = properties[name];
    if (!field) return [];
    return [
      {
        name,
        title: field.title,
        value: displayValue(field, answers[name]),
        required: required.includes(name),
      },
    ];
  });
}

const ISSUE_TEXT: Record<AnswerIssue['code'], string> = {
  'not-object': 'The answers are not in the right shape',
  'too-large': 'The answers are too large',
  'unknown-field': 'Not a field of this question',
  required: 'An answer is required',
  type: 'Wrong value type',
  enum: 'Not one of the options',
  'too-long': 'Too long',
  'too-short': 'Too short',
  'out-of-range': 'Out of range',
  duplicate: 'The same option is selected more than once',
  'too-many': 'Too many selected',
  'too-few': 'Too few selected',
};

// Turn answer issues into per-field descriptions.
export function describeIssues(
  questionnaire: Questionnaire,
  issues: AnswerIssue[],
): Array<{ name: string; text: string }> {
  return issues.map((issue) => {
    const title = questionnaire.answerSchema.properties[issue.field]?.title ?? 'Whole answer';
    return { name: issue.field, text: `${title}: ${ISSUE_TEXT[issue.code]}` };
  });
}
