import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import type { MessageContent } from '../src/ai';
import {
  MAX_STORED_TERMINAL_OUTPUT_BYTES,
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  truncateTerminalOutputForHistory,
} from '../src/acp/history-apply';
import {
  parseSessionNotification,
  parseSessionNotifications,
  type AcpSessionNotification,
} from '../src/acp/schema';

const normalizeMessageContent = (item: MessageContent): MessageContent => {
  const normalized = JSON.parse(JSON.stringify(item)) as MessageContent;
  if (normalized.type === 'tool_call' && !Array.isArray(normalized.content)) {
    return {
      ...normalized,
      content: [],
    };
  }
  return normalized;
};

const normalizeHistory = (history: unknown[]) => {
  return history.map((entry) => {
    const record = entry as {
      role?: unknown;
      items?: unknown;
      contents?: unknown;
      plan?: unknown;
      modelInfo?: unknown;
    };
    const rawContents = Array.isArray(record.items)
      ? (record.items as MessageContent[])
      : Array.isArray(record.contents)
        ? (record.contents as MessageContent[])
        : [];

    return JSON.parse(
      JSON.stringify({
        role: record.role,
        contents: rawContents.map(normalizeMessageContent),
        ...(Array.isArray(record.plan) ? { plan: record.plan } : {}),
        ...(record.modelInfo ? { modelInfo: record.modelInfo } : {}),
      })
    );
  });
};

const loadFixtureNotifications = (fixtureName: string): AcpSessionNotification[] => {
  const fixturePath = path.join(__dirname, '../../../apps/cli/tests/fixtures/acp', fixtureName);
  return parseSessionNotifications(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
};

const makeNotification = (update: unknown): AcpSessionNotification => {
  return parseSessionNotification({ sessionId: 'test-session', update });
};

const replayInChunks = (
  notifications: AcpSessionNotification[],
  chunkSizes: readonly number[]
): ReturnType<typeof applyNotificationOnHistory> => {
  let history: ReturnType<typeof applyNotificationOnHistory> = [];
  let index = 0;
  let chunkIndex = 0;

  while (index < notifications.length) {
    const chunkSize = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
    history = applyNotificationOnHistory(history, notifications.slice(index, index + chunkSize));
    index += chunkSize;
    chunkIndex += 1;
  }

  return history;
};

const ACP_NOTIFICATION_FIXTURES = [
  'codex-terminal-notifications.sample.json',
  'claude-code-notifications.captured.json',
  'claude-code-terminal-notifications.captured.json',
  'claude-code-thinking-notifications.captured.json',
  'kimi-shell-notifications.sample.json',
] as const;

describe('acp history apply', () => {
  it('persists the provider turn id on the assistant entry', () => {
    const history = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_first',
          content: { type: 'text', text: 'Hello' },
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_final',
          content: { type: 'text', text: ' world' },
        }),
        makeNotification({
          sessionUpdate: 'session_info_update',
          _meta: { lody: { turnId: 'turn_final' } },
        }),
      ],
      undefined,
      { targetAssistantEntryId: 'assistant-turn' }
    );

    expect(history).toEqual([
      expect.objectContaining({
        id: 'assistant-turn',
        acpTurnId: 'turn_final',
        items: [{ type: 'text', text: 'Hello world' }],
      }),
    ]);
  });

  it('keeps a valid UTF-8 terminal tail within the shared byte budget', () => {
    const input = `${'a'.repeat(900)}${'界'.repeat(100)}${'🙂'.repeat(100)}`;
    const result = truncateTerminalOutputForHistory(input);

    expect(result.didTruncate).toBe(true);
    expect(new TextEncoder().encode(result.output).byteLength).toBeLessThanOrEqual(
      MAX_STORED_TERMINAL_OUTPUT_BYTES
    );
    expect(result.output).toBe(input.slice(input.length - result.output.length));
  });

  it('shares the terminal history budget across stdout and stderr', () => {
    const history = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'combined-output',
          status: 'completed',
          rawOutput: {
            stdout: 'a'.repeat(900),
            stderr: 'b'.repeat(900),
            exit_code: 1,
          },
        }),
      ]
    );
    const toolCall = ((history[0]?.items ?? []) as unknown as MessageContent[]).find(
      (item) => item.type === 'tool_call'
    ) as Extract<MessageContent, { type: 'tool_call' }>;
    const outputs = toolCall.content?.filter((block) => block.type === 'terminal_output') ?? [];

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ stream: 'combined', truncated: true });
    expect(
      new TextEncoder().encode((outputs[0] as { output: string }).output).byteLength
    ).toBeLessThanOrEqual(MAX_STORED_TERMINAL_OUTPUT_BYTES);
  });

  it('preserves context compaction and retry activity markers across tool updates', () => {
    const history = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'compact-1',
          title: 'Context compacting',
          status: 'in_progress',
          _meta: { contextCompaction: true },
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'compact-1',
          status: 'completed',
          _meta: { contextCompaction: true },
        }),
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'retry-1',
          title: 'Codex retrying',
          status: 'in_progress',
          _meta: { lody: { activityKind: 'codex_retry' } },
        }),
      ]
    );

    const toolCalls = history
      .flatMap((entry) => entry.items)
      .filter((item) => item.type === 'tool_call');
    expect(toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'compact-1',
        status: 'completed',
        activityKind: 'context_compaction',
      }),
      expect.objectContaining({
        toolCallId: 'retry-1',
        status: 'in_progress',
        activityKind: 'codex_retry',
      }),
    ]);
  });

  it('ignores usage telemetry and non-text assistant chunks without writing history', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'usage_update',
        size: 100_000,
        used: 1_234,
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      }),
      makeNotification({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'resource_link',
          name: 'example',
          uri: 'file:///tmp/example.txt',
        },
      }),
    ];

    expect(() => applyNotificationOnHistory([], notifications)).not.toThrow();
    expect(applyNotificationOnHistory([], notifications)).toEqual([]);
  });

  it('does not persist available_commands updates into chat history', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: '/review', description: 'Review current changes' }],
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toEqual([]);
  });

  it('parses Claude Code <thinking> tags into thought + text', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '<thinking>\nLet me think.\n</thinking>\nAnswer.',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items.map((i) => i.type)).toEqual(['thought', 'text']);
    expect((items[0] as { text?: string }).text).toBe('\nLet me think.\n');
    expect((items[1] as { text?: string }).text).toBe('\nAnswer.');
  });

  it('parses raw Codex <proposed_plan> tags into proposed plan content', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Before\n<proposed_plan>\n- Inspect parser\n- Reuse plan UI\n</proposed_plan>\nAfter',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications, undefined, {
      createId: () => 'turn-1',
    });
    expect(history).toHaveLength(1);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items).toEqual([
      { type: 'text', text: 'Before\n' },
      {
        type: 'proposed_plan',
        turnId: 'turn-1',
        markdown: '- Inspect parser\n- Reuse plan UI',
        status: 'completed',
        isLatest: true,
      },
      { type: 'text', text: '\nAfter' },
    ]);
  });

  it('parses raw Codex proposed plan tags after streamed chunks are merged', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Before\n<proposed_',
        },
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'plan>\n- Inspect parser\n</proposed_plan>\nAfter',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications, undefined, {
      createId: () => 'turn-1',
    });
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items.map((item) => item.type)).toEqual(['text', 'proposed_plan', 'text']);
    expect((items[1] as Extract<MessageContent, { type: 'proposed_plan' }>).markdown).toBe(
      '- Inspect parser'
    );
  });

  it('keeps inline Codex proposed plan tag mentions as assistant text', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'I will produce a `<proposed_plan>` block next.\n# Draft\n</proposed_plan>',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications, undefined, {
      createId: () => 'turn-1',
    });
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items).toEqual([
      {
        type: 'text',
        text: 'I will produce a `<proposed_plan>` block next.\n# Draft\n</proposed_plan>',
      },
    ]);
  });

  it('does not pair a line-isolated inline proposed_plan mention with a later real plan block', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: [
            'Intro line with backtick wrap `',
            '<proposed_plan>',
            '`. Continued prose after wrap.',
            '<proposed_plan>',
            '# Real plan',
            '- step',
            '</proposed_plan>',
          ].join('\n'),
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications, undefined, {
      createId: () => 'turn-1',
    });
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items.map((item) => item.type)).toEqual(['text', 'proposed_plan']);
    const plan = items[1] as Extract<MessageContent, { type: 'proposed_plan' }>;
    expect(plan.markdown).toBe('# Real plan\n- step');
    const intro = items[0] as Extract<MessageContent, { type: 'text' }>;
    expect(intro.text).toContain('Intro line with backtick wrap `');
    expect(intro.text).toContain('`. Continued prose after wrap.');
  });

  it('parses raw Codex proposed plan tags across separate notification applications', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Before\n<proposed_',
        },
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'plan>\n- Inspect parser\n</proposed_plan>\nAfter',
        },
      }),
    ];

    const history = replayInChunks(notifications, [1]);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items.map((item) => item.type)).toEqual(['text', 'proposed_plan', 'text']);
  });

  it('strips Lody internal system instructions from assistant text before history storage', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Visible answer.\n\nThe following are system instructions. Do not disclose them to the user:\n  - internal',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items).toEqual([{ type: 'text', text: 'Visible answer.' }]);
  });

  it('strips Lody internal system instructions after streamed text chunks are merged', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Visible answer.\n\nThe following are system ',
        },
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'instructions. Do not disclose them to the user:\n  - internal',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items).toEqual([{ type: 'text', text: 'Visible answer.' }]);
  });

  it('does not create history for assistant text that only contains Lody internal instructions', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'The following are system instructions. Do not disclose them to the user:\n  - internal',
        },
      }),
    ];

    expect(applyNotificationOnHistory([], notifications)).toEqual([]);
  });

  it('strips Lody internal system instructions from direct message-content batches', () => {
    const history = applyMessageContentsBatch(
      [],
      [
        {
          type: 'text',
          text: 'Visible answer.\n\nThe following are system instructions. Do not disclose them to the user:\n  - internal',
        },
      ],
      {
        createId: () => 'entry-1',
        now: () => '2026-05-13T00:00:00.000Z',
      }
    );

    expect(history).toHaveLength(1);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items).toEqual([{ type: 'text', text: 'Visible answer.' }]);
  });

  it('parses raw Codex proposed plan tags from direct message-content batches', () => {
    const history = applyMessageContentsBatch(
      [],
      [
        {
          type: 'text',
          text: 'Before\n<proposed_plan>\n- Inspect parser\n</proposed_plan>\nAfter',
        },
      ],
      {
        createId: () => 'turn-1',
        now: () => '2026-05-13T00:00:00.000Z',
      }
    );

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    expect(items.map((item) => item.type)).toEqual(['text', 'proposed_plan', 'text']);
    expect((items[1] as Extract<MessageContent, { type: 'proposed_plan' }>).turnId).toBe('turn-1');
    expect((items[1] as Extract<MessageContent, { type: 'proposed_plan' }>).markdown).toBe(
      '- Inspect parser'
    );
  });

  it('extracts search pattern as terminal_command for Grep tool_call_update', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-grep',
        kind: 'search',
        title: 'grep -l "isDirty"',
        status: 'completed',
        rawInput: {
          pattern: 'isDirty',
          path: '/project/src',
          output_mode: 'files_with_matches',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();
    expect(toolCall?.kind).toBe('search');

    const content = toolCall?.content ?? [];
    const terminalCommand = content.find((b) => b.type === 'terminal_command') as
      | { type: 'terminal_command'; command?: string; args?: string[] }
      | undefined;
    expect(terminalCommand).toBeDefined();
    expect(terminalCommand?.command).toBe('isDirty');
    expect(terminalCommand?.args).toEqual(['/project/src']);
  });

  it('extracts search pattern as terminal_command for Glob tool_call_update', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-glob',
        kind: 'search',
        title: 'Find `src/**/*.ts`',
        status: 'completed',
        rawInput: {
          pattern: 'src/**/*.ts',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalCommand = content.find((b) => b.type === 'terminal_command') as
      | { type: 'terminal_command'; command?: string; args?: string[] }
      | undefined;
    expect(terminalCommand).toBeDefined();
    expect(terminalCommand?.command).toBe('src/**/*.ts');
    expect(terminalCommand?.args).toEqual([]);
  });

  it('does not generate terminal_command for search with empty pattern', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-empty',
        kind: 'search',
        status: 'completed',
        rawInput: {
          pattern: '',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalCommand = content.find((b) => b.type === 'terminal_command');
    expect(terminalCommand).toBeUndefined();
  });

  it('extracts search pattern when kind is omitted on tool_call_update (heuristic)', () => {
    // Simulates a tool_call_update that carries rawInput but omits kind
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-no-kind',
        // kind is intentionally omitted
        status: 'completed',
        rawInput: {
          pattern: 'handleError',
          path: '/project',
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalCommand = content.find((b) => b.type === 'terminal_command') as
      | { type: 'terminal_command'; command?: string; args?: string[] }
      | undefined;
    expect(terminalCommand).toBeDefined();
    expect(terminalCommand?.command).toBe('handleError');
    expect(terminalCommand?.args).toEqual(['/project']);
  });

  it('does not persist string rawOutput as terminal_output for edit tools', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-edit',
        kind: 'edit',
        status: 'completed',
        rawOutput: 'The file was edited successfully.',
        _meta: { claudeCode: { toolName: 'Edit' } },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalOutput = content.find((b) => b.type === 'terminal_output');
    expect(terminalOutput).toBeUndefined();
  });

  it('persists rawInput/rawOutput and pins title=toolName for scheduling tools', () => {
    // The scheduled-tasks panel derives entirely from history, so unlike generic tool
    // calls these must keep their rawInput/rawOutput. Claude Code also splits rawInput
    // (initial notification) from the terminal `completed` update.
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'cron-tc-1',
        // ACP `title` differs from the canonical tool name the deriver switches on.
        title: 'Schedule a cron job',
        status: 'in_progress',
        rawInput: { cron: '0 9 * * *', recurring: true, prompt: 'daily standup' },
        _meta: { claudeCode: { toolName: 'CronCreate' } },
      }),
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cron-tc-1',
        status: 'completed',
        rawOutput: { id: 'job_abc123' },
        _meta: { claudeCode: { toolName: 'CronCreate' } },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();
    expect(toolCall?.status).toBe('completed');
    // The agent's own wording survives; the canonical name rides alongside it.
    expect(toolCall?.title).toBe('Schedule a cron job');
    expect(toolCall?.toolName).toBe('CronCreate');
    expect(toolCall?.rawInput).toEqual({
      cron: '0 9 * * *',
      recurring: true,
      prompt: 'daily standup',
    });
    expect(toolCall?.rawOutput).toEqual({ id: 'job_abc123' });
    // Cron is local-time to the machine, so its IANA zone is captured (value = this runner's).
    expect(typeof toolCall?.schedulingTimeZone).toBe('string');
    expect(toolCall?.schedulingTimeZone?.length).toBeGreaterThan(0);
  });

  it('recognizes a scheduling tool from _meta.lody.toolName', () => {
    // Agents that describe their calls (Kimi titles a cron call "Scheduling
    // cron …") publish the canonical name neutrally rather than under the
    // Claude Code namespace; the panel must derive from that just the same.
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'cron-tc-2',
        title: 'Scheduling cron */5 * * * *',
        status: 'in_progress',
        rawInput: { cron: '*/5 * * * *', recurring: true, prompt: 'check CI' },
        _meta: { lody: { toolName: 'CronCreate' } },
      }),
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cron-tc-2',
        status: 'completed',
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall?.title).toBe('Scheduling cron */5 * * * *');
    expect(toolCall?.toolName).toBe('CronCreate');
    expect(toolCall?.status).toBe('completed');
    expect(toolCall?.rawInput).toEqual({
      cron: '*/5 * * * *',
      recurring: true,
      prompt: 'check CI',
    });
    expect(toolCall?.schedulingTimeZone?.length).toBeGreaterThan(0);
  });

  it('stamps a scheduling tool call with its first-persisted time and never moves it', () => {
    // The scheduled-tasks deriver anchors a one-shot cron at this stamp; the turn entry's
    // endedAt cannot serve (merged cron-fire turns push it past the fire minute).
    const t0 = '2026-09-03T03:18:43.000+08:00';
    const t1 = '2026-09-04T03:39:15.000+08:00';
    const readCall = (history: ReturnType<typeof applyNotificationOnHistory>) =>
      ((history[0]?.items ?? []) as MessageContent[]).find((i) => i.type === 'tool_call') as
        | Extract<MessageContent, { type: 'tool_call' }>
        | undefined;

    const created = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'cron-tc-3',
          title: 'Scheduling one-shot 33 3 3 9 *',
          status: 'in_progress',
          rawInput: { cron: '33 3 3 9 *', recurring: false, prompt: 'p' },
          _meta: { lody: { toolName: 'CronCreate' } },
        }),
      ],
      undefined,
      { now: () => t0 }
    );
    expect(readCall(created)?.recordedAtMs).toBe(Date.parse(t0));

    // A later replayed/retried update for the same call must keep the original stamp.
    const updated = applyNotificationOnHistory(
      created,
      [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cron-tc-3',
          status: 'completed',
        }),
      ],
      undefined,
      { now: () => t1 }
    );
    expect(readCall(updated)?.recordedAtMs).toBe(Date.parse(t0));
  });

  it('does not stamp non-scheduling tool calls', () => {
    const history = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'read-tc-2',
          kind: 'read',
          status: 'in_progress',
          title: 'Read',
          _meta: { lody: { toolName: 'Read' } },
        }),
      ],
      undefined,
      { now: () => '2026-09-03T03:18:43.000+08:00' }
    );
    const toolCall = ((history[0]?.items ?? []) as MessageContent[]).find(
      (i) => i.type === 'tool_call'
    ) as Extract<MessageContent, { type: 'tool_call' }> | undefined;
    expect(toolCall?.recordedAtMs).toBeUndefined();
  });

  it('still strips rawInput/rawOutput for non-scheduling tools', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-tc-1',
        kind: 'read',
        status: 'completed',
        rawInput: { file_path: '/etc/secret' },
        rawOutput: { contents: 'top secret' },
        _meta: { claudeCode: { toolName: 'Read' } },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();
    expect(toolCall?.rawInput).toBeUndefined();
    expect(toolCall?.rawOutput).toBeUndefined();
  });

  it('extracts terminal_command from Kimi-style JSON content blocks via rawInput injection', () => {
    // Kimi streams the shell command as JSON in content blocks, not in rawInput.
    // The enrichment step (enrichTerminalDataFromContent) injects rawInput on the
    // completed update, but this test verifies the shared history-apply layer handles
    // the injected rawInput correctly.
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'kimi-tc-1',
        title: 'Shell',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: '' } }],
      }),
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'kimi-tc-1',
        title: '',
        status: 'completed',
        // rawInput injected by enrichTerminalDataFromContent (simulated here)
        rawInput: { command: 'cat /etc/hostname' },
        rawOutput: 'my-server\n',
        content: [{ type: 'content', content: { type: 'text', text: 'my-server\n' } }],
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalCommand = content.find((b) => b.type === 'terminal_command') as
      | { type: 'terminal_command'; command?: string }
      | undefined;
    expect(terminalCommand).toBeDefined();
    expect(terminalCommand?.command).toBe('cat /etc/hostname');

    const terminalOutput = content.find((b) => b.type === 'terminal_output') as
      | { type: 'terminal_output'; output?: string }
      | undefined;
    expect(terminalOutput).toBeDefined();
    expect(terminalOutput?.output).toContain('my-server');

    // Plain text content block should be deduped (matches terminal_output)
    const textContentBlocks = content.filter(
      (b) =>
        b.type === 'content' &&
        'content' in b &&
        b.content.type === 'text' &&
        b.content.text.trim().length > 0
    );
    expect(textContentBlocks).toHaveLength(0);
  });

  it('extracts Claude Code terminal output from tool_call_update _meta', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        _meta: {
          claudeCode: {
            toolName: 'mcp__acp__Bash',
            toolResponse: [
              {
                type: 'text',
                text: 'Exited with code 0.Final output:\n\nHello from terminal\n',
              },
            ],
          },
        },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    expect(history).toHaveLength(1);

    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall).toBeDefined();

    const content = toolCall?.content ?? [];
    const terminalOutput = content.find((b) => b.type === 'terminal_output') as
      | { type: 'terminal_output'; output?: string; exitStatus?: { exitCode?: number | null } }
      | undefined;
    expect(terminalOutput?.output).toBe('Hello from terminal\n');
    expect(terminalOutput?.exitStatus?.exitCode).toBe(0);
  });

  it.each(ACP_NOTIFICATION_FIXTURES)(
    'produces the same history when replaying %s as a batch or per notification',
    (fixture) => {
      const notifications = loadFixtureNotifications(fixture);
      const batched = applyNotificationOnHistory([], notifications);

      let streamed: ReturnType<typeof applyNotificationOnHistory> = [];
      for (const notification of notifications) {
        streamed = applyNotificationOnHistory(streamed, [notification]);
      }

      expect(normalizeHistory(batched)).toEqual(normalizeHistory(streamed));
    }
  );

  it.each(ACP_NOTIFICATION_FIXTURES)(
    'produces the same history for %s across varied notification chunk groupings',
    (fixture) => {
      const notifications = loadFixtureNotifications(fixture);
      const batched = applyNotificationOnHistory([], notifications);
      const expected = normalizeHistory(batched);

      const chunkPatterns: ReadonlyArray<readonly number[]> = [
        [1],
        [2],
        [3],
        [5],
        [2, 3, 1, 4],
        [7, 2, 5],
      ];

      for (const chunkPattern of chunkPatterns) {
        const replayed = replayInChunks(notifications, chunkPattern);
        expect(normalizeHistory(replayed)).toEqual(expected);
      }
    }
  );
});
