import {
  COORDINATOR_CARD_DISMISSED_ACTION_ID,
  COORDINATOR_LINKED_SESSIONS_MAX_COUNT,
  createCoordinatorReplyRef,
  extractActionLinkedSessionIds,
  extractLinkedSessionIdsFromText,
  formatCoordinatorAnchorId,
  formatCoordinatorReplyContextBlock,
  isCoordinatorCardStaleFromChildActivity,
  matchUserMessageToOpenCoordinatorCards,
  normalizeCoordinatorActionResolutions,
  normalizeCoordinatorActionSpecs,
  normalizeCoordinatorProactiveCard,
  normalizeSessionTurnInputConfig,
  parseCoordinatorAnchorId,
  parseThreadRootsScalar,
  type CoordinatorAnchorRef,
  type CoordinatorReplyRef,
  type OpenCoordinatorCardCandidate,
  type OperationCompletionContent,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionHistoryReader, SessionTurn } from '@lody/shared/session-data';

const MAX_RELATED_THREAD_TURN_READS = 16;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function extractUserTurnPlainText(turn: SessionTurn): string {
  const parts: string[] = [];
  for (const item of turn.items ?? []) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
      parts.push(item.text.trim());
    }
  }
  if (parts.length > 0) return parts.join('\n\n');
  const config = normalizeSessionTurnInputConfig(turn.inputConfig);
  return config?.prompt?.trim() ?? '';
}

function collectTurnLinkedSessionIds(
  turn: SessionTurn,
  targetBubbleId?: string,
  targetThreadRootId?: string
): SessionId[] {
  const out: SessionId[] = [];
  const seen = new Set<string>();
  const push = (id: SessionId | undefined) => {
    if (!id || seen.has(id) || out.length >= COORDINATOR_LINKED_SESSIONS_MAX_COUNT) return;
    seen.add(id);
    out.push(id);
  };

  for (const item of turn.items ?? []) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    if (item.type === 'coordinator_message') {
      if (targetBubbleId && item.id !== targetBubbleId) continue;
      if (
        !targetBubbleId &&
        targetThreadRootId &&
        isRecord(item.replyTo) &&
        item.replyTo.threadRootId !== targetThreadRootId &&
        formatCoordinatorAnchorId({
          kind: 'coordinator_bubble',
          turnId: turn.id,
          bubbleId: String(item.id ?? ''),
        }) !== targetThreadRootId
      ) {
        continue;
      }
      if (Array.isArray(item.linkedSessionIds)) {
        for (const id of item.linkedSessionIds) {
          if (typeof id === 'string' && id.trim()) push(id.trim() as SessionId);
        }
      }
      if (typeof item.body === 'string') {
        for (const id of extractLinkedSessionIdsFromText(item.body)) push(id);
      }
      if (isRecord(item.card)) {
        const normalizedCard = normalizeCoordinatorProactiveCard(item.card);
        if (normalizedCard) {
          if (normalizedCard.summary) {
            for (const id of extractLinkedSessionIdsFromText(normalizedCard.summary)) push(id);
          }
          for (const id of extractActionLinkedSessionIds(normalizedCard.actions)) push(id);
        }
      }
      if (Array.isArray(item.actions)) {
        for (const id of extractActionLinkedSessionIds(
          normalizeCoordinatorActionSpecs(item.actions)
        )) {
          push(id);
        }
      }
    } else if (item.type === 'operation_progress') {
      if (
        targetThreadRootId &&
        typeof item.originThreadId === 'string' &&
        item.originThreadId !== targetThreadRootId
      ) {
        continue;
      }
      if (Array.isArray(item.items)) {
        for (const progressItem of item.items) {
          if (
            isRecord(progressItem) &&
            isRecord(progressItem.target) &&
            typeof progressItem.target.sessionId === 'string'
          ) {
            push(progressItem.target.sessionId as SessionId);
          }
        }
      }
    } else if (item.type === 'operation_completion') {
      const completionItem = item as unknown as OperationCompletionContent;
      if (
        targetThreadRootId &&
        completionItem.originThreadId &&
        completionItem.originThreadId !== targetThreadRootId
      ) {
        continue;
      }
      const resultItems =
        completionItem.completion?.type === 'result'
          ? completionItem.completion.value.items
          : completionItem.completion?.type === 'cancelled'
            ? (completionItem.completion.partial?.items ?? [])
            : [];
      for (const res of resultItems) {
        if ('target' in res && res.target?.sessionId) push(res.target.sessionId);
      }
    } else if (item.type === 'operation_completion_batch' && Array.isArray(item.members)) {
      for (const member of item.members) {
        if (!isRecord(member)) continue;
        if (
          targetThreadRootId &&
          typeof member.originThreadId === 'string' &&
          member.originThreadId !== targetThreadRootId
        ) {
          continue;
        }
        const completion = member.completion as
          | OperationCompletionContent['completion']
          | undefined;
        const resultItems =
          completion?.type === 'result'
            ? completion.value.items
            : completion?.type === 'cancelled'
              ? (completion.partial?.items ?? [])
              : [];
        for (const res of resultItems) {
          if ('target' in res && res.target?.sessionId) push(res.target.sessionId);
        }
      }
    } else if (item.type === 'text' && typeof item.text === 'string') {
      for (const id of extractLinkedSessionIdsFromText(item.text)) push(id);
    }
  }
  return out;
}

export async function readAnchorSnapshotFromHistory(
  history: SessionHistoryReader,
  anchor: CoordinatorAnchorRef
): Promise<{ author: 'user' | 'coordinator'; text: string; linkedSessionIds: SessionId[] } | null> {
  const resolvedAnchor =
    anchor.kind === 'coordinator_bubble' && anchor.bubbleId.includes(':')
      ? (parseCoordinatorAnchorId(formatCoordinatorAnchorId(anchor)) ?? anchor)
      : anchor;
  const read = await history.readTurn(resolvedAnchor.turnId);
  if (read.state !== 'ready') return null;
  if (resolvedAnchor.kind === 'user_turn') {
    const text = extractUserTurnPlainText(read.turn);
    return {
      author: 'user',
      text,
      linkedSessionIds: collectTurnLinkedSessionIds(read.turn),
    };
  }
  const bubble = (read.turn.items ?? []).find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === 'coordinator_message' && item.id === resolvedAnchor.bubbleId
  );
  if (!bubble) return null;
  const body = typeof bubble.body === 'string' ? bubble.body.trim() : '';
  const cardTitle =
    isRecord(bubble.card) && typeof bubble.card.title === 'string' ? bubble.card.title.trim() : '';
  return {
    author: 'coordinator',
    text: body || cardTitle,
    linkedSessionIds: collectTurnLinkedSessionIds(read.turn, resolvedAnchor.bubbleId),
  };
}

const MAX_RECENT_CARD_SCAN_TURNS = 8;

const escapeXmlAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function resolveImplicitRelatedCardHeader(args: {
  history: SessionHistoryReader;
  workspaceId: WorkspaceId;
  userTurnId: string;
  userText: string;
  readSessionTitle?: (sessionId: SessionId) => Promise<string | undefined> | string | undefined;
  readSessionLatestUserMsgId?: (
    sessionId: SessionId
  ) => Promise<string | undefined> | string | undefined;
}): Promise<string | undefined> {
  if (!args.userText.trim()) return undefined;
  const total = await args.history.count();
  if (total === 0) return undefined;
  const windowSize = Math.min(total, MAX_RECENT_CARD_SCAN_TURNS + 4);
  const start = Math.max(0, total - windowSize);
  const directory = await args.history.readDirectory(start, windowSize);

  let targetIdx = directory.findIndex(
    (row) => (row?.turnId ?? row?.scalars?.id) === args.userTurnId
  );
  if (targetIdx < 0) {
    targetIdx = directory.length;
  }
  if (targetIdx === 0) return undefined;

  const priorTurns: SessionTurn[] = [];
  for (let i = Math.max(0, targetIdx - MAX_RECENT_CARD_SCAN_TURNS); i < targetIdx; i += 1) {
    const turnId = directory[i]?.turnId ?? directory[i]?.scalars?.id;
    if (!turnId || turnId === args.userTurnId) continue;
    const read = await args.history.readTurn(turnId);
    if (read.state === 'ready') {
      priorTurns.push(read.turn);
    }
  }
  if (priorTurns.length === 0) return undefined;

  let lastAssistantTurnId: string | undefined;
  for (let i = priorTurns.length - 1; i >= 0; i -= 1) {
    if (priorTurns[i]?.role === 'assistant') {
      lastAssistantTurnId = priorTurns[i]!.id;
      break;
    }
    if (priorTurns[i]?.role === 'user') {
      break;
    }
  }

  type RichCandidate = OpenCoordinatorCardCandidate & {
    optionLabels: string[];
  };

  let openCards: RichCandidate[] = [];
  const titleCache = new Map<string, string>();
  const getTitle = async (sid: SessionId): Promise<string | undefined> => {
    if (titleCache.has(sid)) return titleCache.get(sid);
    const loaded = (await args.readSessionTitle?.(sid))?.trim();
    if (loaded) titleCache.set(sid, loaded);
    return loaded;
  };

  for (const turn of priorTurns) {
    if (turn.role === 'assistant') {
      for (const item of turn.items ?? []) {
        if (!isRecord(item) || item.type !== 'coordinator_message') continue;
        const card = normalizeCoordinatorProactiveCard(item.card);
        if (!card) continue;
        const resolutions = normalizeCoordinatorActionResolutions(item.actionResolutions);
        const alreadyHandled =
          resolutions[COORDINATOR_CARD_DISMISSED_ACTION_ID]?.status === 'dismissed' ||
          card.actions.some((act) => {
            const st = resolutions[act.id]?.status;
            return st === 'executed' || st === 'dismissed';
          });
        if (alreadyHandled) continue;

        const bubbleId = String(item.id ?? '');
        const linkedIds = collectTurnLinkedSessionIds(turn, bubbleId);
        if (card.snapshotTurnBySession && args.readSessionLatestUserMsgId) {
          const snapshotSids = Object.keys(card.snapshotTurnBySession) as SessionId[];
          const sessionCursors = await Promise.all(
            snapshotSids.map(async (sid) => ({
              id: sid,
              latestUserMsgId: await args.readSessionLatestUserMsgId!(sid),
            }))
          );
          if (
            isCoordinatorCardStaleFromChildActivity({
              snapshotTurnBySession: card.snapshotTurnBySession,
              linkedSessions: sessionCursors,
            })
          ) {
            continue;
          }
        }
        const taskTitles: string[] = [];
        for (const sid of linkedIds) {
          const title = await getTitle(sid);
          if (title) taskTitles.push(title);
        }
        const replyToRec = isRecord(item.replyTo) ? item.replyTo : undefined;
        openCards.push({
          key: `${turn.id}\0${bubbleId}`,
          turnId: turn.id,
          bubbleId,
          threadRootId:
            typeof replyToRec?.threadRootId === 'string' ? replyToRec.threadRootId : undefined,
          isImmediatelyPrecedingTurn: turn.id === lastAssistantTurnId,
          cardTitle: card.title,
          cardSummary: card.summary,
          bubbleBody: typeof item.body === 'string' ? item.body : undefined,
          actionTexts: card.actions.flatMap((a) =>
            a.description ? [a.label, a.description] : [a.label]
          ),
          optionLabels: card.actions.map((a) => a.label),
          linkedSessionIds: linkedIds,
          taskTitles,
        });
      }
    } else if (turn.role === 'user' && openCards.length > 0) {
      const earlierConfig = normalizeSessionTurnInputConfig(turn.inputConfig);
      const earlierReply = earlierConfig?.replyTo;
      const earlierMatched = new Set(
        matchUserMessageToOpenCoordinatorCards({
          text: extractUserTurnPlainText(turn),
          replyToTargetTurnId: earlierReply?.target.turnId,
          replyToTargetBubbleId:
            earlierReply?.target.kind === 'coordinator_bubble'
              ? earlierReply.target.bubbleId
              : undefined,
          replyToThreadRootId: earlierReply?.threadRootId,
          openCards,
        })
      );
      if (earlierMatched.size > 0) {
        openCards = openCards.filter((c) => !earlierMatched.has(c.key));
      }
    }
  }

  if (openCards.length === 0) return undefined;

  const matchedKeys = matchUserMessageToOpenCoordinatorCards({
    text: args.userText,
    openCards,
  });
  if (matchedKeys.length === 0) return undefined;

  const matchedSet = new Set(matchedKeys);
  const blocks: string[] = [];
  for (const card of openCards) {
    if (!matchedSet.has(card.key)) continue;
    const anchorId = formatCoordinatorAnchorId({
      kind: 'coordinator_bubble',
      turnId: card.turnId,
      bubbleId: card.bubbleId,
    });
    const sessionLinks = (card.linkedSessionIds ?? []).map(
      (sid) => `lody://session/${sid}?workspace=${args.workspaceId}`
    );
    const attrs = [
      `card_id="${escapeXmlAttr(anchorId)}"`,
      ...(sessionLinks.length > 0
        ? [`related_sessions="${escapeXmlAttr(sessionLinks.join(','))}"`]
        : []),
    ].join(' ');
    const lines = [`<related_card_context ${attrs}>`, `Card: ${card.cardTitle}`];
    if (card.cardSummary) lines.push(`Summary: ${card.cardSummary}`);
    if (card.optionLabels.length > 0) {
      lines.push(`Suggested options: ${card.optionLabels.join(' | ')}`);
    }
    lines.push('</related_card_context>');
    blocks.push(lines.join('\n'));
  }

  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

/**
 * Builds the `<reply_context ...>` or `<related_card_context ...>` prompt header
 * for a user message inside a coordinator conversation.
 */
export async function resolveCoordinatorPromptReplyHeader(args: {
  history: SessionHistoryReader;
  workspaceId: WorkspaceId;
  userTurnId: string;
  isCoordinator?: boolean;
  readSessionTitle?: (sessionId: SessionId) => Promise<string | undefined> | string | undefined;
  readSessionLatestUserMsgId?: (
    sessionId: SessionId
  ) => Promise<string | undefined> | string | undefined;
}): Promise<string | undefined> {
  const inputRead = await args.history.readTurn(args.userTurnId);
  if (inputRead.state !== 'ready' || inputRead.turn.role !== 'user') return undefined;
  const config = normalizeSessionTurnInputConfig(inputRead.turn.inputConfig);
  const replyTo = config?.replyTo;
  if (!replyTo) {
    if (args.isCoordinator === false) return undefined;
    return await resolveImplicitRelatedCardHeader({
      history: args.history,
      workspaceId: args.workspaceId,
      userTurnId: args.userTurnId,
      userText: extractUserTurnPlainText(inputRead.turn),
      readSessionTitle: args.readSessionTitle,
      readSessionLatestUserMsgId: args.readSessionLatestUserMsgId,
    });
  }

  const targetSnapshot = await readAnchorSnapshotFromHistory(args.history, replyTo.target);
  const quotedText = targetSnapshot?.text || replyTo.previewText;

  const linkedIds = new Set<SessionId>(targetSnapshot?.linkedSessionIds ?? []);
  const rootAnchor = parseCoordinatorAnchorId(replyTo.threadRootId);

  const total = await args.history.count();
  const directory = await args.history.readDirectory(0, total);
  const matchingTurnIds: string[] = [];
  if (rootAnchor) matchingTurnIds.push(rootAnchor.turnId);
  for (let i = directory.length - 1; i >= 0; i -= 1) {
    const row = directory[i];
    const turnId = row?.turnId ?? row?.scalars?.id;
    if (!turnId || turnId === args.userTurnId) continue;
    const roots = parseThreadRootsScalar(row?.scalars?.threadRoots);
    if (roots.includes(replyTo.threadRootId)) {
      matchingTurnIds.push(turnId);
      if (matchingTurnIds.length >= MAX_RELATED_THREAD_TURN_READS) break;
    }
  }

  for (const turnId of new Set(matchingTurnIds)) {
    if (linkedIds.size >= COORDINATOR_LINKED_SESSIONS_MAX_COUNT) break;
    const turnRead = await args.history.readTurn(turnId);
    if (turnRead.state !== 'ready') continue;
    for (const id of collectTurnLinkedSessionIds(
      turnRead.turn,
      rootAnchor && rootAnchor.kind === 'coordinator_bubble' && turnId === rootAnchor.turnId
        ? rootAnchor.bubbleId
        : undefined,
      replyTo.threadRootId
    )) {
      linkedIds.add(id);
    }
  }

  const relatedSessionLinks = [...linkedIds].map(
    (id) => `lody://session/${id}?workspace=${args.workspaceId}`
  );
  return formatCoordinatorReplyContextBlock({
    threadRootId: replyTo.threadRootId,
    repliedAuthor: replyTo.author,
    quotedText,
    relatedSessionLinks,
  });
}

/**
 * Resolves the `originThreadId` to freeze on an Operation (`session_create` /
 * `session_chat`) dispatched from a coordinator turn.
 */
export async function resolveCoordinatorOperationOriginThreadId(args: {
  history: SessionHistoryReader;
  sourceTurnId: string;
  sourceReplyTo?: CoordinatorReplyRef;
  targetSessionId?: SessionId;
}): Promise<string | undefined> {
  if (args.sourceReplyTo?.threadRootId) {
    return args.sourceReplyTo.threadRootId;
  }
  const sourceRead = await args.history.readTurn(args.sourceTurnId);
  if (sourceRead.state === 'ready') {
    if (sourceRead.turn.role === 'user') {
      const config = normalizeSessionTurnInputConfig(sourceRead.turn.inputConfig);
      if (config?.replyTo?.threadRootId) return config.replyTo.threadRootId;
    } else if (sourceRead.turn.role === 'system') {
      const roots = parseThreadRootsScalar(sourceRead.turn.threadRoots);
      if (roots.length === 1) return roots[0];
    }
  }
  if (args.targetSessionId) {
    const total = await args.history.count();
    const directory = await args.history.readDirectory(0, total);
    const candidateRoots = new Set<string>();
    for (let i = directory.length - 1; i >= 0; i -= 1) {
      const row = directory[i];
      if (row?.scalars?.role !== 'system' || !row.scalars.threadRoots) continue;
      const turnId = row.turnId ?? row.scalars.id;
      if (!turnId.startsWith('operation-progress:')) continue;
      const read = await args.history.readTurn(turnId);
      if (read.state !== 'ready') continue;
      for (const item of read.turn.items ?? []) {
        if (
          isRecord(item) &&
          item.type === 'operation_progress' &&
          typeof item.originThreadId === 'string' &&
          Array.isArray(item.items) &&
          item.items.some(
            (entry) =>
              isRecord(entry) &&
              isRecord(entry.target) &&
              entry.target.sessionId === args.targetSessionId
          )
        ) {
          candidateRoots.add(item.originThreadId);
        }
      }
      if (candidateRoots.size > 1) break;
    }
    if (candidateRoots.size === 1) {
      return [...candidateRoots][0];
    }
  }
  return undefined;
}

/**
 * Resolves `replyTo` for an outbound `lody_coordinator_send_message` bubble:
 * uses an explicit `threadId` when passed (e.g. for multi-thread completion
 * batches), or automatically inherits the active turn's thread when unambiguous.
 */
export async function resolveCoordinatorOutboundReplyRef(args: {
  history: SessionHistoryReader;
  activeAssistantTurnId?: string;
  explicitThreadId?: string;
}): Promise<CoordinatorReplyRef | undefined> {
  if (args.explicitThreadId) {
    const parsed = parseCoordinatorAnchorId(args.explicitThreadId);
    if (!parsed) return undefined;
    const canonicalRootId = formatCoordinatorAnchorId(parsed);
    const snapshot = await readAnchorSnapshotFromHistory(args.history, parsed);
    return createCoordinatorReplyRef({
      target: parsed,
      existingThreadRootId: canonicalRootId,
      author: snapshot?.author ?? (parsed.kind === 'user_turn' ? 'user' : 'coordinator'),
      text: snapshot?.text ?? '',
    });
  }

  let causalTurnId: string | undefined;
  if (args.activeAssistantTurnId) {
    const assistantRead = await args.history.readTurn(args.activeAssistantTurnId);
    if (assistantRead.state === 'ready' && assistantRead.turn.userTurnId) {
      causalTurnId = assistantRead.turn.userTurnId;
    } else if (args.activeAssistantTurnId.startsWith('assistant:')) {
      causalTurnId = args.activeAssistantTurnId.slice('assistant:'.length);
    }
  }
  if (!causalTurnId) return undefined;

  const causalRead = await args.history.readTurn(causalTurnId);
  if (causalRead.state !== 'ready') return undefined;

  if (causalRead.turn.role === 'user') {
    const config = normalizeSessionTurnInputConfig(causalRead.turn.inputConfig);
    if (!config?.replyTo) return undefined;
    const text = extractUserTurnPlainText(causalRead.turn);
    return createCoordinatorReplyRef({
      target: { kind: 'user_turn', turnId: causalRead.turn.id },
      existingThreadRootId: config.replyTo.threadRootId,
      author: 'user',
      text,
    });
  }

  if (causalRead.turn.role === 'system') {
    const roots = parseThreadRootsScalar(causalRead.turn.threadRoots);
    if (roots.length !== 1) return undefined;
    const rootId = roots[0]!;
    const parsedRoot = parseCoordinatorAnchorId(rootId);
    if (!parsedRoot) return undefined;
    const snapshot = await readAnchorSnapshotFromHistory(args.history, parsedRoot);
    return createCoordinatorReplyRef({
      target: parsedRoot,
      existingThreadRootId: rootId,
      author: snapshot?.author ?? (parsedRoot.kind === 'user_turn' ? 'user' : 'coordinator'),
      text: snapshot?.text ?? '',
    });
  }

  return undefined;
}
