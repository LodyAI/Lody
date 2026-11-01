import { getAgentRoleEmoji } from '../src/agent-role';
import { buildAgentMessageAuthor, snapshotAgentRole } from '../src/message-author';
import { describe, expect, it, vi } from 'vitest';
import { Loro, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { z } from 'zod';
import { parseHistoryWrite } from '../src/history-write-schema';
import { createSessionMirror } from '../src/session-mirror';
import { sessionDocSchema, type SessionHistory } from '../src/schema';
import type { SessionId } from '../src/ids';
import { createHistoryWriter, type StoredHistorySnapshot } from '../src/history-writer';
import { applyNotificationOnHistory } from '../src/acp/history-apply';
import { parseSessionNotification } from '../src/acp/schema';
import type { LodySubagentEvent, LodySubagentSnapshot } from 'acp-extension-core';
import type { MessageContent } from '../src/ai';
import { formatMessageQuote, readMessageQuote } from '../src/message-quote';
import { sanitizeMessageTextSpans } from '../src/message-text-spans';
import {
  historyItemsToInputBlocks,
  resolveSessionExecutionInputBlocks,
} from '../src/session-input';

const id = 'synthetic-session' as SessionId;
const entry = (turnId = 'turn'): SessionHistory => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00Z',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
});
const open = (doc: Loro) =>
  createSessionMirror({ doc, initialState: { session: { id }, history: [] } });

describe('single history writer', () => {
  it('retains quoted snapshots through the writer, a restart and execution projection', () => {
    const snapshot = '  Unicode 引文 👩🏽‍💻\n\n> nested\nEnd of quoted message.\n';
    const quote = formatMessageQuote(snapshot);
    const text = `${quote}\n\nExplain this passage.`;
    const span = {
      start: 0,
      end: quote.length,
      kind: 'message_quote' as const,
      quoteVersion: 1 as const,
      label: '[Quote]',
      target: 'quote-1',
    };
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({ ...entry(), items: [{ type: 'text', text, spans: [span] }] });
    const bytes = doc.export({ mode: 'snapshot' });
    mirror.dispose();
    const restarted = new Loro();
    restarted.import(bytes);
    const revived = open(restarted);
    try {
      const item = revived.historyWriter.readStored()[0]!.items![0]!;
      expect(item).toMatchObject({ type: 'text', text, spans: [span] });
      if (item.type !== 'text') throw new Error('Expected authored text');
      expect(
        readMessageQuote(item.text.slice(span.start, span.end), item.spans![0]!.quoteVersion)
      ).toBe(snapshot);
      const blocks = historyItemsToInputBlocks([item]);
      expect(resolveSessionExecutionInputBlocks({ prompt: text, inputBlocks: blocks })).toEqual([
        { type: 'text', text },
      ]);
      expect(sanitizeMessageTextSpans(text, [{ ...span, end: text.length }])).toBeUndefined();
      expect(text).toContain('Explain this passage.');
    } finally {
      revived.dispose();
    }
  });
  it.each(['other', 'execute', 'search', 'fetch', undefined] as const)(
    'drops unused tool bytes for kind %s while preserving audio and download references',
    (kind) => {
      const doc = new Loro();
      const writer = open(doc).historyWriter;
      const attachment = {
        type: 'image_group' as const,
        images: [{ imageId: 'r2-image', mimeType: 'image/png' as const, sizeBytes: 1 }],
      };
      writer.append({ ...entry('first'), role: 'assistant', items: [attachment] });
      const images = [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'DROP_IMAGE' } },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'synthetic://image', mimeType: ' Image/SVG+XML ', blob: 'DROP_BLOB' },
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'data:image/png;base64,DROP_URI', blob: 'DROP_URI' },
          },
        },
      ];
      const retained = [
        { type: 'content', content: { type: 'text', text: 'Tool result. '.repeat(6000) } },
        { type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: 'AUDIO' } },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: {
              uri: 'https://example.invalid/download.pdf',
              mimeType: 'application/pdf',
              blob: '',
            },
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'synthetic://text', text: 'Resource text' },
          },
        },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'synthetic://image-reference',
            name: 'Image link',
          },
        },
        { type: 'content', content: { type: 'resource_link', uri: '', name: 'Binary label' } },
      ];
      const binary = 'QUJD'.repeat(128 * 1024);
      const incoming = retained.map((block) => {
        if (block.content.type === 'resource_link' && block.content.uri === '')
          return {
            ...block,
            content: { ...block.content, uri: `data:application/octet-stream;base64,${binary}` },
          };
        if (block.content.type !== 'resource' || !('blob' in block.content.resource)) return block;
        return {
          ...block,
          content: { ...block.content, resource: { ...block.content.resource, blob: binary } },
        };
      });
      const emit = (update: Record<string, unknown>) =>
        writer.updateEntry(
          'first',
          (turn) =>
            applyNotificationOnHistory(
              [turn],
              [parseSessionNotification({ sessionId: 'root', update })],
              undefined,
              { targetAssistantEntryId: 'first' }
            )[0]!
        );
      emit({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool',
        title: 'Screenshot tool',
        kind,
        status: 'in_progress',
        content: [images[0], incoming[0], ...images.slice(1), ...incoming.slice(1)],
      });
      emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
      const stored = writer.read('first')!;
      expect(stored.items).toMatchObject([
        attachment,
        {
          type: 'tool_call',
          toolCallId: 'tool',
          title: 'Screenshot tool',
          status: 'completed',
          content: retained,
        },
      ]);
      expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_');
      expect(JSON.stringify(doc.toJSON())).not.toContain(binary);
      const fork = open(new Loro()).historyWriter;
      const snapshot = writer.capture();
      fork.copyFrom(snapshot, snapshot.history);
      expect(fork.read('first')).toEqual(stored);

      // An image-only replacement still clears earlier tool output.
      emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: images });
      const replaced = writer.read('first')!;
      expect(replaced.items[0]).toMatchObject(attachment);
      expect(replaced.items[1]).toMatchObject({ toolCallId: 'tool', status: 'completed' });
      const tool = replaced.items[1] as Extract<MessageContent, { type: 'tool_call' }>;
      expect(tool.content ?? []).toEqual([]);
    }
  );

  it('drops child tool images while retaining other-kind content and sparse updates', () => {
    const doc = new Loro();
    const writer = open(doc).historyWriter;
    writer.append({ ...entry('first'), role: 'assistant', items: [] });
    const emit = (payload: Record<string, unknown>) =>
      writer.updateEntry(
        'first',
        (turn) =>
          applyNotificationOnHistory(
            [turn],
            [
              parseSessionNotification({
                sessionId: 'root',
                update: {
                  sessionUpdate: 'subagent_event',
                  event: { version: 1, sessionId: 'root', runId: 'run', ...payload },
                },
              }),
            ],
            undefined,
            { targetAssistantEntryId: 'first' }
          )[0]!
      );
    emit({
      type: 'snapshot',
      snapshot: {
        state: 'running',
        support: { stream: ['tool'], progress: false, cancel: false, outputRead: 'none' },
      },
    });
    const retained = [
      { type: 'content', content: { type: 'text', text: 'Read result' } },
      {
        type: 'diff',
        path: 'synthetic.txt',
        oldText: 'before',
        newText: 'Readable diff. '.repeat(6000),
      },
      { type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: 'AUDIO' } },
      {
        type: 'content',
        content: {
          type: 'resource',
          resource: {
            uri: 'https://example.invalid/tool.zip',
            mimeType: 'application/zip',
            blob: '',
          },
        },
      },
    ];
    const images = [
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'DROP_CHILD' } },
      {
        type: 'content',
        content: {
          type: 'resource',
          resource: { uri: 'synthetic://image', mimeType: 'image/png', blob: 'DROP_CHILD_BLOB' },
        },
      },
    ];
    emit({
      type: 'output',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'child-tool',
        title: 'Child tool',
        kind: 'other',
        content: [
          ...retained.map((block) =>
            block.type === 'content' && block.content.type === 'resource'
              ? {
                  ...block,
                  content: {
                    ...block.content,
                    resource: { ...block.content.resource, blob: 'DROP_CHILD_BINARY' },
                  },
                }
              : block
          ),
          ...images,
        ],
        rawInput: { unusedBinary: 'DROP_CHILD_RAW_INPUT' },
      },
    });
    emit({
      type: 'output',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'child-tool', status: 'completed' },
    });
    const task = writer.read('first')!.items[0] as Extract<
      MessageContent,
      { type: 'subagent_task' }
    >;
    expect(task.run?.items).toMatchObject([
      { toolCallId: 'child-tool', kind: 'other', status: 'completed', content: retained },
    ]);
    expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_CHILD');
    expect(task.run?.items[0]).not.toHaveProperty('rawInput');
    emit({
      type: 'output',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'child-tool', content: images },
    });
    const replaced = writer.read('first')!.items[0] as Extract<
      MessageContent,
      { type: 'subagent_task' }
    >;
    expect(replaced.run?.items).toMatchObject([
      { toolCallId: 'child-tool', status: 'completed', content: [] },
    ]);
    // Claude forwards a child Read's raw tool_result array as rawOutput. Its image
    // entries must not reach history through the readable output copy.
    const rawImage = (data: string) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data },
    });
    emit({
      type: 'output',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'child-image-read',
        title: 'Read slide.png',
        kind: 'read',
        status: 'completed',
        rawOutput: [rawImage('DROP_CHILD_RAW_IMAGE'), { type: 'text', text: 'Readable note' }],
      },
    });
    emit({
      type: 'output',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'child-image-only',
        title: 'Read chart.png',
        kind: 'read',
        status: 'completed',
        rawOutput: [rawImage('DROP_CHILD_RAW_ONLY')],
      },
    });
    const imageReads = (
      writer.read('first')!.items[0] as Extract<MessageContent, { type: 'subagent_task' }>
    ).run?.items.slice(-2);
    expect(imageReads).toMatchObject([
      {
        toolCallId: 'child-image-read',
      },
      { toolCallId: 'child-image-only' },
    ]);
    const imageOnly = imageReads?.[1] as Extract<MessageContent, { type: 'tool_call' }>;
    expect(imageOnly.content ?? []).toEqual([]);
    expect(
      (imageReads?.[0] as Extract<MessageContent, { type: 'tool_call' }> | undefined)?.content ?? []
    ).toEqual([]);
    expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_CHILD');
    const plan = 'Useful approval plan. '.repeat(6000);
    emit({
      type: 'output',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'plan',
        title: 'Plan approval',
        kind: 'switch_mode',
        rawInput: { plan, unusedBinary: 'DROP_CHILD_PLAN_INPUT' },
        rawOutput: { summary: 'Readable JSON. '.repeat(6000) },
      },
    });
    const planned = writer.read('first')!.items[0] as Extract<
      MessageContent,
      { type: 'subagent_task' }
    >;
    expect(planned.run?.items.at(-1)).toMatchObject({
      rawInput: { plan },
    });
    expect(planned.run?.items.at(-1)).not.toHaveProperty('rawOutput');
    expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_CHILD_PLAN_INPUT');
  });

  it.each(['read', 'edit', 'execute', 'switch_mode'] as const)(
    'persists root and child %s tools through the same projection and sparse merge',
    (kind) => {
      const doc = new Loro();
      const writer = open(doc).historyWriter;
      writer.append({ ...entry('first'), role: 'assistant', items: [] });
      writer.updateEntry(
        'first',
        (turn) =>
          applyNotificationOnHistory(
            [turn],
            [
              parseSessionNotification({
                sessionId: 'root',
                update: {
                  sessionUpdate: 'subagent_event',
                  event: {
                    version: 1,
                    sessionId: 'root',
                    runId: 'run',
                    type: 'snapshot',
                    snapshot: {
                      state: 'running',
                      support: {
                        stream: ['tool'],
                        progress: false,
                        cancel: false,
                        outputRead: 'none',
                      },
                    },
                  },
                },
              }),
            ],
            undefined,
            { targetAssistantEntryId: 'first' }
          )[0]!
      );
      const emit = (update: Record<string, unknown>) => {
        writer.updateEntry(
          'first',
          (turn) =>
            applyNotificationOnHistory(
              [turn],
              [
                parseSessionNotification({ sessionId: 'root', update }),
                parseSessionNotification({
                  sessionId: 'root',
                  update: {
                    sessionUpdate: 'subagent_event',
                    event: { version: 1, type: 'output', sessionId: 'root', runId: 'run', update },
                  },
                }),
              ],
              undefined,
              { targetAssistantEntryId: 'first' }
            )[0]!
        );
        const items = writer.read('first')!.items;
        const root = items.find((item) => item.type === 'tool_call');
        const task = items.find((item) => item.type === 'subagent_task') as Extract<
          MessageContent,
          { type: 'subagent_task' }
        >;
        expect(task.run?.items).toEqual([root]);
        return root as Extract<MessageContent, { type: 'tool_call' }>;
      };
      const body = 'DROP_FILE_BODY'.repeat(10000);
      const output = '终端 output '.repeat(1000);
      const first = emit({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool',
        kind,
        title: 'Useful title',
        status: 'in_progress',
        content:
          kind === 'execute'
            ? [{ type: 'content', content: { type: 'text', text: output } }]
            : kind === 'switch_mode'
              ? []
              : [
                  { type: 'diff', path: '/synthetic.txt', oldText: body, newText: body },
                  { type: 'content', content: { type: 'text', text: body } },
                ],
        rawInput:
          kind === 'switch_mode'
            ? { plan: '# Useful plan', unused: body }
            : kind === 'execute'
              ? { command: 'echo hello', unused: body }
              : { unused: body },
        rawOutput: kind === 'read' || kind === 'edit' ? body : { aggregated_output: output },
        _meta: { unused: body },
      });
      expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_FILE_BODY');
      if (kind === 'read' || kind === 'edit') {
        expect(first.locations).toEqual([{ path: '/synthetic.txt' }]);
        expect(first.content ?? []).toEqual([]);
      }
      if (kind === 'execute') {
        const outputBlock = first.content?.find((block) => block.type === 'terminal_output');
        expect(outputBlock?.type === 'terminal_output' && outputBlock.truncated).toBe(true);
      }
      if (kind === 'switch_mode') expect(first.rawInput).toEqual({ plan: '# Useful plan' });
      if (kind === 'read' || kind === 'edit') {
        for (const rawOutput of [{ body }, [{ type: 'text', text: body }]]) {
          emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool',
            rawOutput,
            content: [{ type: 'diff', path: '/synthetic.txt', oldText: body, newText: body }],
          });
          expect(JSON.stringify(doc.toJSON())).not.toContain('DROP_FILE_BODY');
        }
      }
      const completed = emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool',
        status: 'completed',
      });
      expect(completed.title).toBe('Useful title');
      expect(completed.content ?? []).toEqual(first.content ?? []);
      const replayed = emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool',
        status: 'pending',
      });
      expect(replayed.status).toBe('completed');
      const duplicate = emit({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool',
        title: 'Useful title',
        status: 'pending',
      });
      expect(duplicate.content ?? []).toEqual(first.content ?? []);
      expect(duplicate.locations).toEqual(first.locations);
      const replaced = emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool',
        locations: [],
        content: [],
      });
      expect(replaced.locations).toEqual([]);
      expect(replaced.content?.filter((block) => block.type !== 'terminal_command') ?? []).toEqual(
        []
      );
      const restored = new Loro();
      restored.import(doc.export({ mode: 'snapshot' }));
      expect(open(restored).historyWriter.read('first')).toEqual(writer.read('first'));
    }
  );

  it('freezes the same default emoji displayed by the Role catalog', () => {
    const role = snapshotAgentRole({ id: 'reviewer' as never, revision: 1, name: 'Reviewer' });
    const author = buildAgentMessageAuthor({
      sessionId: 'source',
      turnId: 'turn',
      cliType: 'builtin',
      agentType: 'codex',
      role,
    });
    expect(role.emoji).toBe(getAgentRoleEmoji({}));
    expect(author.role?.emoji).toBe(getAgentRoleEmoji({}));
    expect(author.agentType).toBe('codex');
  });
  it('retains frozen Agent authors through streaming, snapshots and invalid writes', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const author = buildAgentMessageAuthor({
      sessionId: 'source',
      turnId: 'source-turn',
      agentConfigId: 'agent-a',
      name: 'Agent A',
      inputConfig: {
        modelId: 'model-a',
        configOptionValues: { api_key: 'never-store', reasoning_effort: 'high' },
      },
      role: { id: 'reviewer' as never, revision: 1, name: 'Reviewer', emoji: '🔎' },
    });
    mirror.historyWriter.append({
      ...entry(),
      userId: 'human',
      author,
      inputConfig: { modelId: 'model-b' },
    });
    mirror.historyWriter.updateEntry('turn', (turn) => {
      turn.items = [{ type: 'text', text: 'updated' }];
      return turn;
    });
    const stored = mirror.getState().history[0];
    expect(stored).toMatchObject({
      userId: 'human',
      author: { name: 'Agent A', model: { id: 'model-a' }, role: { name: 'Reviewer' } },
      inputConfig: { modelId: 'model-b' },
    });
    expect(JSON.stringify(stored)).not.toContain('never-store');
    const restoredDoc = new Loro();
    restoredDoc.import(doc.export({ mode: 'snapshot' }));
    const restored = open(restoredDoc);
    expect(restored.getState().history[0]?.author).toEqual(author);
    expect(() =>
      mirror.historyWriter.updateEntry('turn', (turn) => ({
        ...turn,
        author: { ...author, sessionId: '' },
      }))
    ).toThrow();
    expect(mirror.getState().history[0]?.author).toEqual(author);
    const map = doc.getList('history').get(0) as LoroMap;
    expect((map.get('author') as LoroMap).get('name')).toBe('Agent A');
    const copied = open(new Loro());
    const snapshot = mirror.historyWriter.capture();
    copied.historyWriter.copyFrom(snapshot, snapshot.history);
    expect(copied.getState().history[0]?.author).toEqual(author);
    mirror.historyWriter.updateEntry('turn', (turn) => ({
      ...turn,
      author: { v: 1, kind: 'human', userId: 'editor' },
    }));
    expect(mirror.getState().history[0]?.author).toEqual({ v: 1, kind: 'human', userId: 'editor' });
  });

  it('retains child message identities and scalar tool output without altering root identity', () => {
    const writer = open(new Loro()).historyWriter;
    writer.append({ ...entry('first'), role: 'assistant', acpTurnId: 'parent', items: [] });
    const emit = (payload: Record<string, unknown>) =>
      writer.updateEntry('first', (turn) => {
        const notification = parseSessionNotification({
          sessionId: 'root',
          update: {
            sessionUpdate: 'subagent_event',
            event: { version: 1, sessionId: 'root', runId: 'run', ...payload },
          },
        });
        return applyNotificationOnHistory([turn], [notification], undefined, {
          targetAssistantEntryId: 'first',
        })[0]!;
      });
    emit({
      type: 'snapshot',
      snapshot: {
        state: 'running',
        support: { stream: ['text', 'tool'], progress: false, cancel: false, outputRead: 'none' },
      },
    });
    const text = (nativeTurnId: string, messageId: string, delta: string) =>
      emit({
        type: 'output',
        nativeTurnId,
        messageId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } },
      });
    text('turn-a', 'message-a', 'one');
    text('turn-a', 'message-a', 'two');
    text('turn-a', 'message-b', 'three');
    text('turn-b', 'message-b', 'four');
    emit({
      type: 'output',
      nativeTurnId: 'turn-b',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool',
        title: 'Read',
        rawInput: ['file'],
        rawOutput: 'file contents',
      },
    });
    const turn = writer.read('first')!;
    const task = turn.items[0] as Extract<MessageContent, { type: 'subagent_task' }>;
    expect(turn.acpTurnId).toBe('parent');
    expect(task.run?.snapshot.outputIncomplete).toBeUndefined();
    expect(task.run?.items).toMatchObject([
      { type: 'text', nativeTurnId: 'turn-a', messageId: 'message-a', text: 'onetwo' },
      { type: 'text', nativeTurnId: 'turn-a', messageId: 'message-b', text: 'three' },
      { type: 'text', nativeTurnId: 'turn-b', messageId: 'message-b', text: 'four' },
      {
        type: 'tool_call',
        nativeTurnId: 'turn-b',
        content: [{ type: 'terminal_output', output: 'file contents' }],
      },
    ]);
    expect(task.run?.items.at(-1)).not.toHaveProperty('_meta.lody.subagentRaw');
  });
  it('persists isolated child transcripts on their original turn across parent completion and reopening', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const writer = mirror.historyWriter;
    writer.append({ ...entry('first'), role: 'assistant', acpTurnId: 'parent-turn', items: [] });
    const snapshot: LodySubagentSnapshot = {
      state: 'running',
      parentRunId: null,
      name: 'Worker',
      support: {
        stream: ['text', 'thought', 'tool', 'plan'],
        progress: true,
        outputRead: 'none',
        cancel: false,
      },
    };
    const emit = (
      runId: string,
      payload: Omit<LodySubagentEvent, 'version' | 'sessionId' | 'runId'> | Record<string, unknown>,
      target = 'first',
      sessionId = 'root'
    ) => {
      const notification = parseSessionNotification({
        sessionId,
        update: {
          sessionUpdate: 'subagent_event',
          event: { version: 1, sessionId, runId, ...payload },
        },
      });
      writer.update((history) =>
        applyNotificationOnHistory(history, [notification], undefined, {
          targetAssistantEntryId: target,
        })
      );
    };
    emit('a', { type: 'snapshot', snapshot });
    emit('b', { type: 'snapshot', snapshot });
    const chunk = (text: string) => ({
      type: 'output',
      nativeTurnId: 'child-turn',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { lody: { turnId: 'child-turn' } },
      },
    });
    emit('a', chunk('hello'));
    emit('a', chunk('hello'));
    emit('b', chunk('independent'));
    for (const runId of ['a', 'b'])
      emit(runId, {
        type: 'output',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'same-tool',
          title: runId,
          status: 'in_progress',
        },
      });
    writer.updateEntry('first', (turn) => ({ ...turn, finished: true, endedAt: 1 }));
    writer.append({ ...entry('second'), role: 'assistant', items: [] });
    emit(
      'a',
      {
        type: 'output',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'same-tool',
          status: 'completed',
          content: [{ type: 'diff', path: 'file', oldText: '', newText: 'full diff retained' }],
        },
      },
      'second'
    );
    emit(
      'a',
      { type: 'progress', progress: { summary: 'working', totalTokens: 10, lastToolName: 'Read' } },
      'second'
    );
    emit('a', { type: 'progress', progress: { summary: null } }, 'second');
    emit(
      'a',
      {
        type: 'output',
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'child plan', status: 'completed', priority: 'high' }],
        },
      },
      'second'
    );
    emit(
      'a',
      { type: 'snapshot', snapshot: { ...snapshot, state: 'unknown', outputIncomplete: true } },
      'second'
    );
    emit('a', { type: 'snapshot', snapshot: { ...snapshot, state: 'completed' } }, 'second');
    emit('a', chunk('late output'), 'second');
    emit('missing', chunk('orphan'), 'second');
    emit('a', chunk('cross root'), 'second', 'another-root');
    const first = writer.read('first')!;
    const tasks = first.items as Extract<MessageContent, { type: 'subagent_task' }>[];
    expect(first.acpTurnId).toBe('parent-turn');
    expect(first.plan).toBeUndefined();
    expect(writer.read('second')!.items).toEqual([]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.run).toMatchObject({
      snapshot: { state: 'completed', outputIncomplete: true },
      progress: { summary: null, totalTokens: 10, lastToolName: 'Read' },
      items: [
        { type: 'text', text: 'hellohello' },
        {
          type: 'tool_call',
          toolCallId: 'same-tool',
          status: 'completed',
          content: [{ type: 'diff', newText: 'full diff retained' }],
        },
        { type: 'plan' },
      ],
    });
    expect(tasks[1]?.run?.items).toMatchObject([
      { type: 'text', text: 'independent' },
      { type: 'tool_call', status: 'in_progress' },
    ]);
    const row = doc.getList('history').get(0) as LoroMap;
    const task = (row.get('items') as LoroList).get(0) as LoroMap;
    const run = task.get('run') as LoroMap;
    const childText = (run.get('items') as LoroList).get(0) as LoroMap;
    expect(childText.get('text')).toBeInstanceOf(LoroText);
    expect(run.get('sessionId')).toBe('root');
    expect((run.get('snapshot') as LoroMap).get('state')).toBe('completed');
    const copy = new Loro();
    copy.import(doc.export({ mode: 'snapshot' }));
    expect(open(copy).historyWriter.read('first')).toEqual(first);
  });

  it('rejects malformed child history atomically and refuses unresolved or cyclic ownership', () => {
    const doc = new Loro();
    const writer = open(doc).historyWriter;
    writer.append({ ...entry('first'), role: 'assistant', items: [] });
    const snapshot: LodySubagentSnapshot = {
      state: 'running',
      parentRunId: null,
      support: { stream: ['text'], progress: false, outputRead: 'none', cancel: false },
    };
    const notification = (runId: string, parentRunId: string | null) =>
      parseSessionNotification({
        sessionId: 'root',
        update: {
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            sessionId: 'root',
            runId,
            type: 'snapshot',
            snapshot: { ...snapshot, parentRunId },
          },
        },
      });
    writer.update((history) => applyNotificationOnHistory(history, [notification('a', null)]));
    expect(writer.read('first')!.items).toEqual([]);
    writer.update((history) =>
      applyNotificationOnHistory(
        history,
        [
          notification('a', null),
          notification('b', 'a'),
          notification('a', 'b'),
          notification('c', 'missing'),
        ],
        undefined,
        { targetAssistantEntryId: 'first' }
      )
    );
    const before = writer.read('first');
    expect(before!.items).toHaveLength(2);
    expect(before!.items[0]).toMatchObject({ run: { snapshot: { parentRunId: null } } });
    expect(() =>
      writer.updateEntry('first', (turn) => ({
        ...turn,
        items: [
          {
            type: 'subagent_task',
            taskId: 'bad',
            status: 'in_progress',
            run: {
              sessionId: 'root',
              snapshot,
              items: [{ type: 'tool_call', toolCallId: 'secret', status: 'invalid' }],
            },
          },
        ] as never,
      }))
    ).toThrow('Invalid history write');
    expect(writer.read('first')).toEqual(before);
    expect(() =>
      parseSessionNotification({
        sessionId: 'root',
        update: {
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            sessionId: 'root',
            runId: 'bad',
            type: 'output',
            update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypass' },
          },
        },
      })
    ).toThrow();
  });
  it.each(['containers', 'legacy JSON'] as const)(
    'responds to permissions without reading unrelated bodies: %s',
    (representation) => {
      const doc = new Loro();
      const writer = createHistoryWriter(doc);
      const turn = (turnId: string): SessionHistory => ({
        ...entry(turnId),
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: turnId,
            status: 'pending',
            permissionRequest: { requestId: 'request', options: [] },
          },
        ],
      });
      writer.append(turn('older'));
      if (representation === 'containers') writer.append(turn('target'));
      else {
        const row = doc.getList('history').pushContainer(new LoroMap());
        for (const [key, value] of Object.entries(turn('target'))) row.set(key, value);
        doc.commit();
      }
      writer.append(entry('unrelated'));
      const list = doc.getList('history');
      const unrelated = list.get(2) as LoroMap;
      unrelated.set('future', { opaque: true });
      doc.commit();
      const before = unrelated.toJSON();
      const listToJSON = LoroList.prototype.toJSON;
      const mapToJSON = LoroMap.prototype.toJSON;
      const listGuard = vi.spyOn(LoroList.prototype, 'toJSON').mockImplementation(function () {
        if (this.id === list.id) throw new Error('Full history body read');
        return listToJSON.call(this);
      });
      const mapGuard = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
        if (this.id === unrelated.id) throw new Error('Unrelated turn body read');
        return mapToJSON.call(this);
      });
      try {
        expect(writer.respondPermission('request', { outcome: 'cancelled' })).toBe(true);
        expect(writer.read('target')?.items?.[0]).toMatchObject({
          permissionRequest: { outcome: { outcome: 'cancelled' } },
        });
        expect(writer.read('older')?.items?.[0]).not.toHaveProperty('permissionRequest.outcome');
        expect(
          writer.respondPermission(
            'request',
            { outcome: 'selected', optionId: 'allow' },
            { turnId: 'older' }
          )
        ).toBe(true);
        expect(writer.read('older')?.items?.[0]).toMatchObject({
          permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } },
        });
        const version = doc.version().toJSON();
        expect(writer.respondPermission('missing', { outcome: 'cancelled' })).toBe(false);
        expect(
          writer.respondPermission('request', { outcome: 'cancelled' }, { turnId: 'missing' })
        ).toBe(false);
        expect(
          writer.respondPermission('request', { outcome: 'cancelled' }, { turnId: 'unrelated' })
        ).toBe(false);
        expect(() =>
          writer.respondPermission('request', { outcome: 'invalid' } as never)
        ).toThrow();
        expect(doc.version().toJSON()).toEqual(version);
      } finally {
        listGuard.mockRestore();
        mapGuard.mockRestore();
      }
      expect(unrelated.toJSON()).toEqual(before);
    }
  );

  it('filters nested config extensions on append and resend without rewriting stored input', () => {
    const doc = new Loro();
    const stored = {
      ...entry('old'),
      inputConfig: {
        cliType: 'claude',
        inputBlocks: [{ type: 'text', text: 'hello', futureKey: true }],
        issuePRMentions: [
          {
            type: 'issue',
            title: 'Synthetic',
            url: 'https://example.com/1',
            number: 1,
            futureKey: true,
          },
        ],
      },
    };
    const row = doc.getList('history').pushContainer(new LoroMap());
    for (const [key, value] of Object.entries(stored)) row.set(key, value);
    doc.commit();
    const mirror = open(doc);
    try {
      const expectedConfig = {
        cliType: 'builtin',
        agentType: 'claude',
        inputBlocks: [{ type: 'text', text: 'hello' }],
        issuePRMentions: [
          { type: 'issue', title: 'Synthetic', url: 'https://example.com/1', number: 1 },
        ],
      };
      mirror.historyWriter.append({ ...stored, id: 'appended' } as unknown as SessionHistory);
      expect(doc.getList('history').toJSON()[1].inputConfig).toEqual(expectedConfig);
      expect(row.toJSON()).toEqual(stored);
      // A fresh resend authors a new turn from the old turn's configuration.
      const rollback = mirror.historyWriter.updateWithRollback((history) => [
        ...history,
        { ...history[0]!, id: 'resent' },
      ]);
      expect(doc.getList('history').toJSON()[2].inputConfig).toEqual(expectedConfig);
      expect(row.toJSON()).toEqual(stored);
      rollback();
      const version = doc.version().toJSON();
      expect(() =>
        mirror.historyWriter.append({
          ...stored,
          id: 'invalid',
          inputConfig: {
            ...stored.inputConfig,
            inputBlocks: [{ type: 'text', text: 42, futureKey: true }],
          },
        } as unknown as SessionHistory)
      ).toThrow();
      expect(doc.version().toJSON()).toEqual(version);
      expect(row.toJSON()).toEqual(stored);
    } finally {
      mirror.dispose();
    }
  });

  it.each(['claude', 'codex'])('normalizes legacy %s config only on new writes', (cliType) => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      inputConfig: { cliType },
    } as unknown as SessionHistory);
    expect(doc.getList('history').toJSON()[0].inputConfig).toEqual({
      cliType: 'builtin',
      agentType: cliType,
    });
    expect(() =>
      mirror.historyWriter.append({
        ...entry('invalid'),
        inputConfig: { cliType: 'invalid' },
      } as unknown as SessionHistory)
    ).toThrow();
    mirror.dispose();
  });

  it('edits independent fields without reparsing damaged stored config, tool or proposal fields', () => {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    const stored = {
      ...entry(),
      inputConfig: { modeId: null, agentRoleId: '', future: true },
      items: [
        { type: 'tool_call', toolCallId: 'tool', status: 'in_progress', kind: 'future-kind' },
        {
          type: 'system_notice',
          name: 'task_proposal',
          meta: { proposalId: 'proposal', title: 42, future: true },
        },
      ],
    };
    for (const [key, value] of Object.entries(stored)) row.set(key, value);
    doc.commit();
    const mirror = open(doc);
    mirror.historyWriter.updateEntry('turn', (turn) => {
      turn.inputConfig!._lodyDeliveryKind = 'steer';
      const tool = turn.items![0]!;
      if (tool.type === 'tool_call') {
        tool.status = 'completed';
        tool.rawOutput = { ok: true };
      }
      const proposal = turn.items![1]!;
      if (proposal.type === 'system_notice' && proposal.name === 'task_proposal')
        proposal.meta!.outcome = 'dismissed';
    });
    expect(doc.getList('history').toJSON()[0]).toMatchObject({
      inputConfig: { ...stored.inputConfig, _lodyDeliveryKind: 'steer' },
      items: [
        { ...stored.items[0], status: 'completed', rawOutput: { ok: true } },
        { ...stored.items[1], meta: { ...stored.items[1]!.meta, outcome: 'dismissed' } },
      ],
    });
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.updateEntry('turn', (turn) => {
        const tool = turn.items![0]!;
        if (tool.type === 'tool_call') tool.rawOutput = 42 as never;
      })
    ).toThrow();
    expect(doc.version().toJSON()).toEqual(version);
    mirror.dispose();
  });

  it('derives an input parser without mutating strict schemas or dropping refinements', () => {
    const schema = z
      .object({ nested: z.object({ count: z.number() }).strict() })
      .strict()
      .superRefine((value, ctx) => {
        if (value.nested.count < 0) ctx.addIssue({ code: 'custom', message: 'negative' });
      });
    const input = { nested: { count: 2, future: true, $cid: 'transport' }, extra: true };
    expect(parseHistoryWrite(schema, input)).toEqual({ nested: { count: 2 } });
    expect(schema.safeParse(input).success).toBe(false);
    expect(() => parseHistoryWrite(schema, { nested: { count: -1, extra: true } })).toThrow(
      'custom'
    );
    expect(input.nested.$cid).toBe('transport');
    const pipeline = z
      .preprocess((value) => ({ nested: value }), schema)
      .transform((value) => ({ count: value.nested.count + 1 }));
    expect(parseHistoryWrite(pipeline, { count: 2, future: true })).toEqual({ count: 3 });
    expect(pipeline.safeParse({ count: 2, future: true }).success).toBe(false);
    expect(() => parseHistoryWrite(pipeline, { count: -1, future: true })).toThrow('custom');
  });

  it('updates a target after peer insert/delete without touching other turns', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('prefix'));
    mirror.historyWriter.append(entry('target'));
    const peer = new Loro();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerMirror = open(peer);
    const oldPrefix = doc.getList('history').get(0) as LoroMap;
    expect(
      mirror.historyWriter.updateEntry('target', (turn) => {
        turn.items = [{ type: 'text', text: 'first' }];
        return turn;
      })
    ).toBe(true);
    peerMirror.historyWriter.update((history) => [entry('inserted'), ...history]);
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    mirror.historyWriter.updateEntry('target', (turn) => {
      turn.items = [{ type: 'text', text: 'second' }];
      return turn;
    });
    expect(oldPrefix.toJSON().items).toEqual(entry().items);
    expect(mirror.historyWriter.read('inserted')?.items).toEqual(entry().items);
    expect(mirror.historyWriter.read('target')?.items).toEqual([{ type: 'text', text: 'second' }]);
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.updateEntry('target', (turn) => ({ ...turn, id: 'other' }))
    ).toThrow('immutable_id');
    expect(() =>
      mirror.historyWriter.updateEntry('target', (turn) => ({ ...turn, finished: 'bad' as never }))
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    peer.import(doc.export({ mode: 'update', from: peer.version() }));
    peerMirror.historyWriter.update((history) => history.filter((turn) => turn.id !== 'target'));
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    expect(mirror.historyWriter.updateEntry('target', (turn) => turn)).toBe(false);
    expect(doc.getList('history').toJSON()).toEqual(peer.getList('history').toJSON());
    mirror.dispose();
    peerMirror.dispose();
  });

  it('updates concurrently inserted copies of one turn together or not at all', () => {
    const doc = new Loro();
    doc.setPeerId('1');
    const mirror = open(doc);
    const peer = new Loro();
    peer.setPeerId('2');
    const peerMirror = open(peer);
    mirror.historyWriter.append({ ...entry('twin'), status: 'pending' });
    peerMirror.historyWriter.append({ ...entry('twin'), status: 'pending_apply' });
    mirror.historyWriter.append(entry('other'));
    doc.import(peer.export({ mode: 'update' }));
    const statuses = () =>
      (doc.getList('history').toJSON() as SessionHistory[]).map((turn) => [turn.id, turn.status]);
    expect(statuses().filter(([turnId]) => turnId === 'twin')).toHaveLength(2);

    expect(
      mirror.historyWriter.updateCopies('twin', (copies) => {
        for (const copy of copies) copy.status = 'processing';
      })
    ).toBe(true);
    expect(statuses()).toEqual(
      expect.arrayContaining([
        ['twin', 'processing'],
        ['other', undefined],
      ])
    );
    expect(statuses().filter(([, status]) => status === 'processing')).toHaveLength(2);

    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.updateCopies('twin', (copies) => {
        copies[0]!.status = 'handled';
        copies[1]!.finished = 'bad' as never;
      })
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    expect(() =>
      mirror.historyWriter.updateCopies('twin', (copies) => {
        copies[1]!.id = 'renamed';
      })
    ).toThrow('immutable_id');
    expect(doc.version().toJSON()).toEqual(version);
    expect(mirror.historyWriter.updateCopies('missing', () => {})).toBe(false);
    mirror.dispose();
    peerMirror.dispose();
  });

  it('updates only the requested field beside opaque history and preserves nested extensions', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const turn = doc.getList('history').pushContainer(new LoroMap());
    turn.set('id', 'field-target');
    turn.set('role', 'assistant');
    turn.set('items', [{ type: 'future', payload: { text: 42 } }]);
    turn.set('fileDiff', [{ filePath: 'a.ts', add: 1, del: 0, future: 'keep' }]);
    doc.commit();
    const items = turn.get('items');
    mirror.historyWriter.setField('field-target', 'fileDiff', [
      { filePath: 'a.ts', add: 2, del: 0 },
    ]);
    expect(turn.toJSON().fileDiff).toEqual([{ filePath: 'a.ts', add: 2, del: 0, future: 'keep' }]);
    mirror.historyWriter.setField('field-target', 'finished', true);
    mirror.historyWriter.setField('field-target', 'finished', undefined);
    expect(turn.get('items')).toEqual(items);
    expect(turn.keys()).not.toContain('finished');
    const version = doc.version().toJSON();
    expect(() => mirror.historyWriter.setField('field-target', 'finished', 'bad' as never)).toThrow(
      'Invalid history write'
    );
    expect(() =>
      mirror.historyWriter.setField('field-target', 'items' as never, [] as never)
    ).toThrow('invalid_field');
    expect(doc.version().toJSON()).toEqual(version);
    const detached = mirror.historyWriter.readStored();
    detached[0]!.items = [];
    expect(turn.get('items')).toEqual(items);
    mirror.dispose();
  });

  it.each(['before-rollback', 'after-rollback'] as const)(
    'preserves a peer prefix edit arriving %s',
    (arrival) => {
      const doc = new Loro();
      const mirror = open(doc);
      for (const name of ['prefix', 'old', 'answer']) mirror.historyWriter.append(entry(name));
      const before = doc.getList('history').toJSON();
      const prefixCid = (doc.getList('history').get(0) as LoroMap).id;
      const peer = new Loro();
      peer.import(doc.export({ mode: 'snapshot' }));
      const peerMirror = open(peer);
      const rollback = mirror.historyWriter.updateWithRollback((history) => [
        history[0]!,
        entry('replacement'),
      ]);
      peerMirror.historyWriter.update((history) => {
        history[0]!.items = [{ type: 'text', text: 'peer edit' }];
        return history;
      });
      if (arrival === 'before-rollback')
        doc.import(peer.export({ mode: 'update', from: doc.version() }));
      rollback();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      peer.import(doc.export({ mode: 'update', from: peer.version() }));
      const expected = [
        { ...before[0], items: [{ type: 'text', text: 'peer edit' }] },
        ...before.slice(1),
      ];
      expect(doc.getList('history').toJSON()).toEqual(expected);
      expect(peer.getList('history').toJSON()).toEqual(expected);
      expect((doc.getList('history').get(0) as LoroMap).id).toBe(prefixCid);
      expect(() => rollback()).toThrow('stale_rollback');
      mirror.dispose();
      peerMirror.dispose();
    }
  );

  it('refuses edits to the replacement without partially restoring the tail', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('old'));
    const rollback = mirror.historyWriter.updateWithRollback(() => [entry('replacement')]);
    mirror.historyWriter.update((history) => {
      history[0]!.items = [{ type: 'text', text: 'new work' }];
      return history;
    });
    const version = doc.version().toJSON();
    expect(() => rollback()).toThrow('stale_rollback');
    expect(doc.version().toJSON()).toEqual(version);
    expect(mirror.historyWriter.read('replacement')?.items).toEqual([
      { type: 'text', text: 'new work' },
    ]);
    mirror.dispose();
  });

  it('appends beside damaged old tool blocks and keeps extensions on their own variants', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const map = doc.getList('history').pushContainer(new LoroMap());
    for (const [key, value] of Object.entries({
      ...entry(),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'legacy',
          status: 'in_progress',
          content: [
            { type: 'text', text: 42 },
            { type: 'text', text: 'old', providerExtra: 1 },
          ],
        },
      ],
    }))
      map.set(key, value);
    doc.commit();
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call') tool.content!.push({ type: 'text', text: 'new' } as never);
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[0]).toEqual({
      type: 'text',
      text: 42,
    });
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call')
        tool.content![1] = { type: 'text', text: 'edited', providerExtra: 2 } as never;
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[1].providerExtra).toBe(2);
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call')
        tool.content![1] = { type: 'diff', path: 'synthetic.ts', newText: 'new' };
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[1]).toEqual({
      type: 'diff',
      path: 'synthetic.ts',
      newText: 'new',
    });
    mirror.dispose();
  });

  it('retains JSON protocol extensions without admitting malformed known tool blocks', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const tool = {
      type: 'tool_call',
      toolCallId: 'extension-tool',
      status: 'in_progress',
      _meta: { provider: { revision: 1 } },
      locations: [{ path: 'synthetic.ts', endColumn: 12, futureLocation: true }],
      content: [{ type: 'future_block', payload: { revision: 1 } }],
    };
    mirror.historyWriter.append({
      ...entry(),
      role: 'assistant',
      items: [tool],
    } as unknown as SessionHistory);
    mirror.historyWriter.update((history) => {
      const item = history[0]!.items![0]!;
      if (item.type === 'tool_call')
        item.content!.push({ type: 'content', content: { type: 'text', text: 'later' } });
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0]).toMatchObject({
      ...tool,
      content: [tool.content[0], { type: 'content', content: { type: 'text', text: 'later' } }],
    });
    expect(doc.getList('history').toJSON()[0].items[0].content).toHaveLength(2);
    const before = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.append({
        ...entry('bad'),
        items: [{ ...tool, content: [{ type: 'text', text: 42 }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(() =>
      mirror.historyWriter.append({
        ...entry('bad-json'),
        items: [{ ...tool, content: [{ type: 'future_block', payload: () => {} }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(before);
    mirror.dispose();
  });

  it('copies opaque stored content without blessing new malformed input or changing the source', () => {
    const source = new Loro();
    const sourceMirror = open(source);
    const map = source.getList('history').insertContainer(0, new LoroMap());
    const stored = {
      ...entry(),
      futureTurn: { version: 3 },
      items: [
        { type: 'future_item', text: 42, payload: { nested: [null, 'opaque'] } },
        { type: 'text', text: 42, futureField: 'keep' },
        { type: 'text', text: 'valid', futureMetadata: { revision: 3 } },
      ],
    };
    for (const [key, value] of Object.entries(stored)) map.set(key, value);
    source.commit();
    const snapshot = sourceMirror.historyWriter.capture();
    const sourceVersion = source.version().toJSON();
    // A consumer cannot mutate the private baseline, even through its returned view.
    snapshot.history[0]!.items = [{ type: 'text', text: 'tampered' }];
    const target = new Loro();
    const targetMirror = open(target);
    const version = target.version().toJSON();
    expect(() =>
      targetMirror.historyWriter.copyFrom(
        { history: snapshot.history } as StoredHistorySnapshot,
        snapshot.history
      )
    ).toThrow('invalid_snapshot');
    const malformed = {
      ...entry('new'),
      items: [{ type: 'text', text: 42 }],
    } as unknown as SessionHistory;
    expect(() =>
      targetMirror.historyWriter.copyFrom(snapshot, [...snapshot.history, malformed])
    ).toThrow('Invalid history write');
    expect(() =>
      targetMirror.historyWriter.copyFrom(snapshot, [
        { ...snapshot.history[0]!, finished: 'bad' } as unknown as SessionHistory,
      ])
    ).toThrow('Invalid history write');
    expect(target.version().toJSON()).toEqual(version);
    targetMirror.historyWriter.copyFrom(snapshot, [
      { ...snapshot.history[0]!, read: true },
      entry('new'),
    ]);
    expect(target.getList('history').toJSON()[0]).toEqual({ ...stored, read: true });
    expect(source.getList('history').toJSON()).toEqual([stored]);
    expect(source.version().toJSON()).toEqual(sourceVersion);
    expect(() => targetMirror.historyWriter.copyFrom(snapshot, snapshot.history)).toThrow(
      'copy_target_conflict'
    );
    const reopened = new Loro();
    reopened.import(target.export({ mode: 'snapshot' }));
    expect(reopened.getList('history').toJSON()).toEqual(target.getList('history').toJSON());
    targetMirror.historyWriter.replace('new', {
      ...entry('new'),
      items: [{ type: 'text', text: 'streamed' }],
    });
    expect(target.getList('history').toJSON()[0]).toEqual({ ...stored, read: true });
    sourceMirror.dispose();
    targetMirror.dispose();
  });

  it('updates tool permission and status without reparsing untouched opaque content', () => {
    const peer = new Loro();
    const row = peer.getList('history').pushContainer(new LoroMap());
    const tool = {
      type: 'tool_call',
      toolCallId: 'tool',
      status: 'pending',
      content: [{ type: 'future_tool_content', data: { value: 42 } }],
      permissionRequest: {
        requestId: 'request',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    };
    for (const [key, value] of Object.entries({ ...entry(), role: 'assistant', items: [tool] }))
      row.set(key, value);
    peer.commit();
    const doc = new Loro();
    doc.import(peer.export({ mode: 'snapshot' }));
    const mirror = open(doc);
    expect(
      mirror.historyWriter.respondPermission('request', { outcome: 'selected', optionId: 'allow' })
    ).toBe(true);
    mirror.historyWriter.update((history) => {
      const item = history[0]!.items![0]!;
      if (item.type === 'tool_call') item.status = 'completed';
      return history;
    });
    const stored = doc.getList('history').toJSON()[0].items[0];
    expect(stored.content).toEqual(tool.content);
    expect(stored.status).toBe('completed');
    expect(stored.permissionRequest.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...mirror.historyWriter.read('turn')!,
        items: [{ ...stored, status: 42 }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...mirror.historyWriter.read('turn')!,
        items: [{ ...stored, content: [{ type: 'text', text: 42 }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    peer.import(doc.export({ mode: 'update', from: peer.version() }));
    expect(peer.getList('history').toJSON()).toEqual(doc.getList('history').toJSON());
    mirror.dispose();
  });

  it('restores deleted opaque history with a one-use receipt, refusing intervening peer edits', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('prefix'));
    const old = doc.getList('history').insertContainer(1, new LoroMap());
    for (const [key, value] of Object.entries({
      ...entry('old'),
      items: [{ type: 'future_item', value: 42 }],
    }))
      old.set(key, value);
    doc.commit();
    const before = doc.getList('history').toJSON();
    const prefixId = (doc.getList('history').get(0) as LoroMap).id;
    const rollback = mirror.historyWriter.updateWithRollback((history) => [
      history[0]!,
      entry('replacement'),
    ]);
    rollback();
    expect(doc.getList('history').toJSON()).toEqual(before);
    expect((doc.getList('history').get(0) as LoroMap).id).toBe(prefixId);
    expect(() => rollback()).toThrow('stale_rollback');
    const stale = mirror.historyWriter.updateWithRollback((history) => [
      history[0]!,
      entry('replacement'),
    ]);
    const peer = new Loro();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerMirror = open(peer);
    peerMirror.historyWriter.append(entry('peer'));
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    stale();
    expect(doc.getList('history').toJSON()).toEqual([...before, entry('peer')]);
    mirror.dispose();
    peerMirror.dispose();
  });

  it('checks fork-origin metadata before any write and preserves it on round trip', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const notice = {
      type: 'system_notice' as const,
      name: 'session_fork_origin' as const,
      meta: {
        sourceSessionId: 'source' as SessionId,
        sourceTurnId: 'turn',
        sourceTitle: 'Synthetic',
      },
    };
    const version = doc.version().toJSON();
    for (const meta of [
      { sourceSessionId: 'source' },
      { ...notice.meta, sourceTitle: 42 },
      { message: 'wrong notice metadata' },
    ]) {
      expect(() =>
        mirror.historyWriter.append({
          ...entry(),
          items: [{ ...notice, meta }],
        } as unknown as SessionHistory)
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
    }
    mirror.historyWriter.append({ ...entry(), role: 'system', items: [notice] });
    expect(doc.getList('history').toJSON()[0].items).toEqual([notice]);
    mirror.dispose();
  });

  it('keeps legacy primitive text primitive and retains it on an invalid item update', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry());
    const item = ((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    item.set('text', 'legacy');
    doc.commit();
    mirror.historyWriter.replace('turn', {
      ...entry(),
      items: [{ type: 'text', text: 'streamed' }],
    });
    expect(item.get('text')).toBe('streamed');
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...entry(),
        items: [{ type: 'text', text: 42 }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    expect(item.get('text')).toBe('streamed');
    mirror.dispose();
  });

  it('accepts strict image objects read through Mirror and JSON list shape changes', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      items: [
        { type: 'image', imageId: 'image', mimeType: 'image/png', sizeBytes: 1 },
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          rawInput: { values: [{ before: true }] },
        },
      ],
    });
    const imageMap = ((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    imageMap.set('futureImageField', 7);
    doc.commit();
    mirror.setState((s) => {
      const image = s.history[0]!.items![0];
      if (image?.type === 'image') image.sizeBytes = 2;
      const tool = s.history[0]!.items![1];
      if (tool?.type === 'tool_call') tool.rawInput = { values: ['after'] };
    });
    expect(doc.toJSON().history[0].items[0].sizeBytes).toBe(2);
    expect(doc.toJSON().history[0].items[0].futureImageField).toBe(7);
    expect(doc.toJSON().history[0].items[1].rawInput.values).toEqual(['after']);
    mirror.dispose();
  });

  it('preserves a shifted opaque item and the following edited item containers', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      items: [
        { type: 'text', text: 'delete' },
        { type: 'text', text: 'opaque' },
        { type: 'text', text: 'tail' },
      ],
    });
    const items = (doc.getList('history').get(0) as LoroMap).get('items') as LoroList;
    const opaque = items.get(1) as LoroMap;
    opaque.set('type', 'future_item');
    opaque.set('future', 11);
    const tail = items.get(2) as LoroMap;
    tail.set('futureTail', 22);
    doc.commit();
    const body = tail.get('text') as LoroText;
    mirror.setState((s) => {
      s.history[0]!.items!.splice(0, 1);
      s.history[0]!.items![1] = { type: 'text', text: 'changed' };
    });
    expect((items.get(0) as LoroMap).id).toBe(opaque.id);
    expect((items.get(1) as LoroMap).id).toBe(tail.id);
    expect(tail.toJSON()).toMatchObject({ text: 'changed', futureTail: 22 });
    expect(doc.getContainerById(body.id)?.toJSON()).toBe('changed');
    mirror.dispose();
  });

  it('preflights a complete batch and does not publish control fields on invalid history', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const version = doc.version().toJSON();
    expect(() =>
      mirror.setState((state) => {
        state.externalHistoryCursor = { importedTurnHashes: ['must-not-land'] };
        state.history.push(entry('good'));
        state.history.push({
          ...entry('bad'),
          items: [{ type: 'text' }],
        } as unknown as SessionHistory);
      })
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    expect(doc.toJSON().externalHistoryCursor.importedTurnHashes).toBeUndefined();
    mirror.historyWriter.append(entry('after-failure'));
    expect(doc.toJSON().history).toHaveLength(1);
    mirror.dispose();
  });

  it('rejects non-JSON payloads and malformed completion before attaching containers', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const version = doc.version().toJSON();
    for (const item of [
      {
        type: 'tool_call',
        toolCallId: 'tool',
        status: 'pending',
        rawInput: { callback: () => {} },
      },
      {
        type: 'operation_completion',
        deliveryId: 'delivery',
        operationId: 'operation',
        operationKind: 'session_chat',
        completion: { type: 'result' },
      },
    ]) {
      expect(() =>
        mirror.historyWriter.append({ ...entry(), items: [item] } as unknown as SessionHistory)
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
    }
    mirror.dispose();
  });

  it('keeps normal ACP permission and location fields and updates an outcome locally', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const turn: SessionHistory = {
      ...entry(),
      role: 'assistant',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          locations: [{ path: 'synthetic.ts', line: 3 }],
          permissionRequest: {
            requestId: 'request',
            options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_always' }],
          },
        },
      ],
    };
    mirror.historyWriter.append(turn);
    const map = (doc.getList('history').get(0) as LoroMap).get('items') as LoroList;
    const itemId = (map.get(0) as LoroMap).id;
    expect(
      mirror.historyWriter.respondPermission('request', { outcome: 'selected', optionId: 'reject' })
    ).toBe(true);
    expect((map.get(0) as LoroMap).id).toBe(itemId);
    expect(doc.toJSON().history[0].items[0]).toMatchObject({
      locations: [{ path: 'synthetic.ts', line: 3 }],
      permissionRequest: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
    mirror.dispose();
  });
  it.each(['writer', 'callback'] as const)(
    'rejects malformed new items through %s before changing the doc',
    (path) => {
      const doc = new Loro();
      const mirror = open(doc);
      const version = doc.version().toJSON();
      const bad = { ...entry(), items: [{ type: 'text' }] } as unknown as SessionHistory;
      expect(() =>
        path === 'writer'
          ? mirror.historyWriter.append(bad)
          : mirror.setState((s) => {
              s.history.push(bad);
            })
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
      expect(doc.getList('history').length).toBe(0);
      mirror.dispose();
    }
  );

  it('filters unknown new fields without allowing unknown new item types', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const withExtras = {
      ...entry(),
      surprise: 'drop',
      items: [{ type: 'text', text: 'hello', mail: 'synthetic@example.invalid' }],
    } as SessionHistory;
    mirror.historyWriter.append(withExtras);
    expect(doc.toJSON().history[0]).toEqual(entry());
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.append({
        ...entry('future'),
        items: [{ type: 'future_item' }],
      } as unknown as SessionHistory)
    ).toThrow();
    expect(doc.version().toJSON()).toEqual(version);
    mirror.dispose();
  });

  it.each(['live import', 'snapshot reopen'] as const)(
    'keeps opaque and malformed history while appending, streaming and merging after %s',
    (mode) => {
      const peer = new Loro();
      peer.setPeerId('100');
      open(peer).dispose();
      const row = peer.getList('history').pushContainer(new LoroMap());
      row.set('id', 'old');
      row.set('role', 'assistant');
      row.set('timestamp', 'old');
      row.set('futureTurnField', 10);
      const items = row.setContainer('items', new LoroList());
      const future = items.pushContainer(new LoroMap());
      future.set('type', 'future_item');
      future.set('text', 42);
      const field = future.setContainer('payload', new LoroText());
      field.insert(0, 'before');
      const bad = items.pushContainer(new LoroMap());
      bad.set('type', 'text');
      const text = items.pushContainer(new LoroMap());
      text.set('type', 'text');
      const body = text.setContainer('text', new LoroText());
      body.insert(0, 'hello');
      text.set('futureItemField', 20);
      peer.commit();
      const doc = new Loro();
      doc.setPeerId('200');
      if (mode === 'snapshot reopen') doc.import(peer.export({ mode: 'snapshot' }));
      const before = doc.version().toJSON();
      const mirror = open(doc);
      if (mode === 'snapshot reopen') expect(doc.version().toJSON()).toEqual(before);
      else doc.import(peer.export({ mode: 'snapshot' }));
      const old = doc.toJSON().history[0];
      mirror.historyWriter.append(entry());
      expect(doc.toJSON().history[0]).toEqual(old);
      mirror.setState((s) => {
        s.history[0]!.items![2] = { type: 'text', text: 'streamed' };
      });
      expect(doc.getContainerById(body.id)?.toJSON()).toBe('streamed');
      expect(doc.toJSON().history[0].items[2].futureItemField).toBe(20);
      const version = doc.version().toJSON();
      expect(() =>
        mirror.historyWriter.setField('old', 'finished', 'bad' as unknown as boolean)
      ).toThrow();
      expect(doc.version().toJSON()).toEqual(version);
      mirror.historyWriter.setField('old', 'finished', true);
      field.update('concurrent');
      peer.commit();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      peer.import(doc.export({ mode: 'update', from: peer.version() }));
      expect(doc.toJSON()).toEqual(peer.toJSON());
      expect(doc.getContainerById(future.id)?.toJSON()).toEqual({
        type: 'future_item',
        text: 42,
        payload: 'concurrent',
      });
      expect(doc.toJSON().history[0].items[1]).toEqual({ type: 'text' });
      mirror.dispose();
    }
  );

  it('retains turn and text container ids across scalar updates and list insertion/removal', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('a'));
    mirror.historyWriter.append(entry('b'));
    const row = doc.getList('history').get(1) as LoroMap;
    const item = (row.get('items') as LoroList).get(0) as LoroMap;
    const body = item.get('text') as LoroText;
    mirror.historyWriter.update((history) => [entry('prefix'), ...history.slice(1)]);
    expect((doc.getList('history').get(1) as LoroMap).id).toBe(row.id);
    mirror.historyWriter.setField('b', 'finished', true);
    expect(doc.getContainerById(body.id)?.toJSON()).toBe('hello');
    expect(doc.toJSON().history.map((r: { id: string }) => r.id)).toEqual(['prefix', 'b']);
    mirror.dispose();
  });

  it('rewrites a large text to unrelated content as one splice and converges with a peer', () => {
    const doc = new Loro();
    doc.setPeerId('1');
    const mirror = open(doc);
    const body = (tag: string) =>
      Array.from({ length: 300 }, (_, i) => `${tag} paragraph ${i}\n`).join('');
    const turn = (text: string): SessionHistory => ({
      id: 'turn',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text }],
      fileDiff: [],
    });
    mirror.historyWriter.append(turn(`head\n${body('A')}tail`));
    const peer = new Loro();
    peer.setPeerId('2');
    peer.import(doc.export({ mode: 'snapshot' }));
    const before = doc.version();
    mirror.historyWriter.update(() => [turn(`head\n${body('B')}tail`)]);
    expect(doc.toJSON().history[0].items[0].text).toBe(`head\n${body('B')}tail`);
    const ops = doc
      .exportJsonUpdates(before, doc.version())
      .changes.flatMap((change) => change.ops)
      .map((op) => op.content as { type: string; pos: number });
    // Unbounded Myers (`LoroText.update`) blocks for minutes on ~100k-char
    // rewrites and emits an op per differing run; the splice keeps the common
    // prefix/suffix and replaces only the middle.
    expect(ops).toEqual([
      expect.objectContaining({ type: 'delete', pos: 5 }),
      expect.objectContaining({ type: 'insert', pos: 5 }),
    ]);
    peer.import(doc.export({ mode: 'update', from: peer.version() }));
    expect(peer.toJSON()).toEqual(doc.toJSON());
    mirror.dispose();
  });

  it('keeps surrogate pairs intact when the edit boundary falls inside one', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const turn = (text: string): SessionHistory => ({
      id: 'turn',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text }],
      fileDiff: [],
    });
    // 😀 (D83D DE00) and 😁 (D83D DE01) share their high surrogate, so the
    // common prefix ends inside a pair; 😂 (D83D DE02) before 😁 makes the
    // common suffix start inside one. Loro rejects either split.
    const steps = ['a😀b', 'a😁b', 'x😁', 'x😂😁', '😂', ''];
    mirror.historyWriter.append(turn(steps[0]!));
    for (const text of steps.slice(1)) {
      mirror.historyWriter.update(() => [turn(text)]);
      expect(doc.toJSON().history[0].items[0].text).toBe(text);
    }
    mirror.dispose();
  });

  it('uses the same new storage shape as Mirror before #443', () => {
    const oldDoc = new Loro();
    const newDoc = new Loro();
    oldDoc.setPeerId('1');
    newDoc.setPeerId('1');
    const old = new Mirror({
      doc: oldDoc,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
      initialState: { session: { id }, history: [] },
    });
    const current = open(newDoc);
    old.setState((s) => {
      s.history.push(entry());
    });
    current.historyWriter.append(entry());
    expect(newDoc.toJSON()).toEqual(oldDoc.toJSON());
    expect(newDoc.getList('history').toJSON()).toEqual(oldDoc.getList('history').toJSON());
    const ops = (doc: Loro) =>
      JSON.parse(
        JSON.stringify(doc.exportJsonUpdates(), (key, value) =>
          key === 'timestamp' ? undefined : value
        )
      );
    expect(ops(newDoc)).toEqual(ops(oldDoc));
    expect((newDoc.getList('history').get(0) as LoroMap).get('items')).toBeInstanceOf(LoroList);
    expect(
      ((newDoc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(0)
    ).toBeInstanceOf(LoroMap);
    old.dispose();
    current.dispose();
  });
});
