// One process-wide gate across every workspace. Reserve synchronously before
// any turn initialization await so an idle update cannot race a starting turn.
let reservations = 0;
let paused = false;
// Set while a forced update drains this process, so cancelled turns record why.
let interruption: 'machine_update' | undefined;
export function reserveMachineTurn(): (() => void) | null {
  if (paused) return null;
  reservations++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      reservations--;
    }
  };
}
export function pauseMachineTurnsIfIdle(): boolean {
  if (reservations !== 0) return false;
  paused = true;
  return true;
}
export function resumeMachineTurns(): void {
  paused = false;
  interruption = undefined;
}

export function pauseMachineTurnsForUpdate(): void {
  paused = true;
  interruption = 'machine_update';
}

export function machineTurnInterruptionReason(): 'machine_update' | undefined {
  return interruption;
}
