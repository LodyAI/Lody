const errorKeys: Record<string, string> = {
  workspace_transfer_not_owner: 'workspace.transfer.errors.notOwner',
  workspace_transfer_invalid_member: 'workspace.transfer.errors.invalidMember',
  workspace_transfer_deleting: 'workspace.transfer.errors.deleting',
  workspace_transfer_billing_owner_mismatch: 'workspace.transfer.errors.support',
  workspace_transfer_contact_support: 'workspace.transfer.errors.support',
  workspace_transfer_billing_busy: 'workspace.transfer.errors.billingBusy',
  workspace_transfer_active_subscription: 'workspace.transfer.errors.activeSubscription',
  workspace_transfer_payment_required: 'workspace.transfer.errors.paymentRequired',
  workspace_transfer_free_limit: 'workspace.transfer.errors.freeLimit',
};

/** Native bridges may wrap a structured cloud error; expose only recognized advice. */
export function workspaceTransferErrorKey(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const data = 'data' in current ? current.data : undefined;
    const code =
      data && typeof data === 'object' && 'code' in data
        ? data.code
        : 'code' in current
          ? current.code
          : undefined;
    if (typeof code === 'string' && Object.hasOwn(errorKeys, code)) return errorKeys[code];
    // Electron/mobile IPC can retain the message while dropping custom properties.
    if ('message' in current && typeof current.message === 'string') {
      const code = current.message.match(/\b(?:e2ee_)?(workspace_transfer_[a-z_]+)\b/)?.[1];
      if (code && Object.hasOwn(errorKeys, code)) return errorKeys[code];
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
