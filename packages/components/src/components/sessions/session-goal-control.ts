import {
  SESSION_GOAL_COMMANDS,
  type AcpCapabilityCacheEntry,
  type SessionGoalCommand,
} from '@lody/shared';

/**
 * Goal commands the session's agent actually implements.
 *
 * Read from the runtime's advertised capability rather than the agent's name:
 * goal control is an ACP extension, so any agent that advertises it gets the
 * controls, and one that does not stays read-only.
 */
export const getSessionGoalCommands = (
  capability: Pick<AcpCapabilityCacheEntry, 'goalActions'> | undefined
): readonly SessionGoalCommand[] =>
  SESSION_GOAL_COMMANDS.filter((command) => capability?.goalActions?.includes(command));

/**
 * How long a goal command may sit in its pending state before the UI stops
 * waiting.
 *
 * The command's real completion signal is the agent's own goal snapshot, and a
 * queued action legitimately waits for a running turn to drain. Without a
 * deadline a queued command would leave every goal button disabled forever,
 * which is exactly the dead-end this control plane exists to remove.
 */
export const GOAL_COMMAND_PENDING_TIMEOUT_MS = 60_000;

export type SessionPromptActivity = {
  isDispatching: boolean;
  isSessionWorking: boolean;
  /** Persistent goal state is intentionally not a prompt-activity signal. */
  isGoalActive: boolean;
};

export const isSessionPromptBusy = ({
  isDispatching,
  isSessionWorking,
}: SessionPromptActivity): boolean => isDispatching || isSessionWorking;
