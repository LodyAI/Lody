import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { VisualAnnotationDraftComposer } from '@/components/preview/visual-annotation-draft-composer';

const meta = {
  title: 'Preview/VisualAnnotationDraftComposer',
  component: VisualAnnotationDraftComposer,
  args: {
    targetLabel: 'main > section > h1 — Review this long heading without losing the target',
    value: '',
    onChange: () => {},
    onCancel: () => {},
    onSubmit: () => {},
  },
  render: function Draft(args) {
    const [value, setValue] = useState(args.value);
    return <VisualAnnotationDraftComposer {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof VisualAnnotationDraftComposer>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Ready: Story = { args: { value: 'Keep this heading aligned with the text below.' } };
export const Submitting: Story = { args: { value: 'Keep the spacing.', submitting: true } };
