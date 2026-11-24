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
import { CoordinatorProactiveCard } from '../src/components/project-mode/coordinator-action-bar';
import { CoordinatorObservabilityHeaderButton } from '../src/components/project-mode/coordinator-observability-panel';
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

  it('dismisses a proactive action card on click and omits already-dismissed cards on mount', async () => {
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
          onExecuteAction: () => undefined,
          onDismiss: () => {
            dismissedCount += 1;
          },
        })
      );
    });

    const dismissBtn = container!.querySelector<HTMLButtonElement>(
      '[data-coordinator-card-dismiss]'
    );
    expect(dismissBtn).not.toBeNull();

    await act(async () => {
      dismissBtn!.click();
    });

    expect(dismissedCount).toBe(1);
    const cardEl = container!.querySelector('[data-coordinator-proactive-card]');
    expect(cardEl?.hasAttribute('data-coordinator-card-dismissed')).toBe(true);

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        React.createElement(CoordinatorProactiveCard, {
          card: { ...sampleCard, isDismissed: true },
          onExecuteAction: () => undefined,
          onDismiss: () => undefined,
        })
      );
    });

    expect(container!.querySelector('[data-coordinator-proactive-card]')).toBeNull();
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
});
