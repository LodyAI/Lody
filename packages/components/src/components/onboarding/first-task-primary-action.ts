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
  startRequested,
}: {
  canStartFirstTask: boolean;
  hasPrompt: boolean;
  startRequested: boolean;
}): FirstTaskPrimaryAction {
  const kind = canStartFirstTask && hasPrompt && !startRequested ? 'run' : 'enter';
  return {
    kind,
    disabled: false,
    loading: false,
  };
}
