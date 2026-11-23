import { atom } from 'jotai';
import { atomEffect } from 'jotai-effect';
import type { ElectronCliState, MachineId } from '@lody/shared';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';

export type LocalProbeResult = {
  ok: boolean;
  machineId?: string;
  workspaceId?: string;
  pid?: number;
  cliVersion?: string;
  homeDir?: string;
};

/** Local desktop CLI identity, when the Electron shell has one available. */
export const localProbeResultAtom = atom<LocalProbeResult | null>(null);

/**
 * Presentation only: retains the desktop machine's position during CLI outages.
 * Never use this identity to authorize or route local operations.
 */
export const lastKnownLocalMachineIdAtom = atom<MachineId | null>(null);

/**
 * Has local desktop CLI identity resolution completed at least once?
 * Non-Electron renderers resolve immediately with no local machine.
 */
export const localProbeAttemptedAtom = atom<boolean>(false);

/** Electron's Run local agent setting; `null` means the first read is pending. */
export const localAgentEnabledAtom = atom<boolean | null>(null);

/**
 * Is the local desktop CLI still booting — reachable, but not yet able to serve
 * local-project control requests (list files, list dir, read file, git state, …)?
 *
 * The CLI reports its `machineId` — which flips callers onto the IPC fast-path —
 * while it is still booting (auth / sync-time / fleet-start), but its
 * per-workspace runtimes only exist once `startupStage` reaches `'ready'` (see
 * `apps/cli/src/lib/lody-fleet.ts`). Firing control requests before then makes
 * the CLI answer `workspace_runtime_unavailable`, which the Electron IPC handler
 * re-throws as a noisy main-process error. Callers should hold off (show a
 * loading state) while this is true rather than send-and-fail during startup.
 *
 * It clears to `false` once the CLI is ready AND once it is terminally down
 * (stopped / fatal / offline) — a stuck or crashed CLI must surface its normal
 * error instead of hanging on a spinner forever.
 *
 * Defaults to `true` (assume starting until the first CLI state arrives): child
 * component effects can run before `localProbeEffectAtom` is mounted by the
 * runtime provider, so a `false` default would let a caller fire one request in
 * that gap before we know the CLI isn't ready. Non-Electron / non-IPC callers
 * are unaffected — the gate only applies on the local IPC fast-path.
 */
export const localCliStartingAtom = atom<boolean>(true);

function hasBrowserWindow(): boolean {
  return typeof window !== 'undefined';
}

function isElectronRenderer(): boolean {
  return hasBrowserWindow() && window.__LODY_ELECTRON__ === true;
}

function getElectronHomeDir(): string | null {
  return isElectronRenderer() ? (window.__LODY_PLATFORM__?.homeDir ?? null) : null;
}

function getMachineIdFromCliState(state: ElectronCliState): MachineId | null {
  const machineId = state.runtime?.machineId;
  if (typeof machineId !== 'string') return null;
  const trimmed = machineId.trim();
  return trimmed ? (trimmed as MachineId) : null;
}

function getLocalProbeResultFromCliState(state: ElectronCliState): LocalProbeResult | null {
  if (!state.localAgentEnabled) return null;
  const machineId = getMachineIdFromCliState(state);
  if (!machineId) return null;
  return {
    ok: true,
    machineId,
    homeDir: getElectronHomeDir() ?? undefined,
  };
}

/**
 * The fleet's per-workspace runtimes only exist after `startupStage === 'ready'`.
 * "Starting" means the CLI is alive and progressing toward that — but not there
 * yet — so control requests should wait. Once ready we stop holding; once the
 * process is terminally down (`offline`/`fatal`/`stopped`) we also stop holding
 * so the normal error path can run instead of spinning forever.
 */
function isLocalCliRuntimeStarting(state: ElectronCliState): boolean {
  if (!state.localAgentEnabled) return false;
  if (state.startupStage === 'ready') return false;
  return (
    state.phase === 'starting' ||
    state.phase === 'running' ||
    state.phase === 'degraded' ||
    state.phase === 'reconnecting'
  );
}

/** Derived: machineId of the locally running CLI, or null */
export const localMachineIdAtom = atom<MachineId | null>((get) => {
  const result = get(localProbeResultAtom);
  if (result?.machineId) return result.machineId as MachineId;
  return null;
});

/** Derived: home directory of the locally running CLI, or null */
export const localHomeDirAtom = atom<string | null>((get) => {
  const result = get(localProbeResultAtom);
  if (result?.homeDir) return result.homeDir;
  return getElectronHomeDir();
});

/** Effect: mirror Electron CLI state into renderer atoms without browser localhost probing. */
export const localProbeEffectAtom = atomEffect((_get, set) => {
  if (!hasBrowserWindow() || !isElectronRenderer()) {
    set(lastKnownLocalMachineIdAtom, null);
    set(localProbeResultAtom, null);
    set(localProbeAttemptedAtom, true);
    set(localAgentEnabledAtom, false);
    set(localCliStartingAtom, false);
    return undefined;
  }

  if (!getIpcServices()) {
    set(lastKnownLocalMachineIdAtom, null);
    set(localProbeResultAtom, null);
    set(localProbeAttemptedAtom, true);
    set(localAgentEnabledAtom, false);
    set(localCliStartingAtom, false);
    return undefined;
  }

  let cancelled = false;
  const applyState = (state: ElectronCliState) => {
    if (cancelled) return;
    const machineId = getMachineIdFromCliState(state);
    if (!state.localAgentEnabled) set(lastKnownLocalMachineIdAtom, null);
    else if (machineId) set(lastKnownLocalMachineIdAtom, machineId);
    set(localAgentEnabledAtom, state.localAgentEnabled);
    set(localProbeResultAtom, getLocalProbeResultFromCliState(state));
    set(localProbeAttemptedAtom, true);
    set(localCliStartingAtom, isLocalCliRuntimeStarting(state));
  };

  sendIpc('cli.subscribe', null);
  void getIpcServices()!
    .cli.getState()
    .then(applyState)
    .catch(() => {
      if (cancelled) return;
      set(localProbeResultAtom, null);
      set(localProbeAttemptedAtom, true);
      set(localAgentEnabledAtom, false);
      set(localCliStartingAtom, false);
    });
  const unsubscribe = onIpcEvent('cli.state', applyState);

  return () => {
    cancelled = true;
    unsubscribe();
  };
});
