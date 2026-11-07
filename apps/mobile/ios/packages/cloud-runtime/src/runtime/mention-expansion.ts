import type {
  MentionCatalog,
  MentionCategory,
  MentionItem,
} from '../models/mentions';

// Explicit session/Role IDs survive native text-only draft restoration and
// renames. Quoted file references own their text, including any dollar signs.
const referencePattern =
  /@"(?:\\.|[^"\\])*"|(^|\s)(\$[^\s$@]+|@session:[^\s@]+|@role:[^\s@]+(?:@[^\s@]+)?)(?=\s|$)/g;

function categoryOf(token: string): MentionCategory {
  if (token.startsWith('$')) return 'skill';
  if (token.startsWith('@session:')) return 'session';
  return 'role';
}

export async function expandMentions(
  text: string,
  load: (category: MentionCategory) => Promise<MentionCatalog>,
): Promise<string> {
  const categories = new Set<MentionCategory>();
  for (const match of text.matchAll(referencePattern)) {
    if (match[2]) categories.add(categoryOf(match[2]));
  }
  try {
    const catalogs = await Promise.all([...categories].map(load));
    // A partial skill scan can hide the project override of a global token.
    if (catalogs.some((catalog) => catalog.incomplete || catalog.truncated))
      throw new Error('mention_catalog_incomplete');
    const items = catalogs.flatMap((catalog) => catalog.items);
    for (const match of text.matchAll(referencePattern))
      if (
        match[2]?.startsWith('@role:') &&
        !items.some((item) => item.insertText === match[2])
      )
        throw new Error('role_unavailable');
    return expandMentionText(text, items);
  } catch {
    throw new Error('mention_expansion_failed');
  }
}

export function expandMentionText(
  text: string,
  items: readonly MentionItem[],
): string {
  const byToken = new Map<string, MentionItem>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    if (!item.insertText) continue;
    if (byToken.has(item.insertText)) ambiguous.add(item.insertText);
    byToken.set(item.insertText, item);
  }
  // One pass over the original text: expansion text is never re-interpreted.
  return text.replace(
    referencePattern,
    (whole, space: string, token: string, offset: number) => {
      if (!token) return whole;
      const item = byToken.get(token);
      if (!item) return whole;
      if (ambiguous.has(token)) throw new Error('ambiguous_mention');
      if (
        item.kind === 'skill' &&
        /^\s*\[Skill Path\]\(/.test(text.slice(offset + whole.length))
      )
        return whole;
      return space + mentionPrompt(item);
    },
  );
}

export function mentionPrompt(item: MentionItem): string {
  if (item.kind === 'session')
    return `use lody mcp to query session[id: ${item.path}] history`;
  if (item.kind === 'role') {
    const [id, machineId] = item.path.split('@');
    const name = item.roleName ?? item.name;
    if (machineId)
      return `use lody mcp to create a session with agent role[id: ${id}, agentRoleMachineId: ${machineId}, name: ${name}]`;
    return `use lody mcp to create a session with agent role[id: ${id}, name: ${name}]`;
  }
  if (item.kind === 'skill') {
    const destination = item.path.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    const token =
      item.insertText?.slice(1) ?? item.name.trim().replace(/\s+/g, '-');
    return `use /${token} [Skill Path](${destination})`;
  }
  return item.insertText ?? `@${item.path}`;
}
