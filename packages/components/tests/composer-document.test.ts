import { $getRoot, createEditor, type LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';
import {
  $readComposerValue,
  $readSelectionOffsets,
  $setSelectionOffsets,
  $writeComposerValue,
  type ComposerMentionRange,
} from '../src/ui/mention/composer-document';
import { MentionDecoratorNode } from '../src/ui/mention/mention-node';

// The composer's owner keeps a string plus UTF-16 ranges; the editor keeps a
// Lexical document. Every offset the product computes depends on these two
// views agreeing exactly.

function headlessEditor(): LexicalEditor {
  return createEditor({
    namespace: 'composer-test',
    nodes: [MentionDecoratorNode],
    onError: (error) => {
      throw error;
    },
  });
}

function write(editor: LexicalEditor, text: string, mentions: ComposerMentionRange[]) {
  editor.update(() => $writeComposerValue(text, mentions), { discrete: true });
}

function read(editor: LexicalEditor) {
  return editor.getEditorState().read(() => $readComposerValue());
}

const PAD = ' ';

describe('composer document boundary', () => {
  it.each([
    ['empty', '', []],
    ['CJK, emoji surrogate pairs and newlines', '你好👋🏽\n\n第二段 tail\n', []],
    [
      'chips at line start, mid-line, line end and adjacent',
      '@src/a.ts mid $skill\n/cmd@b #12',
      [
        { start: 0, end: 9, value: 'src/a.ts', kind: 'file' },
        { start: 14, end: 20, value: 'skill', kind: 'skill' },
        { start: 21, end: 25, value: 'cmd', kind: 'command' },
        { start: 25, end: 27, value: 'b', kind: 'session' },
        { start: 28, end: 31, value: '12', kind: 'issue' },
      ],
    ],
    [
      'figure-space pasted-text labels',
      `前${PAD}[Pasted 120 chars]${PAD}后`,
      [{ start: 1, end: 21, value: 'paste-1', kind: 'pasted_text' }],
    ],
    [
      'a chip holding an emoji and a newline-free quote',
      '看 @角色🤖 ok',
      [{ start: 2, end: 7, value: 'role:1', kind: 'agent_role' }],
    ],
  ] as const)('round-trips %s', (_name, text, mentions) => {
    const editor = headlessEditor();
    write(editor, text, [...mentions]);
    expect(read(editor)).toEqual({ text, mentions });
  });

  it('keeps one paragraph and represents newlines as line breaks', () => {
    const editor = headlessEditor();
    write(editor, 'a\nb\n', []);
    const shape = editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .map((paragraph) => ({
          type: paragraph.getType(),
          children:
            'getChildren' in paragraph
              ? (paragraph as any).getChildren().map((n: any) => n.getType())
              : [],
        }))
    );
    expect(shape).toEqual([
      { type: 'paragraph', children: ['text', 'linebreak', 'text', 'linebreak'] },
    ]);
  });

  it('drops invalid and overlapping ranges the way persisted ranges are sanitized', () => {
    const editor = headlessEditor();
    write(editor, 'abc def ghi', [
      { start: 0, end: 3, value: 'abc', kind: 'file' },
      { start: 2, end: 6, value: 'overlap', kind: 'file' },
      { start: 8, end: 20, value: 'too-long', kind: 'file' },
      { start: 5, end: 5, value: 'empty', kind: 'file' },
      { start: 8, end: 11, value: 'ghi', kind: 'skill' },
    ]);
    expect(read(editor)).toEqual({
      text: 'abc def ghi',
      mentions: [
        { start: 0, end: 3, value: 'abc', kind: 'file' },
        { start: 8, end: 11, value: 'ghi', kind: 'skill' },
      ],
    });
  });

  it('keeps a chip kindless when its range had no kind', () => {
    const editor = headlessEditor();
    write(editor, '@x y', [{ start: 0, end: 2, value: 'x' }]);
    expect(read(editor).mentions).toEqual([{ start: 0, end: 2, value: 'x' }]);
  });
});

describe('composer selection offsets', () => {
  const text = 'ab\n@chip cd';
  const mentions = [{ start: 3, end: 8, value: 'chip', kind: 'file' }];

  function editorWithSelection(start: number, end: number) {
    const editor = headlessEditor();
    write(editor, text, mentions);
    editor.update(() => $setSelectionOffsets(start, end), { discrete: true });
    return editor.getEditorState().read(() => $readSelectionOffsets());
  }

  it.each([0, 1, 2, 3, 8, 9, 11])('round-trips a collapsed caret at %i', (offset) => {
    expect(editorWithSelection(offset, offset)).toEqual({ start: offset, end: offset });
  });

  it('places a caret requested inside a chip at its nearest edge', () => {
    expect(editorWithSelection(4, 4)).toEqual({ start: 3, end: 3 });
    expect(editorWithSelection(7, 7)).toEqual({ start: 8, end: 8 });
  });

  it('keeps a range selection that spans a chip', () => {
    expect(editorWithSelection(1, 10)).toEqual({ start: 1, end: 10 });
  });

  it('clamps offsets past the end of the text', () => {
    expect(editorWithSelection(99, 99)).toEqual({ start: text.length, end: text.length });
  });
});
