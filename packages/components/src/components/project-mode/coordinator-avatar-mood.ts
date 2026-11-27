import type { MessageContent, SessionHistoryParsed } from '@lody/shared';

export type CoordinatorAvatarMood = 'thinking' | 'happy' | 'confused' | 'sad' | 'angry';

export type CoordinatorBubbleMoodSource = Pick<
  Extract<MessageContent, { type: 'coordinator_message' }>,
  'body' | 'card' | 'actions'
>;

export type CoordinatorAvatarSeedMessage = Pick<
  SessionHistoryParsed,
  'id' | 'role' | 'items' | 'finished' | 'endedAt'
>;

const ANGRY_PATTERN =
  /严禁|禁止|越权|密钥泄露|隐私泄露|安全漏洞|高危|破坏性|危险操作|强制拦截|死循环|崩溃循环|恶意|security\s+vulnerability|secret\s+leak|data\s+loss|unauthorized|forbidden|hard\s+block|critical\s+violation/i;

const SAD_PATTERN =
  /失败|报错|出错|未通过|挂了|崩溃|遗憾|抱歉|不好意思|无法完成|无法连接|离线|超时|回滚|被拒绝|冲突无法合并|合并受阻|异常退出|failed|failure|build\s+error|test\s+error|timed\s+out|offline|cannot\s+merge|merge\s+conflict|unfortunately|sorry/i;

const CONFUSED_PATTERN =
  /不确定|不太确定|疑惑|奇怪|矛盾|不一致|歧义|没找到|找不到|请问|需要你确认|待你确认|你希望|倾向于哪|保留哪|怎么处理|哪一个|哪种方案|是否继续|要不要|not\s+sure|unclear|ambiguous|mismatch|contradict|which\s+one|could\s+you\s+clarify|need\s+your\s+confirmation/i;

const HAPPY_PATTERN =
  /已完成|完成了|搞定|已合并|合并完成|已修复|修复完成|全部通过|测试通过|验证通过|检查通过|已就绪|可预览|可以预览|可离线试玩|已创建\s*PR|PR\s*已开|顺利|没问题|🎉|✅|all\s+tests\s+pass|merged\s+successfully|verified|ready\s+for\s+preview|ready\s+for\s+review|fixed\s+and|shipped/i;

const THINKING_PATTERN =
  /正在|排查|分析|检查|审阅|审查|派发|交给|接手|跟进|初始化|计划|方案|先看|定位|追查|梳理|汇总|investigat|analyz|dispatch|checking|reviewing|looking\s+into/i;

const POSITIVE_COMPLETION_COMMANDS = new Set([
  'github.pr_merge',
  'github.pr_mark_ready',
  'pr.merge',
  'pr.ready',
  'task.accept',
]);

/**
 * Infer the coordinator jellyfish avatar mood (`thinking`, `happy`, `confused`,
 * `sad`, or `angry`) from a coordinator bubble's Markdown text and attached card/actions.
 */
export function inferCoordinatorBubbleMood(
  entry: CoordinatorBubbleMoodSource
): CoordinatorAvatarMood {
  const parts: string[] = [];
  if (entry.body.trim()) {
    parts.push(entry.body.trim());
  }
  if (entry.card) {
    if (entry.card.title.trim()) parts.push(entry.card.title.trim());
    if (entry.card.summary?.trim()) parts.push(entry.card.summary.trim());
  }
  const combined = parts.join('\n');

  if (ANGRY_PATTERN.test(combined)) {
    return 'angry';
  }
  if (SAD_PATTERN.test(combined)) {
    return 'sad';
  }

  const trimmedBody = entry.body.trim();
  const endsWithQuestion = /[?？]\s*$/.test(trimmedBody);
  if (CONFUSED_PATTERN.test(combined) || endsWithQuestion) {
    return 'confused';
  }

  const allActions = [...(entry.card?.actions ?? []), ...(entry.actions ?? [])];
  const hasCompletionAction = allActions.some(
    (action) =>
      action.intent.kind === 'client_command' &&
      POSITIVE_COMPLETION_COMMANDS.has(action.intent.command)
  );
  if (HAPPY_PATTERN.test(combined) || hasCompletionAction) {
    return 'happy';
  }

  if (THINKING_PATTERN.test(combined)) {
    return 'thinking';
  }

  return 'thinking';
}

type StreamPlaybackScopeState = {
  mountedAtMs: number;
  seededReady: boolean;
  settledBubbleKeys: Set<string>;
};

const LIVE_BUBBLE_FRESHNESS_WINDOW_MS = 2500;
const playbackScopes = new Map<string, StreamPlaybackScopeState>();

const ensurePlaybackScope = (scopeKey: string, nowMs: number): StreamPlaybackScopeState => {
  let state = playbackScopes.get(scopeKey);
  if (!state) {
    state = {
      mountedAtMs: nowMs,
      seededReady: false,
      settledBubbleKeys: new Set<string>(),
    };
    playbackScopes.set(scopeKey, state);
  }
  return state;
};

/**
 * Mark pre-existing historical bubbles in a conversation view as settled so
 * opening a session, hydrating history, or scrolling never triggers animations.
 */
export function seedCoordinatorAvatarStreamSnapshot(
  scopeKey: string,
  messages: readonly CoordinatorAvatarSeedMessage[],
  initialWindowReady: boolean,
  nowMs: number = Date.now()
): void {
  const scope = ensurePlaybackScope(scopeKey, nowMs);
  if (scope.seededReady) {
    return;
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const isTurnFinished = message.finished === true || typeof message.endedAt === 'number';
    for (const item of message.items) {
      if (item.type !== 'coordinator_message') continue;
      const isFreshLiveBubble =
        !isTurnFinished &&
        typeof item.createdAt === 'number' &&
        item.createdAt >= scope.mountedAtMs - LIVE_BUBBLE_FRESHNESS_WINDOW_MS;
      if (!isFreshLiveBubble) {
        scope.settledBubbleKeys.add(`${message.id}:${item.id}`);
      }
    }
  }
  if (initialWindowReady) {
    scope.seededReady = true;
  }
}

/**
 * Claim one-shot Lottie playback for a newly arrived coordinator message bubble.
 * Returns `true` at most once per `(scopeKey, bubbleKey)` across the session's life;
 * historical messages, virtual-scroll remounts, and re-renders always return `false`.
 */
export function claimCoordinatorBubbleAvatarPlayback(
  scopeKey: string,
  bubbleKey: string,
  createdAt: number | undefined,
  nowMs: number = Date.now()
): boolean {
  const scope = ensurePlaybackScope(scopeKey, nowMs);
  if (scope.settledBubbleKeys.has(bubbleKey)) {
    return false;
  }
  scope.settledBubbleKeys.add(bubbleKey);
  if (typeof createdAt !== 'number') {
    return false;
  }
  return createdAt >= scope.mountedAtMs - LIVE_BUBBLE_FRESHNESS_WINDOW_MS;
}

/** Reset module-level playback tracking in unit tests. */
export function resetCoordinatorAvatarPlaybackForTest(): void {
  playbackScopes.clear();
}
