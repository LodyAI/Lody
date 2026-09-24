import type { SupervisorOwnership } from '@lody/cli-supervisor'
import type { LocalCliHostLease, LocalCliHostRecord } from '@lody/shared/node/local-cli-host-lease'

export type DesktopExecutionHost = {
  instanceId: string
  ownership: SupervisorOwnership
}

/** The desktop owns this lease for its lifetime; a Supervisor only borrows it. */
export function borrowDesktopExecutionHost(lease: LocalCliHostLease): DesktopExecutionHost {
  const { record } = lease
  if (record.pid !== process.pid || record.mode !== 'electron') {
    throw new Error('Desktop execution must use its own Electron Host lease')
  }
  return {
    instanceId: record.instanceId,
    ownership: {
      acquire: async (signal) => {
        signal.throwIfAborted()
        return { status: 'acquired' }
      },
      inspect: async () => record,
      // Restart, login changes and control-only mode stop Workers, not the app.
      // None of those operations may let a foreign Host acquire the endpoint.
      release: () => {}
    }
  }
}

export function describeDesktopHostConflict(record: LocalCliHostRecord | null): {
  message: string
  detail: string
} {
  if (record?.mode === 'daemon') {
    return {
      message: 'Please stop the Lody daemon before opening Nightly.',
      detail:
        'Run “lody daemon stop” in a terminal, then open Lody Nightly again. Nightly uses its own bundled local agent.'
    }
  }
  if (record?.mode === 'electron') {
    return {
      message: 'Please quit the running Lody application first.',
      detail:
        'Lody Nightly cannot share another desktop’s local agent. Quit the other application, then open Nightly again.'
    }
  }
  return {
    message: 'Another process is using the Lody local agent.',
    detail:
      'Stop the Lody command running in your terminal, or quit the application using it, then open Nightly again. No existing process was stopped.'
  }
}
