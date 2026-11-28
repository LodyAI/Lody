/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import angryJson from '../src/assets/coordinator-avatar/angry.json';
import confusedJson from '../src/assets/coordinator-avatar/confused.json';
import happyJson from '../src/assets/coordinator-avatar/happy.json';
import sadJson from '../src/assets/coordinator-avatar/sad.json';
import thinkingJson from '../src/assets/coordinator-avatar/thinking.json';
import {
  resetCoordinatorAvatarPlaybackForTest,
  seedCoordinatorAvatarStreamSnapshot,
} from '../src/components/project-mode/coordinator-avatar-mood';
import {
  CoordinatorBubbleAvatar,
  loadCoordinatorAvatarMoodData,
} from '../src/components/project-mode/coordinator-bubble-avatar';
import type { SessionHistory, SessionId } from '@lody/shared';
import { CoordinatorProactiveCard } from '../src/components/project-mode/coordinator-action-bar';
import { COORDINATOR_CARD_DISMISSED_ACTION_ID } from '../src/components/project-mode/coordinator-action-engine';
import { CoordinatorConversationPreviewProvider } from '../src/components/project-mode/coordinator-conversation';
import {
  CoordinatorNeedsYouHeaderButton,
  CoordinatorNeedsYouIslandBanner,
  useCoordinatorNeedsYouController,
} from '../src/components/project-mode/coordinator-needs-you-island';
import {
  CoordinatorComposerReplyBanner,
  CoordinatorInlineQuoteChip,
} from '../src/components/project-mode/coordinator-reply-ui';
import { CoordinatorObservabilityHeaderButton } from '../src/components/project-mode/coordinator-observability-panel';
import { CoordinatorTriggersHeaderButton } from '../src/components/project-mode/coordinator-triggers-panel';
import { ProjectBoardView } from '../src/components/project-mode/project-board';
import { initI18n } from '../src/i18n';
import {
  mountCoordinatorLottieOnce,
  type CoordinatorLottieData,
} from '../src/components/project-mode/coordinator-lottie-player';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CoordinatorBubbleAvatar and vector Lottie player', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetCoordinatorAvatarPlaybackForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it.each([
    ['thinking', thinkingJson],
    ['happy', happyJson],
    ['confused', confusedJson],
    ['sad', sadJson],
    ['angry', angryJson],
  ] as const)(
    'renders %s vector Lottie frames at 32x32 and fires onComplete once',
    (_mood, raw) => {
      const host = document.createElement('div');
      let currentMs = 1000;
      let pendingFrame: ((ts: number) => void) | null = null;
      let completed = 0;

      const dispose = mountCoordinatorLottieOnce({
        container: host,
        data: raw as unknown as CoordinatorLottieData,
        size: 32,
        now: () => currentMs,
        requestFrame: (cb) => {
          pendingFrame = cb;
          return 1;
        },
        cancelFrame: () => {
          pendingFrame = null;
        },
        onComplete: () => {
          completed += 1;
        },
      });

      const svg = host.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('width')).toBe('32');
      expect(svg?.getAttribute('height')).toBe('32');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 160 160');
      expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0);
      expect(svg?.querySelectorAll('linearGradient').length).toBeGreaterThan(0);

      currentMs = 1400;
      pendingFrame?.(currentMs);
      expect(completed).toBe(0);

      currentMs = 4000;
      pendingFrame?.(currentMs);
      expect(completed).toBe(1);

      dispose();
      expect(host.querySelector('svg')).toBeNull();
    }
  );

  it('plays once on a fresh message event, returns to idle.png on completion, and stays idle on remount', async () => {
    const rafQueue: Array<(ts: number) => void> = [];
    let clockMs = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    await loadCoordinatorAvatarMoodData('happy');
    const scopeKey = 'coord-dom-test:main';
    const createdAt = Date.now();
    seedCoordinatorAvatarStreamSnapshot(scopeKey, [], true, createdAt - 100);

    await act(async () => {
      root!.render(
        React.createElement(CoordinatorBubbleAvatar, {
          scopeKey,
          bubbleKey: 'assistant:turn-1:b-happy',
          entry: { body: '测试全部通过，PR 已合并完成！' },
          createdAt,
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const avatarEl = container!.querySelector('[data-coordinator-bubble-avatar]');
    expect(avatarEl?.getAttribute('data-avatar-mood')).toBe('happy');
    expect(avatarEl?.getAttribute('data-avatar-state')).toBe('playing');
    expect(avatarEl?.querySelector('svg')).not.toBeNull();

    await act(async () => {
      clockMs += 2000;
      const next = rafQueue.pop();
      next?.(clockMs);
    });

    expect(avatarEl?.getAttribute('data-avatar-state')).toBe('idle');
    expect(avatarEl?.querySelector('svg')).toBeNull();
    const idleImg = avatarEl?.querySelector('img');
    expect(idleImg).not.toBeNull();
    expect(idleImg?.getAttribute('width')).toBe('32');
    expect(idleImg?.getAttribute('height')).toBe('32');

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        React.createElement(CoordinatorBubbleAvatar, {
          scopeKey,
          bubbleKey: 'assistant:turn-1:b-happy',
          entry: { body: '测试全部通过，PR 已合并完成！' },
          createdAt,
        })
      );
    });

    const remounted = container!.querySelector('[data-coordinator-bubble-avatar]');
    expect(remounted?.getAttribute('data-avatar-state')).toBe('idle');
    expect(remounted?.querySelector('svg')).toBeNull();
  });

  it('renders equal-hierarchy options without duplicating bubble prose and collapses into a skipped receipt when choosing Not now', async () => {
    await initI18n('zh_CN');
    let dismissedCount = 0;
    const sampleCard = {
      kind: 'next_step' as const,
      title: '10 种 Lottie 头像可离线试玩',
      summary: '水母是默认角色，可安排审核员预览或导出。',
      linkedTasks: [],
      actions: [
        {
          spec: {
            id: 'act-preview',
            label: '检查小尺寸效果',
            tone: 'primary' as const,
            intent: {
              kind: 'coordinator_prompt' as const,
              prompt: '检查小尺寸效果',
              mode: 'send' as const,
            },
          },
          dedupKey: 'act-preview',
          liveState: 'ready' as const,
          displayLabel: '检查小尺寸效果',
        },
      ],
    };

    await act(async () => {
      root!.render(
        React.createElement(CoordinatorProactiveCard, {
          card: sampleCard,
          hasBubbleBody: true,
          onExecuteAction: () => undefined,
          onDismiss: () => {
            dismissedCount += 1;
          },
        })
      );
    });

    expect(container!.textContent).not.toContain(sampleCard.title);
    expect(container!.textContent).not.toContain(sampleCard.summary);
    const optionBar = container!.querySelector('[data-coordinator-action-bar]');
    const dismissBtn = optionBar?.querySelector<HTMLButtonElement>(
      '[data-coordinator-card-dismiss]'
    );
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.textContent).toContain('暂不关注');

    await act(async () => {
      dismissBtn!.click();
    });

    expect(dismissedCount).toBe(1);
    const cardEl = container!.querySelector('[data-coordinator-proactive-card]');
    expect(cardEl?.hasAttribute('data-coordinator-card-dismissed')).toBe(true);
    expect(cardEl?.hasAttribute('data-coordinator-card-collapsed')).toBe(true);
    expect(cardEl?.textContent).toContain('已跳过');

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        React.createElement(CoordinatorProactiveCard, {
          card: { ...sampleCard, isDismissed: true },
          hasBubbleBody: true,
          onExecuteAction: () => undefined,
          onDismiss: () => undefined,
        })
      );
    });

    const persistedCardEl = container!.querySelector('[data-coordinator-proactive-card]');
    expect(persistedCardEl?.hasAttribute('data-coordinator-card-dismissed')).toBe(true);
    expect(persistedCardEl?.hasAttribute('data-coordinator-card-collapsed')).toBe(true);
  });

  it('mounts the top-right observability trigger lazily and opens the animated topology observatory on click', async () => {
    await initI18n('zh_CN');
    const history = [
      {
        id: 'u-obs-1',
        role: 'user' as const,
        timestamp: '2026-11-24T00:00:00.000Z',
        items: [{ type: 'text' as const, text: '帮我拆解前端和后端 PR' }],
      },
      {
        id: 'a-obs-1',
        role: 'assistant' as const,
        timestamp: '2026-11-24T00:00:05.000Z',
        items: [
          {
            type: 'coordinator_message' as const,
            id: 'b-obs-1',
            body: '已启动小队并挂载监听。',
          },
        ],
      },
    ];

    await act(async () => {
      root!.render(
        React.createElement(CoordinatorObservabilityHeaderButton, {
          coordinatorSessionId: 'coord-session-1',
          history,
        })
      );
    });

    const trigger = container!.querySelector<HTMLButtonElement>(
      '[data-coordinator-observability-trigger]'
    );
    expect(trigger).not.toBeNull();
    expect(document.querySelector('[data-testid="coordinator-observability-dialog"]')).toBeNull();

    await act(async () => {
      trigger!.click();
    });

    const dialog = document.querySelector('[data-testid="coordinator-observability-dialog"]');
    expect(dialog).not.toBeNull();
    const topology = dialog!.querySelector('[data-coordinator-observability-topology]');
    expect(topology).not.toBeNull();
    expect(topology!.querySelectorAll('animateMotion').length).toBeGreaterThan(0);
    expect(dialog!.textContent).toContain('Project Store');
    expect(dialog!.textContent).toContain('已启动小队并挂载监听');
  });

  it('renders standalone proposed Task Cards and overlapping avatar-style PR stacks on the refactored ProjectBoardView', async () => {
    await initI18n('zh_CN');
    const sentPrompts: string[] = [];
    const prefilledPrompts: string[] = [];
    const prs = [
      {
        url: 'https://github.com/LodyAI/Lody/pull/3270',
        repoFullName: 'LodyAI/Lody',
        number: 3270,
        status: 'open' as const,
        readiness: 'y' as const,
        state: { s: 's' as const, m: 'c' as const },
        pr: { url: 'https://github.com/LodyAI/Lody/pull/3270', status: 'open' as const },
      },
      {
        url: 'https://github.com/LodyAI/Sorbet/pull/324',
        repoFullName: 'LodyAI/Sorbet',
        number: 324,
        status: 'open' as const,
        readiness: 'y' as const,
        state: { s: 's' as const, m: 'c' as const },
        pr: { url: 'https://github.com/LodyAI/Sorbet/pull/324', status: 'open' as const },
      },
      {
        url: 'https://github.com/LodyAI/acp-extension-kimi/pull/29',
        repoFullName: 'LodyAI/acp-extension-kimi',
        number: 29,
        status: 'open' as const,
        readiness: 'y' as const,
        state: { s: 's' as const, m: 'c' as const },
        pr: {
          url: 'https://github.com/LodyAI/acp-extension-kimi/pull/29',
          status: 'open' as const,
        },
      },
      {
        url: 'https://github.com/LodyAI/acp-extension-pi/pull/39',
        repoFullName: 'LodyAI/acp-extension-pi',
        number: 39,
        status: 'open' as const,
        readiness: 'y' as const,
        state: { s: 's' as const, m: 'c' as const },
        pr: { url: 'https://github.com/LodyAI/acp-extension-pi/pull/39', status: 'open' as const },
      },
      {
        url: 'https://github.com/LodyAI/acp-extension-dsh/pull/38',
        repoFullName: 'LodyAI/acp-extension-dsh',
        number: 38,
        status: 'open' as const,
        readiness: 'y' as const,
        state: { s: 's' as const, m: 'c' as const },
        pr: { url: 'https://github.com/LodyAI/acp-extension-dsh/pull/38', status: 'open' as const },
      },
    ];

    const fakeSession = {
      id: 'sess-multi-pr',
      title: '多仓库协议统一升级',
      createdAt: '2026-11-24T00:00:00.000Z',
    } as never;

    await act(async () => {
      root!.render(
        React.createElement(ProjectBoardView, {
          board: {
            needsYou: [
              {
                workItemId: 'wi-prop-1',
                workItemTitle: '拆分认证中间件重构',
                stage: 'proposed',
                summary: '将 token 校验与会话加载拆解为独立阶段。',
                progressNote: null,
                pendingAction: '请确认是否保留旧版 Cookie 兼容路径',
                isStandalone: true,
                collaborationMode: 'delegated',
                externalRefs: [],
                members: [],
                session: null,
                bucket: 'needsYou',
                taskNumber: 1,
                createdManually: false,
                isWorking: false,
                isWaitingPermission: false,
                hasUnreadMessages: false,
                sendState: null,
                latestMessageAt: Date.parse('2026-11-24T06:00:00.000Z'),
                pullRequest: null,
                pullRequests: [],
              },
            ],
            working: [],
            review: [
              {
                workItemId: 'sess-multi-pr',
                workItemTitle: '多仓库协议统一升级',
                stage: 'review',
                summary: null,
                progressNote: '5 个仓库 PR 均已通过 CI 并处于可合并状态。',
                pendingAction: null,
                isStandalone: false,
                collaborationMode: 'delegated',
                externalRefs: [],
                members: [
                  {
                    session: fakeSession,
                    role: 'implement',
                    bucket: 'review',
                    isWorking: false,
                    isWaitingPermission: false,
                    hasUnreadMessages: false,
                    sendState: null,
                    latestMessageAt: Date.parse('2026-11-24T06:05:00.000Z'),
                    pullRequests: prs,
                  },
                ],
                session: fakeSession,
                bucket: 'review',
                taskNumber: 2,
                createdManually: false,
                isWorking: false,
                isWaitingPermission: false,
                hasUnreadMessages: false,
                sendState: null,
                latestMessageAt: Date.parse('2026-11-24T06:05:00.000Z'),
                pullRequest: prs[0]!,
                pullRequests: prs,
              },
            ],
            accepted: [],
          },
          getSessionHref: (id) => `#${id}`,
          onOpenSession: () => undefined,
          onSendCoordinatorPrompt: (prompt) => sentPrompts.push(prompt),
          onPrefillCoordinatorPrompt: (prompt) => prefilledPrompts.push(prompt),
          onAcceptTasks: () => undefined,
        })
      );
    });

    expect(container!.textContent).toContain('请确认是否保留旧版 Cookie 兼容路径');
    expect(container!.textContent).toContain('多仓库协议统一升级');
    const prStack = container!.querySelector<HTMLButtonElement>('[data-project-board-pr-stack]');
    expect(prStack).not.toBeNull();
    expect(prStack!.textContent).toContain('+1');
    expect(prStack!.textContent).toContain('5 PR');

    const buttons = [...container!.querySelectorAll('button')];
    const confirmBtn = buttons.find((b) => b.textContent?.includes('确认启动'));
    const adjustBtn = buttons.find((b) => b.textContent?.includes('调整'));
    expect(confirmBtn).toBeDefined();
    expect(adjustBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      adjustBtn!.click();
    });
    expect(sentPrompts[0]).toContain('T1 拆分认证中间件重构');
    expect(sentPrompts[0]).toContain('[workItemId=wi-prop-1]');
    expect(prefilledPrompts[0]).toContain('T1 拆分认证中间件重构');
    expect(prefilledPrompts[0]).toContain('[workItemId=wi-prop-1]');
  });

  it('opens the Coordinator Triggers & Integrations Hub with rounded brand cards and GitHub configurator', async () => {
    await initI18n('zh_CN');

    await act(async () => {
      root!.render(
        React.createElement(CoordinatorTriggersHeaderButton, {
          coordinatorSessionId: 'coord-triggers-1' as never,
          machineId: 'machine-1',
        })
      );
    });

    const triggerBtn = container!.querySelector<HTMLButtonElement>(
      '[data-coordinator-triggers-button]'
    );
    expect(triggerBtn).not.toBeNull();
    expect(triggerBtn!.textContent).toContain('触发器');

    await act(async () => {
      triggerBtn!.click();
    });

    const dialog = document.querySelector('[data-testid="coordinator-triggers-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('协调者触发器与集成');

    const scheduleCard = dialog!.querySelector<HTMLButtonElement>(
      '[data-connector-card="schedule"]'
    );
    const githubCard = dialog!.querySelector<HTMLButtonElement>('[data-connector-card="github"]');
    const linearCard = dialog!.querySelector<HTMLButtonElement>('[data-connector-card="linear"]');
    const slackCard = dialog!.querySelector<HTMLButtonElement>('[data-connector-card="slack"]');
    const gmailCard = dialog!.querySelector<HTMLButtonElement>('[data-connector-card="gmail"]');
    const webhookCard = dialog!.querySelector<HTMLButtonElement>('[data-connector-card="webhook"]');

    expect(scheduleCard?.disabled).toBe(false);
    expect(githubCard?.disabled).toBe(false);
    expect(linearCard?.disabled).toBe(true);
    expect(slackCard?.disabled).toBe(true);
    expect(gmailCard?.disabled).toBe(true);
    expect(webhookCard?.disabled).toBe(true);
    expect(linearCard?.textContent).toContain('即将推出');

    await act(async () => {
      githubCard!.click();
    });

    expect(dialog!.textContent).toContain('添加 GitHub 事件监测');
    expect(dialog!.textContent).toContain('仅总结提醒（默认）');
    expect(dialog!.textContent).toContain('允许自动创建子对话');
  });

  it('caps and ellipsizes long coordinator reply quotes so user bubbles never overflow', async () => {
    await initI18n('zh_CN');
    const longPreview =
      '三位交叉核对后的共识是：先让已经做好的八语内容在生产可访问，修掉现有死链和渲染问题，再从现有指南做三个明确的搜索主题扩展以验证自然流量转化漏斗。';
    const replyRef = {
      target: { kind: 'coordinator_bubble' as const, turnId: 'turn-1', bubbleId: 'b-1' },
      threadRootId: 'bubble:turn-1:b-1',
      author: 'coordinator' as const,
      previewText: longPreview,
    };

    let openedThreadRoot: string | null = null;
    let cleared = false;

    await act(async () => {
      root!.render(
        React.createElement(
          'div',
          { style: { width: '360px' } },
          React.createElement(CoordinatorInlineQuoteChip, {
            replyTo: replyRef,
            onOpenThread: (rootId) => {
              openedThreadRoot = rootId;
            },
          }),
          React.createElement(CoordinatorComposerReplyBanner, {
            reply: replyRef,
            onClear: () => {
              cleared = true;
            },
          })
        )
      );
    });

    const quoteChip = container!.querySelector<HTMLButtonElement>(
      '[data-coordinator-inline-quote]'
    );
    expect(quoteChip).not.toBeNull();
    expect(quoteChip!.getAttribute('title')).toBe(longPreview);
    expect(quoteChip!.textContent).toContain('协调者:');

    await act(async () => {
      quoteChip!.click();
    });
    expect(openedThreadRoot).toBe('bubble:turn-1:b-1');

    const banner = container!.querySelector('[data-coordinator-reply-banner]');
    const clearBtn = banner?.querySelectorAll('button')[1];
    await act(async () => {
      clearBtn?.click();
    });
    expect(cleared).toBe(true);
  });

  it('aggregates unresolved decisions in the Header Needs-You Dynamic Island, navigates prev/next, skips items, and submits custom replies quoting the original bubble', async () => {
    await initI18n('zh_CN');
    const jumpedTurns: string[] = [];
    const dismissedBubbles: Array<{ turnId: string; bubbleId: string }> = [];
    const submittedFeedback: Array<{
      turnId: string;
      bubbleId: string;
      bubbleBody?: string;
      feedback: string;
    }> = [];

    const initialHistory: SessionHistory[] = [
      {
        id: 'turn-q1',
        role: 'assistant',
        timestamp: '2026-11-28T10:00:00.000Z',
        finished: true,
        items: [
          {
            type: 'coordinator_message',
            id: 'b-q1',
            body: '三位交叉核对后的共识是：先让已经做好的八语内容在生产可访问，修掉现有死链和渲染问题。',
            card: {
              kind: 'decision',
              title: '八语上线策略',
              actions: [
                {
                  id: 'act-go',
                  label: '按共识推进修复',
                  tone: 'primary',
                  intent: {
                    kind: 'coordinator_prompt',
                    prompt: '按共识推进修复',
                    mode: 'send',
                  },
                },
              ],
            },
          },
        ],
      } as unknown as SessionHistory,
      {
        id: 'turn-q2',
        role: 'assistant',
        timestamp: '2026-11-28T10:05:00.000Z',
        finished: true,
        items: [
          {
            type: 'coordinator_message',
            id: 'b-q2',
            body: 'iPhone Duo 模拟器检查已通过，是否现在合并 PR？',
            card: {
              kind: 'review_ready',
              title: '合并 Duo PR',
              actions: [
                {
                  id: 'act-merge-duo',
                  label: '合并 PR',
                  tone: 'primary',
                  intent: {
                    kind: 'coordinator_prompt',
                    prompt: '合并 PR',
                    mode: 'send',
                  },
                },
              ],
            },
          },
        ],
      } as unknown as SessionHistory,
    ];

    function IslandTestHarness() {
      const [history, setHistory] = React.useState<SessionHistory[]>(initialHistory);
      const controller = useCoordinatorNeedsYouController({
        enabled: true,
        sessionId: 'coord-island-test' as SessionId,
        history,
      });
      return React.createElement(
        'div',
        null,
        React.createElement(CoordinatorNeedsYouHeaderButton, { controller }),
        React.createElement(CoordinatorNeedsYouIslandBanner, {
          controller,
          onJumpToTurn: (turnId) => {
            jumpedTurns.push(turnId);
          },
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            'data-test-apply-dismiss-q2': '',
            onClick: () => {
              setHistory((prev) =>
                prev.map((turn) =>
                  turn.id !== 'turn-q2'
                    ? turn
                    : ({
                        ...turn,
                        items: (turn.items as Array<Record<string, unknown>>).map((it) => ({
                          ...it,
                          actionResolutions: {
                            [COORDINATOR_CARD_DISMISSED_ACTION_ID]: {
                              status: 'dismissed',
                              resolvedAt: 5000,
                            },
                          },
                        })),
                      } as unknown as SessionHistory)
                )
              );
            },
          },
          'sync-dismiss'
        )
      );
    }

    await act(async () => {
      root!.render(
        React.createElement(
          CoordinatorConversationPreviewProvider,
          {
            value: {
              tasks: new Map(),
              openTask: () => undefined,
              onExecuteBubbleAction: () => undefined,
              onDismissBubbleCard: (req) => {
                dismissedBubbles.push(req);
              },
              onSubmitCardFeedback: (req) => {
                submittedFeedback.push({
                  turnId: req.turnId,
                  bubbleId: req.bubbleId,
                  bubbleBody: req.bubbleBody,
                  feedback: req.feedback,
                });
                return true;
              },
            },
          },
          React.createElement(IslandTestHarness)
        )
      );
    });

    const headerBtn = container!.querySelector<HTMLButtonElement>(
      '[data-coordinator-needs-you-btn]'
    );
    expect(headerBtn).not.toBeNull();
    expect(headerBtn!.textContent).toContain('需要你的任务');
    expect(headerBtn!.textContent).toContain('2');
    expect(container!.querySelector('[data-coordinator-needs-you-island]')).toBeNull();

    await act(async () => {
      headerBtn!.click();
    });

    const island = container!.querySelector('[data-coordinator-needs-you-island]');
    expect(island).not.toBeNull();
    expect(island!.textContent).toContain('1 / 2');
    expect(island!.querySelector('[data-coordinator-island-quote]')?.textContent).toContain(
      '三位交叉核对后的共识是：先让已经做好的八语内容在生产可访问'
    );

    const jumpBtn = Array.from(island!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('定位原文')
    );
    await act(async () => {
      jumpBtn?.click();
    });
    expect(jumpedTurns).toEqual(['turn-q1']);

    const nextBtn = island!.querySelector<HTMLButtonElement>('button[aria-label="下一个"]');
    await act(async () => {
      nextBtn!.click();
    });
    expect(island!.textContent).toContain('2 / 2');
    expect(island!.querySelector('[data-coordinator-island-quote]')?.textContent).toContain(
      'iPhone Duo 模拟器检查已通过'
    );

    const skipBtn = island!.querySelector<HTMLButtonElement>('[data-coordinator-card-dismiss]');
    await act(async () => {
      skipBtn!.click();
      container!.querySelector<HTMLButtonElement>('[data-test-apply-dismiss-q2]')!.click();
    });
    expect(dismissedBubbles).toEqual([{ turnId: 'turn-q2', bubbleId: 'b-q2' }]);
    expect(headerBtn!.textContent).toContain('1');
    expect(island!.textContent).toContain('1 / 1');

    const textarea = island!.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      valueSetter?.call(textarea, 'main 分支已经有多语言了不是吗');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      textarea!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const sendBtn = island!.querySelector<HTMLButtonElement>('button[aria-label="发送回复"]');
    expect(sendBtn?.disabled).toBe(false);
    await act(async () => {
      sendBtn!.click();
    });

    expect(submittedFeedback).toEqual([
      {
        turnId: 'turn-q1',
        bubbleId: 'b-q1',
        bubbleBody:
          '三位交叉核对后的共识是：先让已经做好的八语内容在生产可访问，修掉现有死链和渲染问题。',
        feedback: 'main 分支已经有多语言了不是吗',
      },
    ]);
  });
});
