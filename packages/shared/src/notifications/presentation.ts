import { resolveSessionPullRequests } from '../session-pull-requests';
import { z } from 'zod';
import { getSessionPullRequestLegacyFields, type SessionMeta } from '../schema';
import { parseGitHubPrNumber } from '../github-url';

/** Display context only. It never determines eligibility, identity or routing. */
export const notificationPresentationSchema = z.object({
  kind: z.enum(['conversation', 'schedule']),
  conversationTitle: z.string().max(320).optional(),
  scheduleName: z.string().max(320).optional(),
  projectName: z.string().max(128).optional(),
  pullRequestNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  replyPreview: z.string().max(400).optional(),
});
export type NotificationPresentation = z.infer<typeof notificationPresentationSchema>;

/** Bound to an exact input so copied/edit-and-resent turns aren't scheduled runs. */
export const scheduleRunNotificationSourceSchema = z.object({
  scheduleId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  title: z.string().max(320),
});
export type ScheduleRunNotificationSource = z.infer<typeof scheduleRunNotificationSourceSchema>;

export function notificationLabel(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

/** Last user-facing text block of the exact completed assistant turn. */
export function notificationReplyPreview(turn: {
  role: string;
  items?: readonly unknown[];
}): string | undefined {
  if (turn.role !== 'assistant' || !turn.items) return undefined;
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index];
    if (
      !item ||
      typeof item !== 'object' ||
      !('type' in item) ||
      item.type !== 'text' ||
      !('text' in item)
    )
      continue;
    const preview = notificationLabel(item.text, 200);
    if (preview) return preview;
  }
  return undefined;
}

export function notificationProjectName(
  meta: Pick<SessionMeta, 'project' | 'repoFullName'>,
  localProjectName?: string
): string | undefined {
  const project = meta.project;
  const repo =
    project?.kind === 'github'
      ? project.repoFullName
      : project?.kind === 'local'
        ? project.githubRepoFullName
        : meta.repoFullName;
  return (
    notificationLabel(localProjectName, 64) ??
    notificationLabel(typeof repo === 'string' ? repo.split('/').pop() : undefined, 64)
  );
}

/** Prefer active PRs; preserve the association after merge/close as well. */
function notificationPullRequestNumber(
  meta: Pick<SessionMeta, 'pullRequests'>
): number | undefined {
  const prs = resolveSessionPullRequests(meta);
  const active = prs.filter((pr) => pr.status === 'open' || pr.status === 'draft');
  let latest: (typeof prs)[number] | undefined;
  for (const pr of active.length ? active : prs) {
    const timestamp = getSessionPullRequestLegacyFields(pr).reportedAt ?? '';
    const previous = getSessionPullRequestLegacyFields(latest).reportedAt ?? '';
    // Modern metadata uses array order; legacy records retain reportedAt ordering.
    if (!latest || !(timestamp || previous) || timestamp > previous) latest = pr;
  }
  if (!latest) return undefined;
  const number =
    parseGitHubPrNumber(latest.url) ?? getSessionPullRequestLegacyFields(latest).number;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
}

/** All associated inputs must agree; a mixed batch uses ordinary conversation copy. */
export function resolveNotificationPresentation(
  meta: Pick<SessionMeta, 'title' | 'project' | 'repoFullName' | 'pullRequests'>,
  inputs: readonly { id: string; scheduleRun?: unknown }[],
  localProjectName?: string
): NotificationPresentation {
  const sources = inputs.map((input) => {
    const parsed = scheduleRunNotificationSourceSchema.safeParse(input.scheduleRun);
    return parsed.success && parsed.data.turnId === input.id ? parsed.data : undefined;
  });
  const scheduled = sources[0];
  const schedule =
    scheduled && sources.every((source) => source?.scheduleId === scheduled.scheduleId)
      ? scheduled
      : undefined;
  return {
    kind: schedule ? 'schedule' : 'conversation',
    conversationTitle: notificationLabel(meta.title),
    scheduleName: notificationLabel(schedule?.title),
    projectName: notificationProjectName(meta, localProjectName),
    pullRequestNumber: notificationPullRequestNumber(meta),
  };
}

export type NotificationEvent =
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'permission'
  | 'question'
  | 'attention';

/** Shared catalog: desktop registers it with i18next; push selects each language. */
export const notificationMessages = {
  en: {
    'notifications.copy.conversation.failed': 'Execution failed',
    'notifications.copy.conversation.unknown': 'Execution interrupted',
    'notifications.copy.conversation.permission': 'Approval needed',
    'notifications.copy.conversation.question': 'Answer needed',
    'notifications.copy.conversation.attention': 'Attention needed',
    'notifications.copy.schedule.failed': 'Scheduled task failed',
    'notifications.copy.schedule.unknown': 'Scheduled task interrupted',
    'notifications.copy.schedule.permission': 'Scheduled task needs approval',
    'notifications.copy.schedule.question': 'Scheduled task needs an answer',
    'notifications.copy.schedule.attention': 'Scheduled task needs attention',
    'notifications.copy.untitled': 'Untitled conversation',
    'notifications.copy.openConversation': 'Open conversation to view details.',
  },
  zh: {
    'notifications.copy.conversation.failed': '执行失败',
    'notifications.copy.conversation.unknown': '执行中断',
    'notifications.copy.conversation.permission': '需要授权',
    'notifications.copy.conversation.question': '需要回答',
    'notifications.copy.conversation.attention': '需要处理',
    'notifications.copy.schedule.failed': '定时任务失败',
    'notifications.copy.schedule.unknown': '定时任务中断',
    'notifications.copy.schedule.permission': '定时任务需要授权',
    'notifications.copy.schedule.question': '定时任务需要回答',
    'notifications.copy.schedule.attention': '定时任务需要处理',
    'notifications.copy.untitled': '未命名对话',
    'notifications.copy.openConversation': '打开对话查看详情。',
  },
} as const;
export type NotificationCopyKey = keyof typeof notificationMessages.en;

export function formatNotification(
  event: NotificationEvent,
  presentation: NotificationPresentation | undefined,
  translate: (key: NotificationCopyKey) => string
): { title: string; body: string } {
  const status =
    event === 'succeeded'
      ? undefined
      : translate(`notifications.copy.${presentation?.kind ?? 'conversation'}.${event}`);
  const project = notificationLabel(presentation?.projectName, 64);
  const title = notificationLabel(presentation?.conversationTitle);
  const schedule =
    presentation?.kind === 'schedule' ? notificationLabel(presentation.scheduleName) : undefined;
  const pr = presentation?.pullRequestNumber;
  const reference = pr ? `PR #${pr}` : undefined;
  const context = [status, project, reference, schedule === title ? undefined : schedule]
    .filter(Boolean)
    .join(' ');
  const reply =
    event === 'succeeded' || event === 'failed' || event === 'unknown'
      ? notificationLabel(presentation?.replyPreview, 200)
      : undefined;
  return {
    title: title ?? translate('notifications.copy.untitled'),
    body:
      [context, reply].filter(Boolean).join('\n') ||
      translate('notifications.copy.openConversation'),
  };
}
