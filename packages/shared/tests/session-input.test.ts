import { encodeSessionFilePath } from '../src/project-path';
import { describe, expect, it } from 'vitest';

import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  historyItemsToInputBlocks,
  inputBlocksToHistoryItems,
  resolveSessionAuthoredText,
  resolveSessionExecutionInputBlocks,
  resolveSessionAcpRuntimeConfig,
  resolveSessionConversationConfig,
} from '../src/session-input';
import { normalizeSessionTurnInputConfig, SessionFileBlockSchema } from '../src/message-schemas';
import { turnExecutionDigest } from '../src/e2ee-execution-intent';
import { buildInitialHistoryEntry, buildInitialSessionMetaPatch } from '../src/session-bootstrap';
import { sessionDocSchema } from '../src/session-doc-schemas';
import type { SessionDoc, SessionHistoryInput } from '../src/schema';
import type {
  CommentReferencePayload,
  MachineId,
  SessionFilePayload,
  SessionId,
  SessionInputBlock,
  VisualAnnotationReferencePayload,
} from '../src/ai';
import type { AgentRoleId, McpServerId } from '../src/ids';

const commentReference: CommentReferencePayload = {
  source: 'lody',
  path: 'packages/shared/src/schema.ts',
  lineNumber: 42,
  side: 'additions',
  commentBody: 'Please handle this comment.',
  authorName: 'Leon',
};

const visualAnnotationReference: VisualAnnotationReferencePayload = {
  source: 'visual_annotation',
  commentId: 'visual-comment-1',
  turnId: 'turn-1',
  body: 'Move this heading closer to the eyebrow.',
  authorName: 'Ada',
  status: 'submitted',
  anchor: {
    version: 1,
    page: {
      url: '/preview',
      pathname: '/preview',
      viewport: {
        width: 960,
        height: 620,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 2,
      },
    },
    click: {
      clientX: 120,
      clientY: 140,
      pageX: 120,
      pageY: 140,
      viewportXRatio: 0.125,
      viewportYRatio: 0.2258064516,
    },
    target: {
      tag: 'h1',
      attributes: { 'data-testid': 'hero-title' },
      text: 'Design reviews should point at pixels.',
      rect: {
        x: 100,
        y: 120,
        width: 480,
        height: 96,
      },
      rectRatio: {
        x: 0.1041666667,
        y: 0.1935483871,
        width: 0.5,
        height: 0.1548387097,
      },
      selector: 'h1[data-testid="hero-title"]',
      xpath: '/html/body/main/h1',
    },
    context: {
      ancestors: [{ tag: 'main', selector: 'main' }],
      nearbyText: ['Preview fixture', 'Design reviews should point at pixels.'],
    },
  },
};

// transport='r2': bytes already in the relay store; no machineId.
const r2FilePayload: SessionFilePayload = {
  type: 'file',
  fileId: 'file-r2-1',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 4096,
  sha256: 'a'.repeat(64),
  textPreview: false,
  sourcePath: 'artifacts/report.pdf',
  transport: 'r2',
  uploadedAt: 1_700_000_000_000,
};

// transport='local': desktop fast path; machineId is required so other devices
// can render the "uploading from <machine>" pending state.
const localFilePayload: SessionFilePayload = {
  type: 'file',
  fileId: 'file-local-1',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 256,
  sha256: 'b'.repeat(64),
  textPreview: true,
  transport: 'local',
  machineId: 'machine-1',
  uploadedAt: 1_700_000_100_000,
};

describe('session-input helpers', () => {
  it('executes frozen instructions once while preserving every structured attachment', () => {
    const attachments: SessionInputBlock[] = [
      { type: 'image', imageId: 'image-1', mimeType: 'image/png', sizeBytes: 128 },
      r2FilePayload,
      { type: 'comment_reference', ...commentReference },
      { type: 'visual_annotation_reference', ...visualAnnotationReference },
    ];
    const raw: SessionInputBlock[] = [
      {
        type: 'text',
        text: 'Review @src/a.ts',
        spans: [{ start: 7, end: 16, kind: 'file', label: '@src/a.ts', target: 'src/a.ts' }],
      },
      ...attachments,
    ];
    const config = buildSessionTurnInputConfig({
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: raw,
      prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nReview @src/a.ts',
    });
    const expected = [...attachments, { type: 'text', text: config.prompt }];
    expect(resolveSessionExecutionInputBlocks(config)).toEqual(expected);
    expect(resolveSessionExecutionInputBlocks({ ...config, inputBlocks: expected })).toEqual(
      expected
    );
    expect(config.inputBlocks).toEqual(raw);
    expect(inputBlocksToHistoryItems(raw)[0]).toMatchObject(raw[0]);
  });

  it('resolves authored text without the composed Config/Role execution prompt', () => {
    const prompt = 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nReview @src/a.ts';
    expect(
      resolveSessionAuthoredText({
        prompt,
        inputBlocks: [{ type: 'text', text: '  Review @src/a.ts ' }, r2FilePayload],
      })
    ).toBe('Review @src/a.ts');
    expect(resolveSessionAuthoredText({ prompt, inputBlocks: [r2FilePayload] })).toBe('');
    expect(resolveSessionAuthoredText({ prompt: ' legacy task ' })).toBe('legacy task');
    expect(resolveSessionAuthoredText({})).toBe('');
  });

  it('distinguishes an absent legacy prompt from explicit empty execution text', () => {
    const inputBlocks: SessionInputBlock[] = [{ type: 'text', text: 'legacy task' }, r2FilePayload];
    expect(resolveSessionExecutionInputBlocks({ inputBlocks })).toEqual(inputBlocks);
    expect(resolveSessionExecutionInputBlocks({ inputBlocks, prompt: '' })).toEqual([
      r2FilePayload,
    ]);
    expect(resolveSessionExecutionInputBlocks({ prompt: 'only text' })).toEqual([
      { type: 'text', text: 'only text' },
    ]);
    expect(
      resolveSessionExecutionInputBlocks({ inputBlocks: [r2FilePayload], prompt: '' })
    ).toEqual([r2FilePayload]);
    expect(resolveSessionExecutionInputBlocks({ prompt: '' })).toEqual([]);
  });

  it('uses only the latest persisted user conversation config', () => {
    const history = [
      {
        id: 'turn-1',
        role: 'user' as const,
        inputConfig: {
          prompt: 'first',
          cliType: 'builtin' as const,
          agentType: 'codex',
          modeId: 'ask',
          modelId: 'model-a',
          configOptionValues: { approval: 'prompt', fast_mode: false },
        },
      },
      {
        id: 'turn-2',
        role: 'assistant' as const,
        inputConfig: {
          prompt: 'ignored',
          cliType: 'builtin' as const,
          agentType: 'codex',
          modeId: 'ignored',
        },
      },
      {
        id: 'turn-3',
        role: 'user' as const,
        inputConfig: {
          prompt: 'latest',
          cliType: 'builtin' as const,
          agentType: 'codex',
          modelId: 'model-b',
          configOptionValues: { approval: 'never' },
        },
      },
    ];

    expect(resolveSessionConversationConfig(history)).toEqual({
      sourceConfigKey: 'history:turn-3',
      modelId: 'model-b',
      configOptionValues: { approval: 'never' },
    });
  });

  it('inherits the latest explicit Role across legacy or non-composer Turns', () => {
    const history = [
      {
        id: 'turn-role',
        role: 'user',
        inputConfig: { agentRoleId: 'role-reviewer', agentRoleRevision: 7 },
      },
      {
        id: 'turn-programmatic',
        role: 'user',
        inputConfig: { prompt: 'continue automatically' },
      },
    ];
    expect(resolveSessionConversationConfig(history)).toMatchObject({
      sourceConfigKey: 'history:turn-programmatic',
      agentRoleId: 'role-reviewer',
      agentRoleRevision: 7,
    });

    expect(
      resolveSessionConversationConfig([
        ...history,
        { id: 'turn-none', role: 'user', inputConfig: { agentRoleId: null } },
      ])
    ).toMatchObject({
      sourceConfigKey: 'history:turn-none',
      agentRoleId: null,
    });
  });

  it('resolves ACP runtime config only for the latest accepted user turn', () => {
    const history = [
      { id: 'turn-1', role: 'user' as const },
      { id: 'assistant-1', role: 'assistant' as const },
      { id: 'turn-2', role: 'user' as const },
    ];

    expect(
      resolveSessionAcpRuntimeConfig(history, [], {
        acpSessionId: 'acp-2',
        basedOnUserTurnId: 'turn-2',
        revision: 3,
        modeId: 'default',
        modelId: 'gpt-5.6-sol',
        configOptionValues: { collaboration_mode: 'default', fast_mode: true },
      })
    ).toEqual({
      sourceConfigKey: 'runtime:acp-2:3',
      modeId: 'default',
      modelId: 'gpt-5.6-sol',
      configOptionValues: { collaboration_mode: 'default', fast_mode: true },
    });

    expect(
      resolveSessionAcpRuntimeConfig(history, [], {
        acpSessionId: 'acp-1',
        basedOnUserTurnId: 'turn-1',
        revision: 9,
        modeId: 'default',
      })
    ).toBeNull();
  });

  it('does not let runtime state override a frozen queued turn', () => {
    expect(
      resolveSessionAcpRuntimeConfig([{ id: 'turn-1', role: 'user' }], [{ $cid: 'queue-1' }], {
        acpSessionId: 'acp-1',
        basedOnUserTurnId: 'turn-1',
        revision: 1,
        configOptionValues: { collaboration_mode: 'default' },
      })
    ).toBeNull();
  });

  it('round trips member file provenance without accepting malformed root keys', () => {
    const sourcePath = encodeSessionFilePath({
      rootId: 'member:docs',
      relativePath: 'reports/a.pdf',
    });
    const payload = SessionFileBlockSchema.parse({ ...r2FilePayload, sourcePath });
    expect(historyItemsToInputBlocks(inputBlocksToHistoryItems([payload]))).toEqual([payload]);
    expect(
      SessionFileBlockSchema.safeParse({
        ...r2FilePayload,
        sourcePath: '\0lody-root:member:docs/../secret',
      }).success
    ).toBe(false);
  });

  it('accepts only workspace-relative agent upload provenance', () => {
    expect(SessionFileBlockSchema.safeParse(r2FilePayload).success).toBe(true);

    for (const sourcePath of ['/tmp/report.pdf', '../report.pdf', 'C:\\tmp\\report.pdf']) {
      expect(SessionFileBlockSchema.safeParse({ ...r2FilePayload, sourcePath }).success).toBe(
        false
      );
    }
  });

  it('normalizes null image dimensions from persisted history and input config', () => {
    const persistedImage = {
      type: 'image',
      imageId: 'img-1',
      mimeType: 'image/png',
      fileName: null,
      sizeBytes: 128,
      width: null,
      height: null,
    };

    expect(historyItemsToInputBlocks([persistedImage])).toEqual([
      {
        type: 'image',
        imageId: 'img-1',
        mimeType: 'image/png',
        fileName: undefined,
        sizeBytes: 128,
        width: undefined,
        height: undefined,
      },
    ]);

    expect(
      normalizeSessionTurnInputConfig({
        prompt: 'inspect this',
        cliType: 'builtin',
        agentType: 'codex',
        inputBlocks: [persistedImage, { type: 'text', text: 'inspect this' }],
      })
    ).toEqual({
      prompt: 'inspect this',
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: undefined,
          sizeBytes: 128,
          width: undefined,
          height: undefined,
        },
        { type: 'text', text: 'inspect this' },
      ],
    });
  });
  it('omits redundant plain single-text inputBlocks in pending user turns while preserving E2EE digests', () => {
    const plainBlocks: SessionInputBlock[] = [{ type: 'text', text: 'Synthetic oversized prompt' }];
    const plainConfig = buildSessionTurnInputConfig({
      inputBlocks: plainBlocks,
      cliType: 'builtin',
      agentType: 'codex',
    });
    const compacted = buildPendingUserHistoryEntry({
      userId: 'user-1',
      inputBlocks: plainBlocks,
      timestamp: '2026-08-12T00:00:00.000Z',
      inputConfig: plainConfig,
    });
    expect(compacted?.inputConfig?.inputBlocks).toBeUndefined();
    expect(compacted?.inputConfig?.prompt).toBe('Synthetic oversized prompt');
    expect(turnExecutionDigest({ inputConfig: compacted?.inputConfig })).toBe(
      turnExecutionDigest({ inputConfig: plainConfig })
    );
    expect(resolveSessionAuthoredText(compacted?.inputConfig ?? {})).toBe(
      'Synthetic oversized prompt'
    );
    expect(resolveSessionExecutionInputBlocks(compacted?.inputConfig ?? {})).toEqual(
      resolveSessionExecutionInputBlocks(plainConfig)
    );

    // Keep inputBlocks when Role/Config instructions make prompt differ from authored text.
    const composedConfig = buildSessionTurnInputConfig({
      inputBlocks: plainBlocks,
      prompt: 'ROLE_INSTRUCTIONS\n\nSynthetic oversized prompt',
      cliType: 'builtin',
      agentType: 'codex',
    });
    expect(
      buildPendingUserHistoryEntry({
        userId: 'user-1',
        inputBlocks: plainBlocks,
        timestamp: '2026-08-12T00:00:00.000Z',
        inputConfig: composedConfig,
      })?.inputConfig?.inputBlocks
    ).toEqual(plainBlocks);

    // Keep inputBlocks when spans or attachments exist.
    const spannedBlocks: SessionInputBlock[] = [
      {
        type: 'text',
        text: 'Check @src/a.ts',
        spans: [{ start: 6, end: 15, kind: 'file', label: '@src/a.ts', target: 'src/a.ts' }],
      },
    ];
    expect(
      buildPendingUserHistoryEntry({
        userId: 'user-1',
        inputBlocks: spannedBlocks,
        timestamp: '2026-08-12T00:00:00.000Z',
        inputConfig: buildSessionTurnInputConfig({
          inputBlocks: spannedBlocks,
          cliType: 'builtin',
          agentType: 'codex',
        }),
      })?.inputConfig?.inputBlocks
    ).toEqual(spannedBlocks);

    const attachmentBlocks: SessionInputBlock[] = [r2FilePayload, { type: 'text', text: 'check' }];
    expect(
      buildPendingUserHistoryEntry({
        userId: 'user-1',
        inputBlocks: attachmentBlocks,
        timestamp: '2026-08-12T00:00:00.000Z',
        inputConfig: buildSessionTurnInputConfig({
          inputBlocks: attachmentBlocks,
          cliType: 'builtin',
          agentType: 'codex',
        }),
      })?.inputConfig?.inputBlocks
    ).toEqual(attachmentBlocks);
  });
});

it('freezes a memory identity in turn input and restores the same identity from history', () => {
  const memory = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
  const inputConfig = buildSessionTurnInputConfig({
    prompt: 'Review this',
    cliType: 'builtin',
    agentType: 'codex',
    memory,
  });
  const doc = new Loro();
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    initialState: {
      session: { id: 'memory-session' as SessionId },
      history: [],
      mq: [],
    } satisfies Partial<SessionDoc>,
    throwOnValidationError: true,
  });
  mirror.setState((prev) => ({
    ...prev,
    history: [{ id: 'memory-turn', role: 'user', inputConfig }],
  }));
  expect(
    normalizeSessionTurnInputConfig(mirror.getState().history[0]?.inputConfig)?.memory
  ).toEqual(memory);
  mirror.dispose();
  expect(
    resolveSessionConversationConfig([{ id: 'turn-1', role: 'user', inputConfig }]).memory
  ).toEqual(memory);
  expect(
    resolveSessionConversationConfig([
      { id: 'turn-1', role: 'user', inputConfig },
      {
        id: 'turn-2',
        role: 'user',
        inputConfig: buildSessionTurnInputConfig({
          prompt: 'Continue',
          cliType: 'builtin',
          agentType: 'codex',
          agentRoleId: null,
        }),
      },
    ]).memory
  ).toBeUndefined();
});

it('retains local-only attachments across history and frozen execution input', () => {
  const input = {
    type: 'local_attachment' as const,
    path: '/tmp/image.png',
    machineId: 'machine',
    kind: 'image' as const,
    fileName: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 10,
  };
  const items = inputBlocksToHistoryItems([input, { type: 'text', text: 'inspect' }]);
  expect(historyItemsToInputBlocks(items)).toEqual([input, { type: 'text', text: 'inspect' }]);
  expect(normalizeSessionTurnInputConfig({ inputBlocks: [input] })?.inputBlocks).toEqual([input]);
  expect(() =>
    normalizeSessionTurnInputConfig({
      prompt: 'must not execute alone',
      inputBlocks: [{ ...input, path: '' }],
    })
  ).toThrow();
});

describe('session bootstrap helpers', () => {
  it('returns null when there is no effective initial user input', () => {
    const entry = buildInitialHistoryEntry({
      userId: 'user-1',
      timestamp: '2026-04-19T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      prompt: '   ',
      inputBlocks: [{ type: 'text', text: '   ' }],
    });

    expect(entry).toBeNull();
  });

  it('does not persist an unresolved local branch selector as baseBranch', () => {
    const patch = buildInitialSessionMetaPatch({
      sessionId: 'session-local' as SessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-08-02T00:00:00.000Z',
      project: {
        kind: 'local',
        localProjectId: 'project-1' as never,
        branch: 'lody:branch:remote:origin:foo',
        useWorktree: true,
      },
    });

    expect(patch.project).toMatchObject({ branch: 'lody:branch:remote:origin:foo' });
    expect(patch).not.toHaveProperty('baseBranch');
  });
});

describe('session MCP selection CRDT round-trip', () => {
  const userTurn = (
    turnId: string,
    mcpServerIds: McpServerId[] | undefined
  ): SessionHistoryInput => ({
    id: turnId,
    role: 'user',
    items: [{ type: 'text', text: turnId }],
    timestamp: '2026-08-12T00:00:00.000Z',
    status: 'pending',
    read: false,
    userId: 'user-1',
    fileDiff: [],
    finished: true,
    inputConfig: {
      prompt: turnId,
      cliType: 'builtin',
      agentType: 'codex',
      ...(mcpServerIds === undefined ? {} : { mcpServerIds }),
    },
  });

  const roundTrip = (history: SessionHistoryInput[], mq: SessionDoc['mq'] = []) => {
    const sourceDoc = new Loro();
    const source = new Mirror({
      doc: sourceDoc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    source.setState((previous) => ({ ...previous, history, mq }));

    const targetDoc = new Loro();
    targetDoc.import(sourceDoc.export({ mode: 'snapshot' }));
    const target = new Mirror({
      doc: targetDoc,
      schema: sessionDocSchema,
      throwOnValidationError: true,
    });
    const state = target.getState();
    source.dispose();
    target.dispose();
    return state;
  };

  it('keeps an explicit empty selection distinct from an absent selection', () => {
    const explicitEmpty = roundTrip([userTurn('turn-empty', [])]);
    const absent = roundTrip([userTurn('turn-absent', undefined)]);
    expect(resolveSessionConversationConfig(explicitEmpty.history, explicitEmpty.mq)).toMatchObject(
      {
        mcpServerIds: [],
      }
    );
    expect(
      resolveSessionConversationConfig(absent.history, absent.mq).mcpServerIds
    ).toBeUndefined();
  });

  it('prefers the latest queued selection over history', () => {
    const state = roundTrip(
      [userTurn('turn-history', ['history-server'] as McpServerId[])],
      [
        {
          $cid: 'queue-1',
          text: 'queued',
          timestamp: '2026-08-12T00:00:01.000Z',
          acpSessionConfig: {
            prompt: 'queued',
            cliType: 'builtin',
            agentType: 'codex',
            mcpServerIds: ['queued-server'] as McpServerId[],
          },
        },
      ]
    );
    const resolved = resolveSessionConversationConfig(state.history, state.mq);
    expect(resolved.mcpServerIds).toEqual(['queued-server']);
  });

  it('round-trips Agent Role identity and explicit None through Loro', () => {
    const historyTurn = userTurn('turn-role', undefined);
    historyTurn.inputConfig = {
      ...historyTurn.inputConfig,
      agentRoleId: 'role-reviewer' as AgentRoleId,
      agentRoleRevision: 6,
    };
    const withRole = roundTrip([historyTurn]);
    expect(resolveSessionConversationConfig(withRole.history, withRole.mq)).toMatchObject({
      agentRoleId: 'role-reviewer',
      agentRoleRevision: 6,
    });

    const withNone = roundTrip(
      [historyTurn],
      [
        {
          $cid: 'queue-none',
          text: 'queued',
          timestamp: '2026-08-12T00:00:01.000Z',
          acpSessionConfig: {
            prompt: 'queued',
            cliType: 'builtin',
            agentType: 'codex',
            agentRoleId: null,
          },
        },
      ]
    );
    expect(resolveSessionConversationConfig(withNone.history, withNone.mq).agentRoleId).toBeNull();
  });
});
