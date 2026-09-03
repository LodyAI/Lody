import type { MessageContent } from '@lody/shared';
import type { ExportAttachmentRecord, ExportSessionSummary, ExportTranscriptTurn } from './types';

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

function formatAttachmentLine(
  image: Extract<MessageContent, { type: 'image' }>,
  link?: string
): string {
  const label = image.fileName?.trim() || image.imageId;
  if (link) {
    return `![${label}](${link})`;
  }
  return `[image: ${label}]`;
}

function renderItem(item: MessageContent, attachmentLinks: Map<string, string>): string[] {
  switch (item.type) {
    case 'text':
      return item.text.trim() ? [item.text.trim()] : [];
    case 'thought':
      return item.text.trim() ? ['#### Thought', item.text.trim()] : [];
    case 'image': {
      const link = attachmentLinks.get(item.imageId);
      return [formatAttachmentLine(item, link)];
    }
    case 'image_group':
      return item.images.map((image) =>
        formatAttachmentLine({ type: 'image', ...image }, attachmentLinks.get(image.imageId))
      );
    case 'plan':
      return ['#### Plan', ...item.entries.map((entry) => `- [${entry.status}] ${entry.content}`)];
    case 'tool_call': {
      // Sealed turns may persist a skeleton without `toolCallId`/`content`;
      // its execution payload stays on the origin machine (see `ref`).
      const parts: string[] = [];
      if (typeof item.toolCallId === 'string' && item.toolCallId.trim()) {
        parts.push(`- id: \`${escapeInlineCode(item.toolCallId)}\``);
      }
      if (item.title?.trim()) {
        parts.push(`- title: ${item.title.trim()}`);
      }
      parts.push(`- status: \`${escapeInlineCode(item.status)}\``);
      if (item.kind?.trim()) {
        parts.push(`- kind: \`${escapeInlineCode(item.kind)}\``);
      }
      if (item.ref) {
        parts.push('- note: execution details stored on the origin machine');
      }
      return ['#### Tool Call', ...parts];
    }
    case 'available_commands':
      return [
        '#### Available Commands',
        ...item.commands.map((command) =>
          command.description?.trim()
            ? `- \`${escapeInlineCode(command.name)}\`: ${command.description.trim()}`
            : `- \`${escapeInlineCode(command.name)}\``
        ),
      ];
    case 'system_notice':
      return [
        '#### System Notice',
        `- name: \`${escapeInlineCode(item.name)}\``,
        ...(item.meta ? [`- meta: \`${escapeInlineCode(JSON.stringify(item.meta))}\``] : []),
      ];
    case 'worktree_script':
      return [
        '#### Worktree Script',
        `- phase: \`${escapeInlineCode(item.phase)}\``,
        `- status: \`${escapeInlineCode(item.status)}\``,
        ...item.steps.map(
          (step, index) =>
            `- step ${index + 1}: [${escapeInlineCode(step.status)}] \`${escapeInlineCode(
              step.command
            )}\``
        ),
      ];
    default:
      return [];
  }
}

export function buildTranscriptMarkdown(args: {
  session: ExportSessionSummary;
  turns: ExportTranscriptTurn[];
  attachments: ExportAttachmentRecord[];
}): string {
  const attachmentLinks = new Map<string, string>();
  for (const attachment of args.attachments) {
    if (attachment.relativePath) {
      attachmentLinks.set(attachment.imageId, attachment.relativePath);
    }
  }

  const lines: string[] = [
    `# ${args.session.title ?? args.session.sessionId}`,
    '',
    `- Session ID: \`${args.session.sessionId}\``,
    `- Agent: ${args.session.agent.type}`,
    `- Created At: ${args.session.createdAt}`,
    `- Archived: ${args.session.archived ? 'yes' : 'no'}`,
  ];

  if (args.session.repoFullName) {
    lines.push(`- Repository: ${args.session.repoFullName}`);
  }
  if (args.session.baseBranch) {
    lines.push(`- Base Branch: ${args.session.baseBranch}`);
  }
  if (args.session.branchName) {
    lines.push(`- Branch: ${args.session.branchName}`);
  }
  if (args.session.status?.type) {
    lines.push(`- Status Snapshot: \`${args.session.status.type}\``);
  }

  for (const turn of args.turns) {
    lines.push('', `## ${turn.role} · ${turn.timestamp}`, '');
    const rendered = turn.items.flatMap((item) => renderItem(item, attachmentLinks));
    if (rendered.length === 0) {
      lines.push('_No renderable content_');
      continue;
    }
    lines.push(...rendered);
  }

  return `${lines.join('\n').trim()}\n`;
}
