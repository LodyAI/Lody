/**
 * Loro Mirror schema objects for the session doc.
 *
 * Everything in this module evaluates `schema.*(...)` builders from
 * `loro-mirror` at module scope, which retains `loro-crdt` (WASM, ~5 MB) in
 * whichever chunk includes a value import. Import from here only on paths
 * that already own a workspace runtime or a Mirror; the renderer boot path
 * must not reach this module. Type-only imports (`import type`) are safe —
 * they erase at compile time.
 *
 * The pure helper functions and plain types that shared a file with these
 * declarations stay in `./schema`, which is loro-free and safe to import
 * anywhere.
 */
import { schema } from 'loro-mirror';
import type {
  ACPSessionId,
  AgentConfigCliType,
  AgentRoleId,
  IssuePRMention,
  MessageContent,
  Role,
  SessionId,
} from '.';
import type { SessionHistorySendStatus, SessionHistoryStatus, SessionPlanEntry } from './schema';

const historyItemAnySchema = schema.Any({ defaultLoroText: false });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWorktreeScriptHistoryStep = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.command === 'string' &&
  (value.status === 'in_progress' || value.status === 'completed' || value.status === 'failed') &&
  typeof value.output === 'string';

/**
 * Insertion hints for the nested payloads of tool content and worktree steps.
 *
 * Nested metadata is ordinary data, so the catchall defaults to *primitive* and only
 * the fields that genuinely stream are declared as `LoroText`. A blanket
 * `defaultLoroText: true` here built Text for `terminal_command.command`, `args[]`,
 * diff `path`, `steps[].command` and every other string — the container growth this
 * change exists to remove. The catchall stays permissive so an anomalous legacy shape
 * is never a validation failure or a rewrite trigger; `history-materializer.ts` reads
 * `storageSchema`, and the hints are inert for every reader.
 */
const historyNestedPayloadSchema = schema.Any({ defaultLoroText: false });
const historyToolContentSchema = schema
  .LoroMap({
    type: schema.String({ required: false }),
    // Only streaming payload fields; everything else inherits the primitive catchall.
    text: schema.LoroText({ required: false }),
    output: schema.LoroText({ required: false }),
    // The ACP `content` block nests its own text payload.
    content: schema
      .LoroMap(
        {
          type: schema.String({ required: false }),
          text: schema.LoroText({ required: false }),
        },
        { required: false }
      )
      .catchall(historyNestedPayloadSchema),
  })
  .catchall(historyNestedPayloadSchema);
const historyScriptStepSchema = schema
  .LoroMap({
    // Only the step output streams; `command`/`status`/timestamps are metadata.
    output: schema.LoroText({ required: false }),
  })
  .catchall(historyNestedPayloadSchema);

const historyMessageItemSchema = schema
  .LoroMap(
    {
      type: schema.String<MessageContent['type']>(),
      text: schema.LoroText({ required: false }),
      run: schema.Any({
        storageSchema: schema
          .LoroMap(
            {
              items: schema.LoroList(
                schema
                  .LoroMap({
                    text: schema.LoroText({ required: false }),
                    content: schema.Any({
                      storageSchema: schema.LoroList(historyToolContentSchema, undefined, {
                        required: false,
                      }),
                    }),
                  })
                  .catchall(historyNestedPayloadSchema)
              ),
            },
            { required: false }
          )
          .catchall(historyNestedPayloadSchema),
      }),
      // Streaming fields: a hint, not a validation constraint on old/future payloads.
      markdown: schema.Any({ storageSchema: schema.LoroText({ required: false }) }),
      content: schema.Any({
        storageSchema: schema.LoroList(historyToolContentSchema, undefined, { required: false }),
      }),
      steps: schema.Any({
        storageSchema: schema.LoroList(historyScriptStepSchema, undefined, { required: false }),
      }),
      // `file` item: the mutable lifecycle fields `transport`/`machineId` are
      // carried through the `.catchall(...)` below (like every other variant's
      // payload fields, e.g. image's `imageId`/`sizeBytes`). They are plain
      // scalar string keys, so the CLI backfill flips `transport` 'local' -> 'r2'
      // (and clears `machineId`) with a single `LoroMap.set` — see the
      // round-trip + field-overwrite coverage in tests/session-input.test.ts.
    },
    {
      required: true,
      validate(value: unknown) {
        if (typeof value !== 'object' || value === null) return 'Expected object';
        const v = value as Record<string, unknown>;
        const type = v.type;
        if (typeof type !== 'string') return 'Missing type';

        switch (type) {
          case 'text':
          case 'thought':
            return typeof v.text === 'string' ? true : 'Missing text';
          case 'image':
            return typeof v.imageId === 'string' &&
              typeof v.mimeType === 'string' &&
              typeof v.sizeBytes === 'number'
              ? true
              : 'Missing image metadata';
          case 'file':
            if (
              typeof v.fileId !== 'string' ||
              typeof v.fileName !== 'string' ||
              typeof v.mimeType !== 'string' ||
              typeof v.sizeBytes !== 'number' ||
              typeof v.sha256 !== 'string' ||
              typeof v.textPreview !== 'boolean' ||
              (v.transport !== 'r2' && v.transport !== 'local') ||
              typeof v.uploadedAt !== 'number'
            ) {
              return 'Missing file metadata';
            }
            // transport='local' means the bytes only live on one machine pending
            // relay backfill; machineId is required to render the pending state.
            if (
              v.transport === 'local' &&
              (typeof v.machineId !== 'string' || v.machineId === '')
            ) {
              return "machineId is required when transport is 'local'";
            }
            return true;
          case 'image_group':
            return Array.isArray(v.images) && v.images.length > 0 ? true : 'Missing images';
          case 'plan':
            return Array.isArray(v.entries) ? true : 'Missing entries';
          case 'proposed_plan':
            return typeof v.turnId === 'string' &&
              typeof v.markdown === 'string' &&
              typeof v.status === 'string' &&
              typeof v.isLatest === 'boolean'
              ? true
              : 'Missing proposed plan metadata';
          case 'goal':
            return typeof v.threadId === 'string' &&
              typeof v.objective === 'string' &&
              typeof v.status === 'string' &&
              (v.tokensUsed === undefined || typeof v.tokensUsed === 'number') &&
              (v.timeUsedSeconds === undefined || typeof v.timeUsedSeconds === 'number') &&
              (v.createdAt === undefined || typeof v.createdAt === 'number') &&
              (v.updatedAt === undefined || typeof v.updatedAt === 'number')
              ? true
              : 'Missing goal metadata';
          case 'tool_call':
            return typeof v.toolCallId === 'string' && typeof v.status === 'string'
              ? true
              : 'Missing toolCallId/status';
          case 'subagent_task':
            return typeof v.taskId === 'string' && typeof v.status === 'string'
              ? true
              : 'Missing taskId/status';
          case 'available_commands':
            return Array.isArray(v.commands) ? true : 'Missing commands';
          case 'system_notice':
            return typeof v.name === 'string' ? true : 'Missing name';
          case 'operation_progress':
            return typeof v.operationId === 'string' &&
              (v.operationKind === 'session_create' || v.operationKind === 'session_create_many') &&
              Array.isArray(v.items) &&
              v.items.every(
                (item) =>
                  isRecord(item) &&
                  isRecord(item.target) &&
                  typeof item.target.sessionId === 'string' &&
                  typeof item.target.userTurnId === 'string' &&
                  (item.label === undefined || typeof item.label === 'string') &&
                  typeof item.status === 'string' &&
                  ['created', 'running', 'succeeded', 'failed', 'cancelled'].includes(item.status)
              )
              ? true
              : 'Missing operation progress metadata';
          case 'operation_completion_batch':
            return typeof v.batchId === 'string' &&
              typeof v.memberCount === 'number' &&
              Number.isInteger(v.memberCount) &&
              v.memberCount > 0
              ? true
              : 'Missing operation batch metadata';
          case 'operation_completion':
            return typeof v.deliveryId === 'string' &&
              typeof v.operationId === 'string' &&
              typeof v.operationKind === 'string' &&
              typeof v.completion === 'object' &&
              v.completion !== null
              ? true
              : 'Missing operation completion metadata';
          case 'worktree_script':
            return typeof v.phase === 'string' &&
              typeof v.status === 'string' &&
              Array.isArray(v.steps) &&
              v.steps.every(isWorktreeScriptHistoryStep)
              ? true
              : 'Missing worktree script metadata';
          case 'comment_reference':
            return typeof v.source === 'string' &&
              typeof v.path === 'string' &&
              typeof v.lineNumber === 'number' &&
              typeof v.side === 'string' &&
              typeof v.commentBody === 'string' &&
              typeof v.authorName === 'string'
              ? true
              : 'Missing comment reference metadata';
          case 'visual_annotation_reference':
            return v.source === 'visual_annotation' &&
              typeof v.commentId === 'string' &&
              typeof v.body === 'string' &&
              typeof v.anchor === 'object' &&
              v.anchor !== null
              ? true
              : 'Missing visual annotation reference metadata';
          default:
            // Synced history may contain variants written by newer peers.
            // Rejecting one here blocks every subsequent Mirror.setState,
            // including unrelated user messages and control-field updates.
            // Preserve the opaque item without extending MessageContentSchema's
            // accepted input types. Known variants keep their existing guards.
            return true;
        }
      },
    }
  )
  .catchall(historyItemAnySchema);

export const sessionPlanEntrySchema = schema.LoroMap({
  status: schema.String<SessionPlanEntry['status']>(),
  content: schema.String(),
  priority: schema.String<SessionPlanEntry['priority']>(),
});

const issuePrMentionSchema = schema.LoroMap({
  type: schema.String<IssuePRMention['type']>(),
  title: schema.String(),
  url: schema.String(),
  number: schema.Number(),
});

// Loro Mirror passes null through transforms without invoking encode/decode.
// The transform therefore gives this optional string its domain-level explicit
// None state while retaining a primitive string in the CRDT when an id exists.
const agentRoleIdSchema = schema
  .String<AgentRoleId>({ required: false })
  .transform<AgentRoleId | null>({
    decode: (value) => value,
    encode: (value) => value,
  });

const acpSessionConfigSchema = schema
  .LoroMap(
    {
      prompt: schema.String(),
      inputBlocks: schema.Any({ required: false }),
      cliType: schema.String<AgentConfigCliType>(),
      agentType: schema.String(),
      modeId: schema.String({ required: false }),
      modelId: schema.String({ required: false }),
      issuePRMentions: schema.LoroList(issuePrMentionSchema, undefined, { required: false }),
      resume: schema.String({ required: false }),
      /** Config option values (configId → value) for setSessionConfigOption */
      configOptionValues: schema.Any({ required: false }),
      /** Workspace MCP catalog ids selected for this session (string[]). */
      memory: schema.Any({ required: false }),
      mcpServerIds: schema.Any({ required: false }),
      /** Agent Role selected for this Turn; null is explicit None. */
      agentRoleId: agentRoleIdSchema,
      agentRoleRevision: schema.Number({ required: false }),
      agentRoleSnapshot: schema.Any({ required: false }),
      chainDepth: schema.Number({ required: false }),
      _lodyAutomation: schema.Any({ required: false }),
    },
    { required: false }
  )
  .catchall(schema.Any());

export const sessionPreviewDocSchema = schema.LoroMap(
  {
    candidate: schema.Any({ required: false }),
    connection: schema.Any({ required: false }),
  },
  { required: false }
);

export const sessionExternalHistoryCursorDocSchema = schema.LoroMap(
  {
    importedTurnHashes: schema.LoroList(schema.String(), undefined, { required: false }),
    hashVersion: schema.Number({ required: false }),
    // One atomic value: concurrent clients must not merge half of two baselines.
    storedHistoryBaseline: schema.String({ required: false }),
  },
  { required: false }
);

export const sessionHistorySchema = schema.LoroMap({
  id: schema.String(),
  userTurnId: schema.String({ required: false }),
  // Provider-native assistant turn boundary emitted by the ACP adapter.
  // Lody stores and returns this opaque value without interpreting it.
  acpTurnId: schema.String({ required: false }),
  items: schema.LoroList(historyMessageItemSchema, undefined, { required: false }),
  // Plan attached to this turn, updated via notification updates during the agent's response
  plan: schema.LoroList(sessionPlanEntrySchema, undefined, { required: false }),
  timestamp: schema.String(),
  startedAt: schema.Number({ required: false }),
  endedAt: schema.Number({ required: false }),
  // Total time in milliseconds spent waiting for permission approvals during this turn.
  // Effective agent working time = (endedAt - Date.parse(timestamp)) - permissionWaitMs
  permissionWaitMs: schema.Number({ required: false }),
  role: schema.String<Role>(),
  status: schema.String<SessionHistoryStatus>({ required: false }),
  scheduleRun: schema.LoroMap(
    {
      scheduleId: schema.String(),
      turnId: schema.String(),
      title: schema.String(),
      definitionFingerprint: schema.String({ required: false }),
      manualRunKey: schema.String({ required: false }),
    },
    { required: false }
  ),
  /** Encrypted only: the shared member's active Turn this machine-authored input was
   * derived from. Covered by the input's signature check; never display data. */
  derivedFrom: schema.LoroMap(
    { sessionId: schema.String(), userTurnId: schema.String() },
    { required: false }
  ),
  /** Encrypted only: this machine wrote the row by promoting a queue item. The row's
   * signer is then not its author, so the start needs the input's own evidence. */
  queuedInput: schema.Boolean({ required: false }),
  /** Encrypted only: the signed execution intent record, written in the same commit
   * as the content it covers. See `e2ee-execution-intent.ts`. */
  e2eeIntent: schema.String({ required: false }),
  cancellationReason: schema.String<'user_stop' | 'machine_update'>({ required: false }),
  inputConfig: acpSessionConfigSchema,
  /**
   * @deprecated Use `status` instead.
   * Kept temporarily so existing persisted docs and older UI logic remain readable.
   */
  read: schema.Boolean({ required: false }),
  userId: schema.String({ required: false }),
  author: schema.Any({ required: false }),
  modelInfo: schema.Any({ required: false }),
  // Assistant turns: tokens and optional estimated cost this turn consumed,
  // summed from adapter usage deltas. A primitive JSON value
  // (`SessionTurnTokenUsage`), replaced whole on each write.
  tokenUsage: schema.Any({ required: false }),
  // FileDiff 此次对话有哪些文件变更，和具体变更行数
  fileDiff: schema.Any(),
  // Indicates whether the agent's response for this turn has finished
  // For assistant turns: set to true when agent completes response
  // For user turns: always true (user messages are complete when created)
  finished: schema.Boolean({ required: false }),
  // Send status for user messages - only set when message delivery failed (e.g., timeout)
  // Cleared when message is successfully retried
  sendStatus: schema.String<SessionHistorySendStatus>({ required: false }),
});

export const sessionSchema = schema.LoroMap({
  id: schema.String<SessionId>(),
});

export const messageQueueItemSchema = schema.LoroMap({
  task: schema.String(),
  project: schema.Any({ required: false }),
  userId: schema.String(),
  userTurnId: schema.String({ required: false }),
  /** Stable queue promotion identity; legacy rows derive it from userTurnId/$cid. */
  operationId: schema.String({ required: false }),
  timestamp: schema.String(),
  isEditing: schema.Boolean({ required: false }),
  /** Stop retains this row for an explicit send, without automatic promotion. */
  paused: schema.Boolean({ required: false }),
  // Calibrated server time (`getServerNow()`) when the current editor entered the row.
  // Used as a lease so the CLI dispatcher does not block the queue forever if the
  // editing client never gets a chance to clear `isEditing` (hard close / crash /
  // killed tab). See `popMessageQueue` in `apps/cli/src/lib/loro/doc.ts`.
  editingStartedAt: schema.Number({ required: false }),
  acpSessionConfig: acpSessionConfigSchema,
  /** Encrypted only: the author's signed execution intent; promotion copies it. */
  e2eeIntent: schema.String({ required: false }),
});

const sessionForkOperationDocSchema = schema.LoroMap(
  {
    id: schema.String(),
    sourceSessionId: schema.String<SessionId>(),
    sourceTurnId: schema.String(),
    requestedByUserId: schema.String(),
    targetContext: schema.String<'shared' | 'new-worktree'>(),
    capturedHeadSha: schema.String({ required: false }),
    sourceWasDirty: schema.Boolean({ required: false }),
    state: schema.String<'preparing' | 'failed'>(),
    phase: schema.String<'preparing-worktree' | 'running-setup' | 'starting-agent' | 'committing'>({
      required: false,
    }),
    error: schema.LoroMap(
      {
        code: schema.String(),
        message: schema.String(),
      },
      { required: false }
    ),
    createdAt: schema.String(),
    updatedAt: schema.String(),
  },
  { required: false }
);

const sessionAcpRuntimeConfigDocSchema = schema.LoroMap(
  {
    acpSessionId: schema.String<ACPSessionId>(),
    basedOnUserTurnId: schema.String(),
    revision: schema.Number(),
    modeId: schema.String({ required: false }),
    modelId: schema.String({ required: false }),
    configOptionValues: schema.Any({ required: false }),
    availableCommands: schema.LoroList(
      schema.LoroMap({
        name: schema.String(),
        description: schema.String({ required: false }),
      }),
      undefined,
      { required: false }
    ),
  },
  { required: false }
);

/**
 * Root schema for a session doc.
 *
 * Synced docs outlive the builds that write them: a client on a newer schema
 * can add a root key that older clients do not declare. Adding an optional
 * root field is therefore safe, but only because every Mirror over a synced
 * doc is constructed with `ignoreUnknownProperties` — without it loro-mirror
 * rejects the whole state with `Unknown property: <key>` and the older client
 * can never write to that doc again. Removing or repurposing an existing root
 * field is still a breaking change.
 *
 * See `packages/shared/tests/session-doc-forward-compat.test.ts`.
 */

export const sessionDocSchema = schema({
  session: sessionSchema,
  history: schema.LoroList(sessionHistorySchema, (item) => item.id),
  mq: schema.LoroMovableList(messageQueueItemSchema, (item) => item.$cid, { required: false }),
  /** Explicit human-send outbox. Never inferred from user role or Agent authors. */
  humanInputReceipts: schema
    .LoroMap({}, { required: false })
    .catchall(schema.LoroMap({ userId: schema.String() })),
  /** Latest Stop only; metadata carries its marker, not its payload. */
  cancelRequest: schema.LoroMap(
    { id: schema.String(), turnId: schema.String() },
    { required: false }
  ),
  /** Temporary durable state for an asynchronous Session fork. Removed on success. */
  forkOperation: sessionForkOperationDocSchema,
  notification: schema.LoroMap(
    {
      id: schema.String(),
      recipientId: schema.String(),
      turnId: schema.String(),
      outcome: schema.String(),
      presentation: schema.LoroMap(
        {
          kind: schema.String<'conversation' | 'schedule'>(),
          conversationTitle: schema.String({ required: false }),
          scheduleName: schema.String({ required: false }),
          projectName: schema.String({ required: false }),
          pullRequestNumber: schema.Number({ required: false }),
        },
        { required: false }
      ),
      createdAt: schema.Number(),
    },
    { required: false }
  ),
  preview: sessionPreviewDocSchema,
  externalHistoryCursor: sessionExternalHistoryCursorDocSchema,
  acpRuntimeConfig: sessionAcpRuntimeConfigDocSchema,
});
