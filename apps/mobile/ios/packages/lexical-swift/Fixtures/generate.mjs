import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $toMarkdown, allHeadlessNodes } from '@haklex/rich-headless';
import { createHeadlessEditor } from '@lexical/headless';

const root = join(import.meta.dirname, 'haklex');
const inputs = join(root, 'inputs');
const expected = join(root, 'expected');

for (const file of readdirSync(inputs)
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const editor = createHeadlessEditor({
    nodes: allHeadlessNodes,
    onError: (error) => {
      throw error;
    },
  });
  editor.setEditorState(
    editor.parseEditorState(readFileSync(join(inputs, file), 'utf8')),
  );
  const state = editor.getEditorState();
  const name = file.slice(0, -'.json'.length);
  writeFileSync(
    join(expected, `${name}.json`),
    `${JSON.stringify(state.toJSON(), null, 2)}\n`,
  );
  writeFileSync(
    join(expected, `${name}.md`),
    state.read(() => $toMarkdown()),
  );
}
