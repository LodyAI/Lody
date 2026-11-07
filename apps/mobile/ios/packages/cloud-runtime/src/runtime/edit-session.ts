type RecordValue = Record<string, any>;

function inputBlock(item: RecordValue): RecordValue {
  const fields: Record<string, string[]> = {
    image: [
      'imageId',
      'mimeType',
      'fileName',
      'sizeBytes',
      'width',
      'height',
      'storageSessionId',
    ],
    file: [
      'fileId',
      'fileName',
      'mimeType',
      'sizeBytes',
      'sha256',
      'textPreview',
      'sourcePath',
      'transport',
      'machineId',
      'uploadedAt',
      'storageSessionId',
    ],
    comment_reference: [
      'source',
      'path',
      'lineNumber',
      'side',
      'commentBody',
      'authorName',
      'authorImage',
      'replies',
      'turnId',
      'mode',
      'threadId',
      'githubThreadId',
    ],
    visual_annotation_reference: [
      'source',
      'commentId',
      'turnId',
      'body',
      'authorName',
      'status',
      'anchor',
    ],
  };
  return Object.fromEntries(
    ['type', ...fields[item.type]]
      .filter((key) => item[key] != null)
      .map((key) => [key, item[key]]),
  );
}

export function editableUserTurn(
  history: RecordValue[],
  meta: RecordValue,
  capability?: RecordValue,
) {
  if (
    meta.isArchived ||
    meta.autoReview ||
    meta.cliType !== 'builtin' ||
    !['codex', 'claude'].includes(meta.agentType)
  )
    return;
  const goal =
    history
      .flatMap((entry) => entry.items ?? [])
      .findLast((item) => item?.type === 'goal') ?? meta.latestGoal;
  if (goal?.status === 'active') return;
  const index = history.findLastIndex((entry) => entry.role === 'user');
  const turn = history[index];
  if (
    !turn ||
    ['pending_apply', 'delivery_unknown'].includes(turn.status) ||
    turn.inputConfig?._lodyDeliveryKind === 'steer'
  )
    return;
  for (let previous = index - 1; previous >= 0; previous--) {
    const entry = history[previous];
    if (entry.role === 'user') return;
    if (entry.role !== 'assistant') continue;
    if (
      entry.finished !== true ||
      typeof entry.acpTurnId !== 'string' ||
      !entry.acpTurnId ||
      capability?.provenance !== 'runtime' ||
      capability.sessionFork !== true
    )
      return;
    break;
  }
  return turn;
}

export function editAttachments(
  turn: RecordValue,
): (RecordValue & { type: 'image' | 'file'; editId: string })[] {
  return (turn.items ?? [])
    .flatMap((item: RecordValue) => {
      if (item.type === 'image_group') return item.images ?? [];
      if (item.type === 'image' || item.type === 'file') return [item];
      return [];
    })
    .map((item: RecordValue, index: number) => ({
      ...inputBlock({ ...item, type: item.type ?? 'image' }),
      editId: `original:${index}`,
    }));
}

export function replacementInput(
  turn: RecordValue,
  text: string,
  retainedIds: string[],
  added: RecordValue[],
) {
  if (
    typeof text !== 'string' ||
    text.length > 32000 ||
    !Array.isArray(retainedIds) ||
    !Array.isArray(added)
  )
    throw new Error('invalid_message');
  const original = editAttachments(turn);
  if (
    added.some(
      (item) =>
        !item ||
        !['image', 'file'].includes(item.type) ||
        typeof item[item.type === 'image' ? 'imageId' : 'fileId'] !==
          'string' ||
        !item[item.type === 'image' ? 'imageId' : 'fileId'] ||
        typeof item.mimeType !== 'string' ||
        !Number.isInteger(item.sizeBytes) ||
        item.sizeBytes <= 0 ||
        (item.type === 'file' &&
          (item.transport !== 'r2' ||
            typeof item.sha256 !== 'string' ||
            typeof item.fileName !== 'string' ||
            typeof item.textPreview !== 'boolean' ||
            typeof item.uploadedAt !== 'number')),
    )
  )
    throw new Error('invalid_attachment');
  if (
    new Set(retainedIds).size !== retainedIds.length ||
    retainedIds.some((id) => !original.some((item) => item.editId === id))
  )
    throw new Error('invalid_attachment');
  const attachments = [
    ...original
      .filter((item) => retainedIds.includes(item.editId))
      .map(({ editId, ...item }) => item),
    ...added,
  ];
  if (
    attachments.length > 16 ||
    attachments.filter((item) => item.type === 'image').length > 8 ||
    attachments.filter((item) => item.type === 'file').length > 8
  )
    throw new Error('attachment_limit');
  if (!text.trim() && !attachments.length) throw new Error('empty_message');
  return {
    ...turn.inputConfig,
    prompt: text.trim(),
    inputBlocks: [
      ...(text.trim() ? [{ type: 'text', text: text.trim() }] : []),
      ...attachments,
      ...(turn.items ?? [])
        .filter((item: RecordValue) =>
          ['comment_reference', 'visual_annotation_reference'].includes(
            item.type,
          ),
        )
        .map(inputBlock),
    ],
  };
}
