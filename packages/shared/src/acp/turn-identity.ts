/** Autonomous id prefix stamped on engine-opened turns (`auto:<engineTurnId>`). */
const AUTONOMOUS_TURN_ID_PREFIX = 'auto:';

/** Whether an ACP turn id names a turn opened by the agent engine. */
export const isAutonomousTurnId = (turnId: string): boolean =>
  turnId.startsWith(AUTONOMOUS_TURN_ID_PREFIX);
