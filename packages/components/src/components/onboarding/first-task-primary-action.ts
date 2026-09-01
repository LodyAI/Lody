export type FirstTaskPrimaryAction = {
  kind: 'run' | 'enter';
  disabled: boolean;
  loading: boolean;
};

/**
 * The last onboarding action must never strand someone behind prerequisites
 * that can only be repaired from the product itself. Run the real first task
 * when it is ready; otherwise make the same button an honest way into Lody.
 */
export function getFirstTaskPrimaryAction({
  canStartFirstTask,
  hasPrompt,
  submitting,
  startFailed,
}: {
  canStartFirstTask: boolean;
  hasPrompt: boolean;
  submitting: boolean;
  startFailed: boolean;
}): FirstTaskPrimaryAction {
  const kind = submitting || (canStartFirstTask && !startFailed) ? 'run' : 'enter';
  return {
    kind,
    disabled: submitting || (kind === 'run' && !hasPrompt),
    loading: submitting,
  };
}
