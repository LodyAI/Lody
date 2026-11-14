import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const counter = `<button id="add">Add</button><output id="n">0</output>
<script>let n=0;document.getElementById('add').onclick=()=>document.getElementById('n').textContent=String(++n);</script>`;

const meta = {
  title: 'Conversation/Markdown HTML',
  component: MarkdownRenderer,
  args: { text: `Before\n\n\`\`\`html title="Counter"\n${counter}\n\`\`\`\n\nAfter` },
} satisfies Meta<typeof MarkdownRenderer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Counter: Story = {};
export const Unclosed: Story = { args: { text: `\`\`\`html\n${counter}` } };
export const Error: Story = {
  args: { text: '\`\`\`html\n<script>throw new Error("Synthetic failure")</script>\n\`\`\`' },
};
export const Tall: Story = {
  args: {
    text: '\`\`\`html\n<button onclick="document.querySelector(\'div\').style.height=\'900px\'">Grow</button><div style="height:120px">Content</div>\n\`\`\`',
  },
};

export const Isolation: Story = {
  args: {
    text: `\`\`\`html
<output id="result"></output><script>try{parent.document.body;document.getElementById('result').textContent='FAIL: parent readable'}catch(e){document.getElementById('result').textContent='Blocked: '+e.name}</script>
\`\`\``,
  },
};

export const Controls: Story = {
  args: {
    text: `\`\`\`html title="Controls"
${counter}
<p><input placeholder="Text field"><input disabled value="Disabled"></p>
<p><textarea placeholder="Notes"></textarea><select><option>First option</option><option>Second option</option></select></p>
<p><label><input type="checkbox" checked> Enabled</label><label><input type="radio" name="choice" checked> Choice</label><input type="checkbox" disabled></p>
<button disabled>Disabled button</button>
\`\`\``,
  },
};

export const AuthoredOverrides: Story = {
  args: {
    text: `\`\`\`html title="Author overrides"
<!doctype html><html><head><style>
@layer author { * { border-radius: 0; } button { background: gold; color: black; box-shadow: none; } html { color-scheme: light; } }
.custom { background: navy; color: white; font-family: monospace; }
</style></head><body>
${counter}
<button class="custom">Class override</button>
<button style="background: purple; color: white; border-radius: 24px">Inline override</button>
</body></html>
\`\`\``,
  },
};
