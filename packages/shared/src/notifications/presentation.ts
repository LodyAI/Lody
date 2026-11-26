import { resolveSessionPullRequests } from '../session-pull-requests';
import { z } from 'zod';
// Sourced from the loro-free PR meta module so the notifications barrel does
// not pull the loro-mirror graph (via `../schema`) into the renderer boot chunk.
import { getSessionPullRequestLegacyFields } from '../session-pull-request-meta';
import type { SessionMeta } from '../schema';
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
  definitionFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  manualRunKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
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
  zh_Hant: {
    'notifications.copy.conversation.failed': '執行失敗',
    'notifications.copy.conversation.unknown': '執行中斷',
    'notifications.copy.conversation.permission': '需要授權',
    'notifications.copy.conversation.question': '需要回答',
    'notifications.copy.conversation.attention': '需要處理',
    'notifications.copy.schedule.failed': '排程任務失敗',
    'notifications.copy.schedule.unknown': '排程任務中斷',
    'notifications.copy.schedule.permission': '排程任務需要授權',
    'notifications.copy.schedule.question': '排程任務需要回答',
    'notifications.copy.schedule.attention': '排程任務需要處理',
    'notifications.copy.untitled': '未命名對話',
    'notifications.copy.openConversation': '開啟對話檢視詳情。',
  },
  ja: {
    'notifications.copy.conversation.failed': '実行に失敗しました',
    'notifications.copy.conversation.unknown': '実行が中断されました',
    'notifications.copy.conversation.permission': '承認が必要です',
    'notifications.copy.conversation.question': '回答が必要です',
    'notifications.copy.conversation.attention': '確認が必要です',
    'notifications.copy.schedule.failed': 'スケジュールタスクが失敗しました',
    'notifications.copy.schedule.unknown': 'スケジュールタスクが中断されました',
    'notifications.copy.schedule.permission': 'スケジュールタスクに承認が必要です',
    'notifications.copy.schedule.question': 'スケジュールタスクに回答が必要です',
    'notifications.copy.schedule.attention': 'スケジュールタスクに確認が必要です',
    'notifications.copy.untitled': '無題の会話',
    'notifications.copy.openConversation': '会話を開いて詳細を確認してください。',
  },
  ko: {
    'notifications.copy.conversation.failed': '실행 실패',
    'notifications.copy.conversation.unknown': '실행 중단됨',
    'notifications.copy.conversation.permission': '승인 필요',
    'notifications.copy.conversation.question': '답변 필요',
    'notifications.copy.conversation.attention': '확인 필요',
    'notifications.copy.schedule.failed': '예약 작업 실패',
    'notifications.copy.schedule.unknown': '예약 작업 중단됨',
    'notifications.copy.schedule.permission': '예약 작업에 승인이 필요합니다',
    'notifications.copy.schedule.question': '예약 작업에 답변이 필요합니다',
    'notifications.copy.schedule.attention': '예약 작업에 확인이 필요합니다',
    'notifications.copy.untitled': '제목 없는 대화',
    'notifications.copy.openConversation': '대화를 열어 세부 정보를 확인하세요.',
  },
  es: {
    'notifications.copy.conversation.failed': 'Error de ejecución',
    'notifications.copy.conversation.unknown': 'Ejecución interrumpida',
    'notifications.copy.conversation.permission': 'Aprobación necesaria',
    'notifications.copy.conversation.question': 'Respuesta necesaria',
    'notifications.copy.conversation.attention': 'Atención necesaria',
    'notifications.copy.schedule.failed': 'Error en la tarea programada',
    'notifications.copy.schedule.unknown': 'Tarea programada interrumpida',
    'notifications.copy.schedule.permission': 'La tarea programada requiere aprobación',
    'notifications.copy.schedule.question': 'La tarea programada requiere una respuesta',
    'notifications.copy.schedule.attention': 'La tarea programada requiere atención',
    'notifications.copy.untitled': 'Conversación sin título',
    'notifications.copy.openConversation': 'Abre la conversación para ver los detalles.',
  },
  fr: {
    'notifications.copy.conversation.failed': 'Échec de l’exécution',
    'notifications.copy.conversation.unknown': 'Exécution interrompue',
    'notifications.copy.conversation.permission': 'Approbation requise',
    'notifications.copy.conversation.question': 'Réponse requise',
    'notifications.copy.conversation.attention': 'Attention requise',
    'notifications.copy.schedule.failed': 'Échec de la tâche planifiée',
    'notifications.copy.schedule.unknown': 'Tâche planifiée interrompue',
    'notifications.copy.schedule.permission': 'La tâche planifiée nécessite une approbation',
    'notifications.copy.schedule.question': 'La tâche planifiée nécessite une réponse',
    'notifications.copy.schedule.attention': 'La tâche planifiée nécessite votre attention',
    'notifications.copy.untitled': 'Conversation sans titre',
    'notifications.copy.openConversation': 'Ouvrez la conversation pour voir les détails.',
  },
  ru: {
    'notifications.copy.conversation.failed': 'Ошибка выполнения',
    'notifications.copy.conversation.unknown': 'Выполнение прервано',
    'notifications.copy.conversation.permission': 'Требуется подтверждение',
    'notifications.copy.conversation.question': 'Требуется ответ',
    'notifications.copy.conversation.attention': 'Требуется внимание',
    'notifications.copy.schedule.failed': 'Ошибка запланированной задачи',
    'notifications.copy.schedule.unknown': 'Запланированная задача прервана',
    'notifications.copy.schedule.permission': 'Запланированная задача требует подтверждения',
    'notifications.copy.schedule.question': 'Запланированная задача требует ответа',
    'notifications.copy.schedule.attention': 'Запланированная задача требует внимания',
    'notifications.copy.untitled': 'Безымянный диалог',
    'notifications.copy.openConversation': 'Откройте диалог, чтобы посмотреть подробности.',
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
