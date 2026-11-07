import type {
  Question,
  QuestionAnswers,
  QuestionMeta,
} from '../models/session.ts';

const record = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

/** Browser-safe normalization of the public OSS ask-user-question metadata. */
export function parseQuestionMeta(meta: unknown): QuestionMeta | undefined {
  const root = record(meta);
  if (!root) return undefined;
  const candidates = [
    ['lody', record(record(root.lody)?.elicitation)],
    ['claude', record(record(root.claudeCode)?.askUserQuestion)],
    ['codex', record(record(root.codex)?.requestUserInput)],
  ] as const;
  for (const [source, raw] of candidates) {
    if (!raw || (source === 'lody' && raw.version !== 1)) continue;
    if (!Array.isArray(raw.questions) || !raw.questions.length) continue;
    const questions: Question[] = [];
    for (const value of raw.questions) {
      const q = record(value);
      if (!q || typeof q.question !== 'string' || typeof q.header !== 'string')
        break;
      if (source === 'codex' && typeof q.id !== 'string') break;
      const options =
        source === 'codex' && q.options === undefined ? [] : q.options;
      if (
        !Array.isArray(options) ||
        options.some((o) => !record(o) || typeof o.label !== 'string')
      )
        break;
      const question: Question = {
        header: q.header,
        question: q.question,
        options: options.map((o) => ({
          label: o.label,
          ...(typeof o.description === 'string'
            ? { description: o.description }
            : {}),
          ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
        })),
        multiSelect: source !== 'codex' && q.multiSelect === true,
      };
      if (source !== 'claude') {
        if (typeof q.id === 'string') question.id = q.id;
        if (q.allowCustomAnswer === true) question.allowCustomAnswer = true;
        question.isSecret = q.isSecret === true;
        if (source === 'codex') {
          question.allowCustomAnswer =
            q.allowCustomAnswer === true ||
            q.isOther === true ||
            q.is_other === true;
          question.isSecret ||= q.is_secret === true;
        }
      }
      questions.push(question);
    }
    if (questions.length !== raw.questions.length) continue;
    const result: QuestionMeta = {
      source,
      version:
        source === 'claude' && Number.isFinite(raw.version) ? raw.version : 1,
      questions,
      allowCustomAnswer:
        source === 'claude'
          ? raw.allowCustomAnswer === true
          : questions.some((q) => q.allowCustomAnswer),
    };
    if (source === 'lody' && Number.isFinite(raw.autoResolveAtEpochSeconds)) {
      result.autoResolveAt = raw.autoResolveAtEpochSeconds * 1000;
    } else if (source !== 'claude' && Number.isFinite(raw.autoResolveAt)) {
      result.autoResolveAt = raw.autoResolveAt;
    }
    return result;
  }
  return undefined;
}

export function questionAnswerKey(
  questions: readonly Question[],
  index: number,
): string {
  const q = questions[index];
  if (!q) return String(index);
  for (const field of ['id', 'question', 'header'] as const) {
    const value = q[field];
    if (
      value?.trim() &&
      questions.filter((item) => item[field] === value).length === 1
    )
      return value;
  }
  return String(index);
}

export function questionAllowsText(
  meta: QuestionMeta,
  question: Question,
): boolean {
  return (
    question.options.length === 0 ||
    (question.allowCustomAnswer ?? meta.allowCustomAnswer)
  );
}

export function questionOutcome(
  optionId: string,
  meta: QuestionMeta,
  input: unknown,
) {
  const raw = record(input);
  if (!raw) throw new Error('invalid_answers');
  const answers: QuestionAnswers = {};
  for (const [index, question] of meta.questions.entries()) {
    const key = questionAnswerKey(meta.questions, index);
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined;
    const labels = question.options.map((o) => o.label);
    if (typeof value === 'string') {
      if (
        !value.trim() ||
        (!labels.includes(value) && !questionAllowsText(meta, question))
      )
        throw new Error('invalid_answers');
    } else if (Array.isArray(value)) {
      if (
        !question.multiSelect ||
        !value.length ||
        value.some((v) => typeof v !== 'string' || !labels.includes(v)) ||
        new Set(value).size !== value.length
      )
        throw new Error('invalid_answers');
    } else {
      throw new Error('invalid_answers');
    }
    Object.defineProperty(answers, key, { value, enumerable: true });
  }
  let responseMeta: Record<string, unknown>;
  switch (meta.source) {
    case 'lody':
      responseMeta = { lody: { elicitation: { version: 1, answers } } };
      break;
    case 'claude':
      responseMeta = { claudeCode: { askUserQuestion: { answers } } };
      break;
    case 'codex':
      responseMeta = {
        codex: {
          requestUserInput: {
            answers: Object.fromEntries(
              Object.entries(answers).map(([key, value]) => [
                key,
                { answers: Array.isArray(value) ? value : [value] },
              ]),
            ),
          },
        },
      };
      break;
  }
  return { outcome: 'selected', optionId, _meta: responseMeta };
}

/** Loro maps do not preserve JS property insertion order. */
export function samePermissionOutcome(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((v, i) => samePermissionOutcome(v, b[i]))
    );
  const left = record(a);
  const right = record(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        samePermissionOutcome(left[key], right[key]),
    )
  );
}
