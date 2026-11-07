export type SteerReceipt = {
  targetId: string;
  state: 'confirming' | 'accepted' | 'unknown' | 'waiting' | 'rejected';
};

/** Display-only evidence. Never writes inferred relationships into shared history. */
export function executionProjection(
  raw: any[],
  live: boolean,
  receipts: ReadonlyMap<string, SteerReceipt> = new Map(),
) {
  const result = new Map<
    string,
    {
      executionId?: string;
      executionFinished?: boolean;
      steerCount?: number;
      delivery?: SteerReceipt['state'];
      holdOpen?: boolean;
    }
  >();
  const users = new Map(
    raw.filter((e) => e.role === 'user').map((e) => [e.id, e]),
  );
  const assistants = raw.filter((e) => e.role === 'assistant');
  for (const entry of users.values()) {
    const receipt = receipts.get(entry.id);
    const intent =
      entry.status === 'pending_apply' ||
      entry.inputConfig?._lodyDeliveryKind === 'steer';
    const targetId = receipt?.targetId ?? entry.inputConfig?._lodySteerTarget;
    if (receipt || intent) {
      let delivery = receipt?.state ?? 'confirming';
      if (
        ['processing', 'handled'].includes(entry.status) ||
        assistants.some((e) => e.userTurnId === entry.id)
      )
        delivery = 'accepted';
      if (entry.status === 'pending' && receipt?.state !== 'accepted')
        delivery = 'waiting';
      result.set(entry.id, { delivery });
      if (
        targetId &&
        ['confirming', 'unknown', 'accepted'].includes(delivery) &&
        !raw.some((e) => e.role === 'assistant' && e.userTurnId === entry.id)
      ) {
        result.set(targetId, { ...result.get(targetId), holdOpen: true });
      }
    }
  }
  const providers = new Map<string, any[]>();
  for (const entry of raw) {
    if (
      entry.role !== 'assistant' ||
      typeof entry.acpTurnId !== 'string' ||
      !entry.acpTurnId ||
      !users.has(entry.userTurnId)
    )
      continue;
    const group = providers.get(entry.acpTurnId) ?? [];
    group.push(entry);
    providers.set(entry.acpTurnId, group);
  }
  const interrupts = new Map<string, any[]>();
  const roots = new Map<string, string>();
  for (const entry of assistants) {
    const input = users.get(entry.userTurnId)?.inputConfig;
    const target = assistants.find((e) => e.id === input?._lodySteerTarget);
    if (
      input?._lodySteerMode !== 'interrupt' ||
      input?._lodyDeliveryKind !== 'steer' ||
      !target ||
      assistants.indexOf(target) >= assistants.indexOf(entry) ||
      users.get(target.userTurnId)?.status !== 'canceled'
    )
      continue;
    const root = roots.get(target.id) ?? target.id;
    const group = interrupts.get(root) ?? [target];
    group.push(entry);
    roots.set(entry.id, root);
    interrupts.set(root, group);
  }
  for (const segments of [...providers.values(), ...interrupts.values()]) {
    if (segments.length < 2) continue;
    // Equality of the provider turn plus delivered steer provenance proves a
    // continuation. Adjacency, timestamps, or a pre-written marker alone do not.
    const root = segments[0].userTurnId;
    const guides = segments.slice(1).map((e) => users.get(e.userTurnId));
    if (
      !guides.every(
        (u) =>
          u.inputConfig?._lodyDeliveryKind === 'steer' &&
          (['processing', 'handled'].includes(u.status) ||
            (u.status === 'canceled' &&
              u.inputConfig?._lodySteerMode === 'interrupt')),
      )
    )
      continue;
    if (new Set(segments.map((e) => e.userTurnId)).size !== segments.length)
      continue;
    const last = segments.at(-1)!;
    const finished =
      live &&
      segments.every(
        (e) => e.finished === true && !result.get(e.id)?.holdOpen,
      ) &&
      users.get(last.userTurnId)?.status === 'handled' &&
      !segments.some((e) =>
        (e.items ?? []).some(
          (i: any) =>
            i.name === 'chat_failed' || i.permissionRequest?.outcome === null,
        ),
      );
    for (const entry of segments) {
      for (const id of [entry.id, entry.userTurnId]) {
        result.set(id, {
          ...result.get(id),
          executionId: root,
          executionFinished: finished,
          steerCount: guides.length,
        });
      }
    }
  }
  return result;
}
