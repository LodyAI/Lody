import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { GenuiSurface } from '@/components/ai-gui/genui/genui-surface';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const meta = {
  title: 'AI GUI/GenUI Surface',
  component: GenuiSurface,
  tags: ['autodocs'],
} satisfies Meta<typeof GenuiSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

const interactive = `{@state const [value, setValue] = useState(65)}
{@state const [enabled, setEnabled] = useState(true)}
<card>
  <column gap={8}>
    <row>
      <heading level={4}>Progress</heading>
      <badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</badge>
    </row>
    <slider value={value} min={0} max={100} disabled={!enabled} onChange={(n) => setValue(n)} />
    <row>
      <switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
      <button onClick={() => setValue(65)}>Reset</button>
    </row>
  </column>
</card>`;

export const Interactive: Story = {
  args: { code: interactive },
};

export const Broken: Story = {
  args: { code: '<card><unclosed' },
};

const streaming = `{@state const [value, setValue] = useState(65)}
<card>
  <column gap={8}>
    <row>
      <heading level={4}>Progress</heading>
      <badge tone="success">live</badge>
    </row>
    <slider value={value} min={0} max={100} onChange={(n) => setValue(n)} />
    <row>
      <button onClick={() => setValue(65)}>Re`;

/** A fence still being written: committed nodes mount, the tail waits. */
export const Streaming: Story = {
  args: { code: streaming, streaming: true },
};

const streamingFence = `前缀文字。

\`\`\`genui
{@state const [value, setValue] = useState(65)}
<card>
  <column gap={8}>
    <slider value={value} min={0} max={100} onChange={(n) => setValue(n)} />
    <row>
      <button onClick={() => setValue(6`;

const closedFence = `${streamingFence}5)}>Reset</button>
    </row>
  </column>
</card>
\`\`\``;

/** The real dispatch path: an unclosed ```genui fence inside markdown. */
export const InMarkdownStream: Story = {
  args: { code: streamingFence },
  render: () => <MarkdownRenderer text={streamingFence} isStreaming />,
};

export const InMarkdownClosed: Story = {
  args: { code: closedFence },
  render: () => <MarkdownRenderer text={closedFence} />,
};

const brokenFence = `前文。

\`\`\`genui
<card><slider value={v
\`\`\`

后文。`;

/** A fence that cannot mount degrades to its own code block, never an error. */
export const InMarkdownBroken: Story = {
  args: { code: brokenFence },
  render: () => <MarkdownRenderer text={brokenFence} />,
};

const liveDoc = `进度卡片：

\`\`\`genui
{@state const [value, setValue] = useState(65)}
<card>
  <column gap={8}>
    <row>
      <heading level={4}>Progress</heading>
      <badge tone="success">live</badge>
    </row>
    <slider value={value} min={0} max={100} onChange={(n) => setValue(n)} />
    <row>
      <button onClick={() => setValue(65)}>Reset</button>
    </row>
  </column>
</card>
\`\`\`

收尾文字。`;

function LiveStream() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= liveDoc.length) return;
    const t = setTimeout(() => setN((v) => Math.min(v + 2, liveDoc.length)), 24);
    return () => clearTimeout(t);
  }, [n]);
  const done = n >= liveDoc.length;
  return <MarkdownRenderer text={liveDoc.slice(0, n)} isStreaming={!done} />;
}

/** The fence types in character by character; elements mount as tags close. */
export const StreamingLive: Story = {
  args: { code: liveDoc },
  render: () => <LiveStream />,
};
