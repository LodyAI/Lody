import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import type { MessageContent } from '../src/ai';

import {
  MAX_STORED_TERMINAL_COMMAND_BYTES,
  MAX_STORED_TERMINAL_OUTPUT_BYTES,
  applyNotificationOnHistory,
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
  it('preserves phase boundaries across batches, tags, and legacy metadata', () => {
    const chunk = (text: string, meta?: object) =>
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(meta ? { _meta: meta } : {}),
      });
    const notifications = [
      chunk('Checking ', { lody: { messagePhase: 'commentary' } }),
      chunk('now', { lody: { messagePhase: 'commentary' } }),
      chunk('<thinking>reason</thinking>\nDone', { codex: { phase: 'final_answer' } }),
      chunk(' unphased'),
      chunk(' invalid', { lody: { messagePhase: 'unknown' } }),
    ];
    for (const sizes of [[1], [5], [2, 3]]) {
      expect(replayInChunks(notifications, sizes)[0]?.items).toEqual([
        { type: 'text', text: 'Checking now', messagePhase: 'commentary' },
        { type: 'thought', text: 'reason' },
        { type: 'text', text: '\nDone', messagePhase: 'final_answer' },
        { type: 'text', text: ' unphased invalid' },
      ]);
    }
  });

  it('replaces sparse ACP tool lists, preserves omitted fields, and clears explicit empty lists', () => {
    const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } });
    const updates = [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'sparse',
        title: 'Lookup',
        kind: 'other',
        status: 'in_progress',
        content: [text('old')],
        locations: [{ path: '/old' }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sparse',
        content: [text('new')],
        locations: [{ path: '/new' }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'sparse', status: 'completed' },
    ].map(makeNotification);
    for (const chunkSizes of [[1], [3]]) {
      const history = replayInChunks(updates, chunkSizes);
      expect(history[0]?.items).toEqual([
        expect.objectContaining({
          toolCallId: 'sparse',
          title: 'Lookup',
          kind: 'other',
          status: 'completed',
          content: [text('new')],
          locations: [{ path: '/new' }],
        }),
      ]);
      const cleared = applyNotificationOnHistory(history, [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'sparse',
          content: [],
          locations: [],
        }),
      ]);
      expect(cleared[0]?.items).toEqual([
        expect.objectContaining({
          title: 'Lookup',
          kind: 'other',
          status: 'completed',
          content: [],
          locations: [],
        }),
      ]);
    }
  });

  it('uses the previous tool kind and Core name when sparse updates omit them', () => {
    const history = replayInChunks(
      [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'read',
          title: 'Read',
          kind: 'read',
          status: 'in_progress',
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read',
          content: [{ type: 'content', content: { type: 'text', text: 'private file body' } }],
          rawOutput: 'private file body',
          status: 'completed',
        }),
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'cron',
          title: 'CronCreate',
          kind: 'other',
          status: 'in_progress',
          _meta: { lody: { toolName: 'CronCreate' } },
          rawInput: { cron: '* * * * *', prompt: 'synthetic reminder' },
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cron',
          status: 'completed',
          rawOutput: { id: 'job' },
        }),
      ],
      [1]
    );
    expect(JSON.stringify(history)).not.toContain('private file body');
    expect(history[0]?.items).toEqual([
      expect.objectContaining({ toolCallId: 'read', kind: 'read', status: 'completed' }),
      expect.objectContaining({
        toolCallId: 'cron',
        toolName: 'CronCreate',
        rawInput: { cron: '* * * * *', prompt: 'synthetic reminder' },
        rawOutput: { id: 'job' },
      }),
    ]);
  });

  it('stores ACP markdown plans beside their mode-switch card without duplicating updates', () => {
    const plan = (content: string) =>
      makeNotification({
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', planId: '1:submit_plan', content },
        _meta: { lody: { turnId: '0' } },
      });
    const history = applyNotificationOnHistory(
      [],
      [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: '1:submit_plan',
          title: 'ExitPlanMode',
          kind: 'switch_mode',
          status: 'in_progress',
        }),
        plan('# Draft'),
        plan('# Final plan\n\n- Verify the adapter.'),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: '1:submit_plan',
          status: 'completed',
        }),
      ]
    );
    expect(history).toHaveLength(1);
    const items = history[0]!.items as unknown as MessageContent[];
    expect(items.filter((item) => item.type === 'proposed_plan')).toEqual([
      {
        type: 'proposed_plan',
        turnId: '1:submit_plan',
        markdown: '# Final plan\n\n- Verify the adapter.',
        status: 'delta',
        isLatest: true,
      },
    ]);
    expect(items.find((item) => item.type === 'tool_call')).toMatchObject({
      toolCallId: '1:submit_plan',
      kind: 'switch_mode',
      status: 'completed',
    });
  });

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

  it('stores at most 1 KiB of a command that inlines a base64 image', () => {
    const base64 = 'iVBORw0KGgo'.repeat(40_000);
    const storedTool = (rawInput: Record<string, unknown>, title?: string) => {
      const history = applyNotificationOnHistory(
        [],
        [
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'inline-image',
            kind: 'execute',
            status: 'completed',
            title,
            rawInput,
          }),
        ]
      );
      return ((history[0]?.items ?? []) as unknown as MessageContent[]).find(
        (item) => item.type === 'tool_call'
      ) as Extract<MessageContent, { type: 'tool_call' }>;
    };
    const commandOf = (rawInput: Record<string, unknown>) =>
      storedTool(rawInput).content?.find((block) => block.type === 'terminal_command') as {
        command: string;
        args?: string[];
        truncated?: boolean;
      };
    const storedBytes = (block: { command: string; args?: string[] }) =>
      [block.command, ...(block.args ?? [])].reduce(
        (sum, part) => sum + new TextEncoder().encode(part).byteLength,
        0
      );

    const claude = commandOf({ command: `echo ${base64} | base64 -d > out.png` });
    expect(claude.command.startsWith(`echo ${base64.slice(0, 100)}`)).toBe(true);
    expect(claude.command.endsWith('…')).toBe(true);
    expect(claude.truncated).toBe(true);
    expect(storedBytes(claude)).toBeLessThanOrEqual(MAX_STORED_TERMINAL_COMMAND_BYTES);

    // Codex puts the script in args: `bash -lc <script>` shares the same budget.
    const codex = commandOf({ command: ['bash', '-lc', `echo ${base64}`, 'trailing'] });
    expect(codex.command).toBe('bash');
    expect(codex.args).toHaveLength(2);
    expect(codex.args?.[0]).toBe('-lc');
    expect(codex.args?.[1]?.endsWith('…')).toBe(true);
    expect(codex.truncated).toBe(true);
    expect(commandOf({ command: 'ls -la' }).truncated).toBeUndefined();
    expect(storedBytes(codex)).toBeLessThanOrEqual(MAX_STORED_TERMINAL_COMMAND_BYTES);

    // Claude's adapter titles a Bash call with the command itself.
    const command = `echo ${base64} | base64 -d > out.png`;
    const title = storedTool({ command }, command).title ?? '';
    expect(title.startsWith('echo iVBORw0KGgo')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(new TextEncoder().encode(title).byteLength).toBeLessThanOrEqual(
      MAX_STORED_TERMINAL_COMMAND_BYTES
    );
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

  it('stores Pi bash results as terminal output with their line breaks', () => {
    // Pi reports a shell result as `{ content, details }` and mirrors it, and
    // every streamed partial snapshot, as plain text content blocks.
    const command = 'echo one; echo two';
    const output = '  774  -  com.apple.quicklook\n==== two ====\nline 2\n';
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'pi-bash-1',
        title: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command },
      }),
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'pi-bash-1',
        title: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command },
        content: [
          { type: 'content', content: { type: 'text', text: '  774  -  com.apple.quicklook\n' } },
        ],
      }),
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'pi-bash-1',
        title: 'bash',
        kind: 'execute',
        status: 'completed',
        rawInput: { command },
        rawOutput: { content: [{ type: 'text', text: output }], details: {} },
        content: [{ type: 'content', content: { type: 'text', text: output } }],
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    const content = toolCall?.content ?? [];

    expect(content.find((b) => b.type === 'terminal_command')).toMatchObject({ command });
    const outputs = content.filter((b) => b.type === 'terminal_output');
    expect(outputs).toEqual([expect.objectContaining({ output })]);
    expect(content.filter((b) => b.type === 'content')).toHaveLength(0);
  });

  it('keeps a Pi result off terminal output for non-shell tools', () => {
    const notifications = [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'pi-edit-1',
        title: 'edit',
        kind: 'edit',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'Edited a.ts' }], details: {} },
      }),
    ];

    const history = applyNotificationOnHistory([], notifications);
    const items = (history[0]?.items ?? []) as unknown as MessageContent[];
    const toolCall = items.find((i) => i.type === 'tool_call') as
      | Extract<MessageContent, { type: 'tool_call' }>
      | undefined;
    expect(toolCall?.content?.some((b) => b.type === 'terminal_output') ?? false).toBe(false);
  });

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

  describe('devin subagent internals', () => {
    const started = (agentId: string) =>
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: agentId,
        status: 'in_progress',
        _meta: {
          'cognition.ai/subagent_started': { agentId, title: `Task ${agentId}` },
        },
      });
    const context = (parentAgentId: string) => ({
      'cognition.ai/subagent_context': { parentAgentId },
    });

    it('suppresses subagent output once its task row exists, on live and replayed batches', () => {
      const notifications = [
        started('agent-1'),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'internal' },
          _meta: context('agent-1'),
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'visible' },
        }),
      ];
      for (const history of [
        applyNotificationOnHistory([], notifications),
        replayInChunks(notifications, [1]),
      ]) {
        const items = (history[0] as { items?: MessageContent[] }).items ?? [];
        expect(items).toEqual([
          expect.objectContaining({ type: 'subagent_task', taskId: 'agent-1' }),
          { type: 'text', text: 'visible' },
        ]);
      }
    });

    it('keeps context-tagged output when no task row names the owner', () => {
      const history = applyNotificationOnHistory(
        [],
        [
          makeNotification({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'unknown-owner' },
            _meta: context('never-started'),
          }),
        ]
      );
      const items = (history[0] as { items?: MessageContent[] }).items ?? [];
      expect(items).toEqual([{ type: 'text', text: 'unknown-owner' }]);
    });

    it('suppresses a subagent tool call but merges updates into a permission-written row', () => {
      const seeded = applyNotificationOnHistory(
        [],
        [
          makeNotification({
            sessionUpdate: 'tool_call',
            toolCallId: 'approved-tool',
            title: 'Approved tool',
            status: 'pending',
          }),
          started('agent-1'),
        ]
      );
      const history = applyNotificationOnHistory(seeded, [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: 'silent-tool',
          title: 'Silent tool',
          status: 'in_progress',
          _meta: context('agent-1'),
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'approved-tool',
          status: 'completed',
          _meta: context('agent-1'),
        }),
      ]);
      const items = (history[0] as { items?: MessageContent[] }).items ?? [];
      expect(items).toEqual([
        expect.objectContaining({
          type: 'tool_call',
          toolCallId: 'approved-tool',
          status: 'completed',
        }),
        expect.objectContaining({ type: 'subagent_task', taskId: 'agent-1' }),
      ]);
    });

    it('materializes a tagged nested lifecycle row with parentTaskId', () => {
      const history = applyNotificationOnHistory(
        [],
        [
          started('parent'),
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'child',
            status: 'in_progress',
            _meta: {
              ...context('parent'),
              'cognition.ai/subagent_started': { agentId: 'child', title: 'Nested' },
            },
          }),
        ]
      );
      const items = (history[0] as { items?: MessageContent[] }).items ?? [];
      expect(items).toEqual([
        expect.objectContaining({ type: 'subagent_task', taskId: 'parent' }),
        expect.objectContaining({
          type: 'subagent_task',
          taskId: 'child',
          parentTaskId: 'parent',
        }),
      ]);
    });

    it('passes tagged updates carrying an unrecognized subagent payload through', () => {
      const history = applyNotificationOnHistory(
        [],
        [
          started('agent-1'),
          makeNotification({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'new-protocol' },
            _meta: { ...context('agent-1'), 'cognition.ai/subagent_future': { x: 1 } },
          }),
        ]
      );
      const items = (history[0] as { items?: MessageContent[] }).items ?? [];
      expect(items).toContainEqual({ type: 'text', text: 'new-protocol' });
    });

    it('keeps a completed task terminal when a started row replays late', () => {
      const history = applyNotificationOnHistory(
        [],
        [
          started('agent-1'),
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'agent-1',
            status: 'completed',
            _meta: {
              'cognition.ai/subagent_completed': { agentId: 'agent-1', summary: 'done' },
            },
          }),
          started('agent-1'),
        ]
      );
      const items = (history[0] as { items?: MessageContent[] }).items ?? [];
      expect(items).toEqual([
        expect.objectContaining({
          type: 'subagent_task',
          taskId: 'agent-1',
          status: 'completed',
          summary: 'done',
        }),
      ]);
    });
  });
});
