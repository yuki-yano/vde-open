import type {
  AnswerIssue,
  Answers,
  AnswerValue,
  QuestionField,
  Questionnaire,
} from '@vde-open/shared';

// 回答の1つのfieldを変える。undefinedなら、未回答（fieldを省く）にする。
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

// 必須のfieldで、空の値（空の文字列・空の配列）が回答として有効なら、その空の値（仕様11.2）。
// 入力欄が空なのは未入力と区別できないので、空の回答は利用者が明示したときだけ使う。
export function emptyAnswerOf(field: QuestionField, required: boolean): '' | [] | undefined {
  if (!required) return undefined;
  if (field.type === 'string' && field.enum === undefined && (field.minLength ?? 0) === 0) {
    return '';
  }
  if (field.type === 'array' && (field.minItems ?? 0) === 0) return [];
  return undefined;
}

// 選択肢の表示。空の文字列の選択肢も、見える形にする。
export const optionLabel = (option: string): string => (option === '' ? '（空欄）' : option);

// 回答の要約で使う、値の表示。値は文字として表示する。
export function displayValue(field: QuestionField, value: AnswerValue | undefined): string {
  if (value === undefined) return '未回答';
  if (field.type === 'boolean') return value === true ? 'はい' : 'いいえ';
  if (Array.isArray(value)) return value.length === 0 ? '（選択なし）' : value.join('、');
  if (value === '') return '（空欄）';
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
  'not-object': '回答の形が正しくありません',
  'too-large': '回答が大きすぎます',
  'unknown-field': '質問にない項目です',
  required: '回答が必要です',
  type: '値の種類が違います',
  enum: '選択肢にない値です',
  'too-long': '長すぎます',
  'too-short': '短すぎます',
  'out-of-range': '範囲の外です',
  duplicate: '同じ選択肢が重複しています',
  'too-many': '選べる数を超えています',
  'too-few': '選ぶ数が足りません',
};

// 回答の問題を、field名ごとの説明にする。
export function describeIssues(
  questionnaire: Questionnaire,
  issues: AnswerIssue[],
): Array<{ name: string; text: string }> {
  return issues.map((issue) => {
    const title = questionnaire.answerSchema.properties[issue.field]?.title ?? '回答全体';
    return { name: issue.field, text: `${title}: ${ISSUE_TEXT[issue.code]}` };
  });
}
