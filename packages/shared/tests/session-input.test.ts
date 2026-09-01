import { describe, expect, it } from 'vitest';

import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  buildInitialSessionTurnInputConfig,
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  extractPromptPreviewFromInputBlocks,
  historyItemsToInputBlocks,
  inputBlocksToHistoryItems,
  normalizeSessionInputBlocks,
  resolveSessionAcpRuntimeConfig,
  resolveSessionConversationConfig,
  resolveSessionConversationSourceFence,
  resolveSessionTaskToolsEnabled,
} from '../src/session-input';
import { normalizeSessionTurnInputConfig, SessionFileBlockSchema } from '../src/message-schemas';
import { sessionDocSchema } from '../src/schema';
import type {
  CommentReferencePayload,
  MessageContent,
  SessionFilePayload,
  SessionId,
  VisualAnnotationReferencePayload,
} from '../src/ai';
import type { SessionDoc, SessionHistoryInput } from '../src/schema';

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

  it('uses only the latest durable queued config when the queue is non-empty', () => {
    expect(
      resolveSessionConversationConfig(
        [
          {
            id: 'turn-1',
            role: 'user',
            inputConfig: {
              modeId: 'ask',
              modelId: 'model-a',
              configOptionValues: { approval: 'prompt', fast_mode: false },
            },
          },
        ],
        [
          {
            $cid: 'queue-1',
            acpSessionConfig: {
              modelId: 'model-b',
              configOptionValues: { approval: 'never' },
            },
          },
        ]
      )
    ).toEqual({
      sourceConfigKey: 'queue:queue-1',
      modelId: 'model-b',
      configOptionValues: { approval: 'never' },
    });
  });

  it('keeps one causal Turn key when a queued Turn is promoted to history', () => {
    const queued = resolveSessionConversationSourceFence(
      [{ id: 'turn-1', role: 'user' }],
      [{ $cid: 'queue-cid', userTurnId: 'turn-2', acpSessionConfig: {} }]
    );
    const promoted = resolveSessionConversationSourceFence([
      { id: 'turn-1', role: 'user' },
      { id: 'turn-2', role: 'user' },
    ]);

    expect(queued.currentTurnKey).toBe('turn:turn-2');
    expect(promoted.currentTurnKey).toBe('turn:turn-2');
    expect(queued.knownTurnKeys).toEqual(['turn:turn-2', 'turn:turn-1']);
    expect(promoted.knownTurnKeys).toEqual(['turn:turn-2', 'turn:turn-1']);

    const legacyQueued = resolveSessionConversationSourceFence(
      [],
      [{ $cid: 'legacy-cid', acpSessionConfig: {} }]
    );
    const legacyPromoted = resolveSessionConversationSourceFence([
      { id: 'queued-legacy-cid', role: 'user' },
    ]);
    expect(legacyQueued.currentTurnKey).toBe('turn:queued-legacy-cid');
    expect(legacyPromoted.currentTurnKey).toBe('turn:queued-legacy-cid');
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

  it('resolves the frozen Task tool gate with legacy inputs disabled', () => {
    expect(
      resolveSessionTaskToolsEnabled([
        {
          id: 'turn-1',
          role: 'user',
          inputConfig: {
            prompt: 'create a task',
            cliType: 'builtin',
            agentType: 'codex',
            taskToolsEnabled: true,
          },
        },
      ])
    ).toBe(true);
    expect(
      resolveSessionTaskToolsEnabled([
        {
          id: 'legacy-turn',
          role: 'user',
          inputConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
        },
      ])
    ).toBe(false);
  });

  it('ignores invalid and unconfigured history when resolving conversation config', () => {
    expect(
      resolveSessionConversationConfig([
        {
          id: 'turn-1',
          role: 'user',
          inputConfig: { modeId: 'ask', modelId: 'model-a' },
        },
        {
          id: 'turn-2',
          role: 'user',
          inputConfig: { cliType: 'invalid' },
        },
      ])
    ).toEqual({});
  });

  it('normalizes text blocks and falls back to the prompt when needed', () => {
    expect(
      normalizeSessionInputBlocks(
        [
          { type: 'text', text: '  hello  ' },
          { type: 'text', text: '   ' },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
        'ignored'
      )
    ).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        imageId: 'img-1',
        mimeType: 'image/png',
        sizeBytes: 128,
      },
    ]);

    expect(normalizeSessionInputBlocks(undefined, '  fallback prompt  ')).toEqual([
      { type: 'text', text: 'fallback prompt' },
    ]);
  });

  it('extracts prompt previews from normalized text blocks', () => {
    expect(
      extractPromptPreviewFromInputBlocks([
        { type: 'text', text: ' first ' },
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 128,
        },
        { type: 'text', text: ' second ' },
      ])
    ).toBe('first\n\nsecond');
  });

  it('converts between input blocks and history items without keeping unrelated message content', () => {
    const inputBlocks = [
      { type: 'text', text: '  hello  ' },
      {
        type: 'image',
        imageId: 'img-1',
        mimeType: 'image/png',
        sizeBytes: 128,
        width: 10,
        height: 20,
      },
      { type: 'text', text: '   ' },
    ] as const;

    expect(inputBlocksToHistoryItems(inputBlocks)).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        text: undefined,
        imageId: 'img-1',
        mimeType: 'image/png',
        sizeBytes: 128,
        width: 10,
        height: 20,
      },
    ]);

    expect(
      historyItemsToInputBlocks([
        { type: 'text', text: '  hello  ' },
        { type: 'plan', entries: [] },
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 128,
          width: 10,
          height: 20,
        },
        { type: 'system_notice', name: 'resume_from_external_chat_history' },
      ])
    ).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        imageId: 'img-1',
        mimeType: 'image/png',
        sizeBytes: 128,
        width: 10,
        height: 20,
      },
    ]);
  });

  it('converts visual annotation references between input blocks and history items', () => {
    const inputBlocks = [
      { type: 'visual_annotation_reference' as const, ...visualAnnotationReference },
    ];

    expect(inputBlocksToHistoryItems(inputBlocks)).toEqual([
      {
        type: 'visual_annotation_reference',
        text: undefined,
        ...visualAnnotationReference,
      },
    ]);

    expect(
      historyItemsToInputBlocks([
        {
          type: 'visual_annotation_reference',
          ...visualAnnotationReference,
        },
      ])
    ).toEqual(inputBlocks);
  });

  it('round-trips r2 file blocks through history items', () => {
    const inputBlocks = [r2FilePayload];

    const historyItems = inputBlocksToHistoryItems(inputBlocks);
    expect(historyItems).toEqual([
      {
        type: 'file',
        text: undefined,
        fileId: 'file-r2-1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        sha256: 'a'.repeat(64),
        textPreview: false,
        sourcePath: 'artifacts/report.pdf',
        transport: 'r2',
        uploadedAt: 1_700_000_000_000,
      },
    ]);

    // r2 transport carries no machineId; it must not leak back in.
    expect(historyItemsToInputBlocks(historyItems)).toEqual(inputBlocks);
  });

  it('accepts only workspace-relative agent upload provenance', () => {
    expect(SessionFileBlockSchema.safeParse(r2FilePayload).success).toBe(true);

    for (const sourcePath of ['/tmp/report.pdf', '../report.pdf', 'C:\\tmp\\report.pdf']) {
      expect(SessionFileBlockSchema.safeParse({ ...r2FilePayload, sourcePath }).success).toBe(
        false
      );
    }
  });

  it('round-trips local file blocks (with machineId) through history items', () => {
    const inputBlocks = [localFilePayload];

    const historyItems = inputBlocksToHistoryItems(inputBlocks);
    expect(historyItems).toEqual([
      {
        type: 'file',
        text: undefined,
        fileId: 'file-local-1',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 256,
        sha256: 'b'.repeat(64),
        textPreview: true,
        transport: 'local',
        machineId: 'machine-1',
        uploadedAt: 1_700_000_100_000,
      },
    ]);

    expect(historyItemsToInputBlocks(historyItems)).toEqual(inputBlocks);
  });

  it('persists file user history entries and flips transport local -> r2 in place', () => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    const entry: SessionHistoryInput = {
      id: 'h1',
      role: 'user',
      items: inputBlocksToHistoryItems([localFilePayload]) as MessageContent[],
      timestamp: '2026-04-13T00:00:00.000Z',
      status: 'pending',
      read: false,
      userId: 'user-1',
      fileDiff: [],
      finished: true,
    };

    try {
      expect(() => {
        mirror.setState((prev) => ({ ...prev, history: [entry] }));
      }).not.toThrow();

      const persisted = mirror.getState().history[0]?.items?.[0] as
        | (MessageContent & SessionFilePayload)
        | undefined;
      expect(persisted?.type).toBe('file');
      expect(persisted?.transport).toBe('local');
      expect(persisted?.machineId).toBe('machine-1');

      // CLI backfill completes: overwrite only `transport` (and drop machineId)
      // on the same history item. This must be a single-field LoroMap update,
      // not a full item rewrite, so concurrent edits to the turn survive.
      mirror.setState((prev) => ({
        ...prev,
        history: prev.history.map((turn) =>
          turn.id !== 'h1'
            ? turn
            : {
                ...turn,
                items: turn.items?.map((item) =>
                  item.type === 'file' ? { ...item, transport: 'r2', machineId: undefined } : item
                ),
              }
        ),
      }));

      const updated = mirror.getState().history[0]?.items?.[0] as
        | (MessageContent & SessionFilePayload)
        | undefined;
      expect(updated?.type).toBe('file');
      expect(updated?.transport).toBe('r2');
      expect(updated?.machineId).toBeUndefined();
      // Unrelated fields are untouched by the single-field overwrite.
      expect(updated?.fileId).toBe('file-local-1');
      expect(updated?.sha256).toBe('b'.repeat(64));
    } finally {
      mirror.dispose();
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

  it('keeps visual annotation references in normalized turn input config', () => {
    expect(
      normalizeSessionTurnInputConfig({
        prompt: 'fix the visual target',
        cliType: 'builtin',
        agentType: 'codex',
        inputBlocks: [
          { type: 'visual_annotation_reference' as const, ...visualAnnotationReference },
        ],
      })
    ).toEqual({
      prompt: 'fix the visual target',
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'visual_annotation_reference', ...visualAnnotationReference }],
    });
  });

  it('builds a normalized session turn input config', () => {
    expect(
      buildSessionTurnInputConfig({
        inputBlocks: [
          { type: 'text', text: '  hello  ' },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
        cliType: 'builtin',
        agentType: 'codex',
        configOptionValues: {},
      })
    ).toEqual({
      prompt: 'hello',
      inputBlocks: [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 128,
        },
      ],
      cliType: 'builtin',
      agentType: 'codex',
      modeId: undefined,
      modelId: undefined,
      configOptionValues: undefined,
      mcpServerIds: undefined,
      issuePRMentions: undefined,
      resume: undefined,
    });
  });

  it('builds an initial session input config only for valid prompt and cli type', () => {
    expect(
      buildInitialSessionTurnInputConfig({
        prompt: '  hello  ',
        cliType: 'builtin',
        agentType: 'codex',
      })
    ).toEqual({
      prompt: 'hello',
      inputBlocks: [{ type: 'text', text: 'hello' }],
      cliType: 'builtin',
      agentType: 'codex',
      modeId: undefined,
      modelId: undefined,
      configOptionValues: undefined,
      mcpServerIds: undefined,
      issuePRMentions: undefined,
      resume: undefined,
    });

    expect(
      buildInitialSessionTurnInputConfig({
        prompt: 'hello',
        cliType: 'invalid',
        agentType: 'codex',
      })
    ).toBeUndefined();
  });

  it('builds pending user history entries only when user id and effective items exist', () => {
    expect(
      buildPendingUserHistoryEntry({
        userId: ' user-1 ',
        inputBlocks: [
          { type: 'text', text: '  hello  ' },
          {
            type: 'image',
            imageId: 'img-1',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
        timestamp: '2026-03-24T00:00:00.000Z',
        inputConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
        },
      })
    ).toEqual({
      userId: 'user-1',
      role: 'user',
      items: [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          text: undefined,
          imageId: 'img-1',
          mimeType: 'image/png',
          sizeBytes: 128,
        },
      ],
      timestamp: '2026-03-24T00:00:00.000Z',
      status: 'pending',
      inputConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
      },
      read: false,
      fileDiff: [],
      finished: true,
    });

    expect(
      buildPendingUserHistoryEntry({
        userId: undefined,
        inputBlocks: [{ type: 'text', text: 'hello' }],
        timestamp: '2026-03-24T00:00:00.000Z',
      })
    ).toBeNull();

    expect(
      buildPendingUserHistoryEntry({
        userId: 'user-1',
        inputBlocks: [{ type: 'text', text: '   ' }],
        timestamp: '2026-03-24T00:00:00.000Z',
      })
    ).toBeNull();
  });

  it('builds guide history entries as pending application', () => {
    expect(
      buildPendingUserHistoryEntry({
        userId: 'user-1',
        inputBlocks: [{ type: 'text', text: 'change direction' }],
        timestamp: '2026-07-11T00:00:00.000Z',
        status: 'pending_apply',
      })
    ).toMatchObject({
      role: 'user',
      status: 'pending_apply',
      read: false,
    });
  });

  it('persists comment-only user history entries through the session doc schema', () => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    const entry: SessionHistoryInput = {
      id: 'h1',
      role: 'user',
      items: [
        {
          type: 'comment_reference',
          ...commentReference,
        } satisfies MessageContent,
      ],
      timestamp: '2026-04-13T00:00:00.000Z',
      status: 'pending',
      read: false,
      userId: 'user-1',
      fileDiff: [],
      finished: true,
    };

    try {
      expect(() => {
        mirror.setState((prev) => ({
          ...prev,
          history: [entry],
        }));
      }).not.toThrow();
      expect(mirror.getState().history[0]?.items?.[0]?.type).toBe('comment_reference');
    } finally {
      mirror.dispose();
    }
  });

  it('persists visual annotation reference user history entries through the session doc schema', () => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    const entry: SessionHistoryInput = {
      id: 'h1',
      role: 'user',
      items: [
        {
          type: 'visual_annotation_reference',
          ...visualAnnotationReference,
        } satisfies MessageContent,
      ],
      timestamp: '2026-04-13T00:00:00.000Z',
      status: 'pending',
      read: false,
      userId: 'user-1',
      fileDiff: [],
      finished: true,
    };

    try {
      expect(() => {
        mirror.setState((prev) => ({
          ...prev,
          history: [entry],
        }));
      }).not.toThrow();
      expect(mirror.getState().history[0]?.items?.[0]?.type).toBe('visual_annotation_reference');
    } finally {
      mirror.dispose();
    }
  });

  it('normalizes mirrored config option maps without carrying the Loro container id', () => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    const entry: SessionHistoryInput = {
      id: 'h1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: '2026-04-13T00:00:00.000Z',
      status: 'pending',
      read: false,
      userId: 'user-1',
      fileDiff: [],
      finished: true,
      inputConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        configOptionValues: {
          approval: 'never',
          fast_mode: true,
        },
      },
    };

    try {
      mirror.setState((prev) => ({
        ...prev,
        history: [entry],
      }));

      const mirroredInputConfig = mirror.getState().history[0]?.inputConfig;
      const mirroredValues = mirroredInputConfig?.configOptionValues as
        | Record<string, unknown>
        | undefined;

      expect(mirroredValues?.approval).toBe('never');
      expect(mirroredValues?.$cid).toEqual(expect.stringContaining(':Map'));
      expect(Object.prototype.propertyIsEnumerable.call(mirroredValues, '$cid')).toBe(false);
      expect(normalizeSessionTurnInputConfig(mirroredInputConfig)).toEqual({
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        configOptionValues: {
          approval: 'never',
          fast_mode: true,
        },
      });
    } finally {
      mirror.dispose();
    }
  });
});
