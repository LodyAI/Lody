import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presentMessageText,
  referenceSpans,
} from '../../../../packages/cloud-runtime/src/protocol/message-references.ts';
const item = {
  kind: 'session',
  path: 'session-123',
  name: '修复登录',
  insertText: '@session:session-123',
};
test('expanded session references retain readable frozen labels and UTF-16 ranges', () => {
  const text = '🙂 看看 use lody mcp to query session[id: session-123] history';
  const spans = referenceSpans(text, [item]);
  assert.equal(
    text.slice(spans[0].start, spans[0].end),
    'use lody mcp to query session[id: session-123] history',
  );
  const result = presentMessageText(text, spans);
  assert.equal(result.text, '🙂 看看 @修复登录');
  assert.equal(
    result.text.slice(result.references[0].start, result.references[0].end),
    '@修复登录',
  );
});
test('web spans display labels, keeping surrounding prose and long paths', () => {
  const text = 'A long hidden expansion Z';
  const result = presentMessageText(text, [
    {
      start: 2,
      end: 23,
      kind: 'agent_role',
      label: 'Reviewer',
      mark: '🧪',
      target: 'r',
    },
  ]);
  assert.equal(result.text, 'A 🧪 Reviewer Z');
  assert.equal(
    presentMessageText('@src/a/very-long-file.ts').text,
    '@src/a/very-long-file.ts',
  );
});
test('legacy references conceal IDs but code samples remain literal', () => {
  assert.equal(
    presentMessageText('use lody mcp to query session[id: hidden] history')
      .text,
    '@Session',
  );
  assert.equal(
    presentMessageText(
      'use lody mcp to create a session with agent role[id: r, name: Reviewer]',
    ).text,
    '🪼 Reviewer',
  );
  assert.equal(
    presentMessageText('`@session:hidden`').text,
    '`@session:hidden`',
  );
});
test('invalid and overlapping spans cannot hide unrelated text', () => {
  const text = 'normal message';
  assert.equal(
    presentMessageText(text, [
      { start: -1, end: 99, kind: 'session', label: 'hide' },
    ]).text,
    text,
  );
  assert.equal(
    presentMessageText(text, [
      { start: 0, end: 3, kind: 'unknown', label: 'hide' },
    ]).text,
    text,
  );
});

test('legacy skills hide expansion and quoted paths retain readable text', () => {
  const result = presentMessageText(
    'use /review [Skill Path](/skills/review/SKILL.md) @"src/My File.ts"',
  );
  assert.equal(result.text, '$review @src/My File.ts');
  assert.equal(result.references[0].target, '/skills/review/SKILL.md');
  assert.equal(result.references[1].target, 'src/My File.ts');
});
