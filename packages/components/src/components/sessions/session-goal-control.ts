import { SESSION_GOAL_COMMANDS, type SessionGoalCommand } from '@lody/shared';

const NO_GOAL_COMMANDS: readonly SessionGoalCommand[] = [];

/**
 * Commands supported by Lody's current `/goal …` prompt bridge.
 *
 * Provider-neutral goal snapshots are displayable for every ACP agent, but the
 * prompt bridge itself is Codex-specific. Other providers remain read-only until
 * Lody routes their advertised `_session/goal` extension method.
 */
export const getPromptBridgeGoalCommands = (
  agentType: string | null | undefined
): readonly SessionGoalCommand[] =>
  agentType === 'codex' ? SESSION_GOAL_COMMANDS : NO_GOAL_COMMANDS;

export const canPauseGoalThroughPromptBridge = (
  agentType: string | null | undefined
): boolean => getPromptBridgeGoalCommands(agentType).includes('pause');

/**
 * Slash `/goal …` commands must never route through steer/guide submit paths.
 * Steer rejects slash input ("Slash commands cannot steer an active Codex turn")
 * and Stop's `/goal pause` side-effect would wedge the session when queued
 * message behavior is set to Steer.
 */
export const GOAL_PROMPT_DISPATCH_OPTIONS = { forceDirect: true as const };

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
