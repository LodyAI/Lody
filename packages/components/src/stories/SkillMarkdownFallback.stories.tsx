import type { Meta, StoryObj } from '@storybook/react';
import { SkillMarkdownFallback } from '@/components/settings/skill-markdown';

const CONTENT = [
  '# Konsta UI Design Guide',
  'Build **pixel-perfect** iOS and Material Design apps with `Konsta UI`.',
  '## When to Use This Skill',
  '- User wants native-looking UI without Ionic',
  '- User asks about *Konsta UI*',
  '- User is using React/Vue/Svelte',
  '### Steps',
  '1. Install the package',
  '2. Wrap the app in `KonstaProvider`',
  '3. Use the components',
  '> Tip: see the [docs](https://konstaui.com) for the full component list.',
  '```tsx',
  'import { App, Page } from "konsta/react";',
  'export default () => <App theme="ios"><Page>Hello</Page></App>;',
  '```',
  '---',
  'That is the whole guide.',
].join('\n');

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-[640px] max-w-full bg-background p-6">{children}</div>;
}

const meta = {
  title: 'Settings/SkillMarkdownFallback',
  component: SkillMarkdownFallback,
  parameters: { layout: 'centered' },
  render: (args) => (
    <Frame>
      <SkillMarkdownFallback {...args} />
    </Frame>
  ),
} satisfies Meta<typeof SkillMarkdownFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { content: CONTENT },
};
