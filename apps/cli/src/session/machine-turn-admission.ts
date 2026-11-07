// One process-wide gate across every workspace. Reserve synchronously before
// any turn initialization await so an idle update cannot race a starting turn.
let reservations = 0;
let paused = false;
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
}

export function pauseMachineTurns(): void {
  paused = true;
}
