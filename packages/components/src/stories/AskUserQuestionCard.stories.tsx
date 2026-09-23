import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { AskUserQuestionAnswers, AskUserQuestionPermissionMeta } from '@lody/shared';
import { AskUserQuestionCard } from '@/components/sessions/ask-user-question-card';

const questionMeta: AskUserQuestionPermissionMeta = {
  source: 'lody',
  version: 1,
  allowCustomAnswer: false,
  questions: [
    {
      id: 'approach',
      header: 'Approach',
      question: 'Which approach should we use?',
      multiSelect: false,
      options: [{ label: 'Small change' }, { label: 'Refactor' }, { label: 'None of the above' }],
      note: {
        fieldId: 'approach_note',
        title: 'Additional context',
        description: 'Optional constraints to keep in mind.',
      },
    },
  ],
};

function Interactive({ meta }: { meta: AskUserQuestionPermissionMeta }) {
  const [answers, setAnswers] = useState<AskUserQuestionAnswers>();
  const [cancelled, setCancelled] = useState(false);
  return (
    <AskUserQuestionCard
      meta={meta}
      mode={
        answers
          ? { kind: 'readonly', answers }
          : {
              kind: 'interactive',
              isReady: true,
              disabled: cancelled,
              isPendingSubmit: false,
              isPendingCancel: false,
              onSubmit: setAnswers,
              onCancel: () => setCancelled(true),
            }
      }
    />
  );
}

const meta = {
  title: 'Sessions/AskUserQuestionCard',
  component: AskUserQuestionCard,
  parameters: { layout: 'padded' },
  args: {
    meta: questionMeta,
    mode: {
      kind: 'readonly',
      answers: { approach: 'Small change', approach_note: 'Keep the public API stable.' },
    },
  },
} satisfies Meta<typeof AskUserQuestionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AnswerWithNote: Story = { render: (args) => <Interactive meta={args.meta} /> };
export const Readonly: Story = {};
export const SecretNote: Story = {
  args: {
    meta: {
      ...questionMeta,
      questions: [
        {
          ...questionMeta.questions[0]!,
          note: { fieldId: 'approach_note', title: 'Private context', isSecret: true },
        },
      ],
    },
  },
};
export const MultipleQuestions: Story = {
  render: (args) => <Interactive meta={args.meta} />,
  args: {
    meta: {
      ...questionMeta,
      questions: [
        questionMeta.questions[0]!,
        {
          id: 'constraints',
          header: 'Constraints',
          question: 'Which constraints matter?',
          multiSelect: true,
          options: [{ label: 'Offline' }, { label: 'Compatibility' }],
          note: { fieldId: 'constraints_note' },
        },
      ],
    },
  },
};
export const LegacyCustomAnswer: Story = {
  render: (args) => <Interactive meta={args.meta} />,
  args: {
    meta: {
      ...questionMeta,
      questions: [
        {
          id: 'legacy',
          header: 'Approach',
          question: 'Choose or write another approach',
          options: [{ label: 'Small change' }],
          multiSelect: false,
          allowCustomAnswer: true,
        },
      ],
    },
  },
};
