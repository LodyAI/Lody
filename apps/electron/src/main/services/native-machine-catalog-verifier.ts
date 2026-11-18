import { getUserShellEnvCachedLegacy } from './shell-env'
import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Semaphore } from 'effect'
import {
  runCommandOk,
  processLayer,
  ProcessReleaseFailed,
  squashProcessFailure,
  type ProcessFacadeOptions
} from '@lody/shared/node/process'
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime'
import {
  nativeMachineCatalogCandidateDigest,
  nativeMachineCatalogVerificationInputSchema,
  nativeMachineCatalogVerificationReceiptSchema
} from '@lody/shared/native-machine-catalog-verification'
import type { AgentConfigMeta, MachineCatalogBinding } from '@lody/shared'

type Options = {
  dataRoot: string
  launch(): { executable: string; entry: string }
  helperTimeoutMs?: number
  environment?: () => Promise<NodeJS.ProcessEnv>
}
export type NativeMachineCatalogVerificationRequest = {
  binding: MachineCatalogBinding
  generation: string
  candidate: AgentConfigMeta
  signal?: AbortSignal
}
const helperEnvironment = (dataRoot: string, inherited: NodeJS.ProcessEnv) => {
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ELECTRON_RUN_AS_NODE: '1',
    LODY_PLATFORM: 'local',
    LODY_DATA_DIR: dataRoot,
    // The application already owns the shell probe. A helper borrows that
    // environment; it must not spawn another shell outside its parent group.
    LODY_DISABLE_SHELL_ENV: '1'
  }
  for (const name of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LODY_AUTH_URL',
    'LODY_AUTH_SITE_URL',
    'LODY_SERVER_URL'
  ])
    delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('DYLD_')) delete env[name]
  return env
}
/** The command owns its process Scope. Even a valid receipt cannot resolve true
 * until that Scope confirms release of the helper and its contained ACP group. */
export const verifyNativeMachineCatalogCandidate = Effect.fnUntraced(function* (
  options: Options,
  request: Omit<NativeMachineCatalogVerificationRequest, 'signal'>
) {
  const timeout = options.helperTimeoutMs ?? 180_000
  const input = yield* Effect.try(() => {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid verification deadline')
    return nativeMachineCatalogVerificationInputSchema.parse({
      version: 1,
      requestId: randomUUID(),
      binding: request.binding,
      expectedGeneration: request.generation,
      candidateSha256: nativeMachineCatalogCandidateDigest(request.candidate),
      candidate: request.candidate
    })
  })
  const launch = yield* Effect.try(options.launch)
  const environment = yield* Effect.tryPromise({
    try:
      options.environment ??
      (async () => ({ ...process.env, ...((await getUserShellEnvCachedLegacy()) ?? {}) })),
    catch: () => new Error('Provider verification environment is unavailable')
  })
  const output = yield* Effect.scoped(
    runCommandOk({
      command: launch.executable,
      args: [launch.entry],
      env: helperEnvironment(options.dataRoot, environment),
      input: JSON.stringify(input),
      timeout,
      maxOutputBytes: 8192,
      requireExitedTree: true
    })
  )
  return yield* Effect.try(() => {
    const receipt = nativeMachineCatalogVerificationReceiptSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout))
    )
    if (
      receipt.requestId !== input.requestId ||
      receipt.expectedGeneration !== input.expectedGeneration ||
      receipt.candidateSha256 !== input.candidateSha256 ||
      receipt.configId !== input.candidate.id ||
      receipt.binding.accountId !== input.binding.accountId ||
      receipt.binding.workspaceId !== input.binding.workspaceId ||
      receipt.binding.machineId !== input.binding.machineId
    )
      throw new Error('Provider verification receipt binding changed')
    return receipt.verified
  })
})
export class NativeMachineCatalogVerificationFailure extends Error {
  constructor(
    readonly effectCause: Cause.Cause<unknown>,
    readonly retryCleanup: () => Promise<void>
  ) {
    super('Provider verification failed', { cause: squashProcessFailure(effectCause) })
  }
}
/** @deprecated Main Promise composition. Delete when catalog management consumes
 * the native Effect entry directly; retained failed children stay with this owner. */
export class NativeMachineCatalogVerifierLegacy {
  private readonly application
  private readonly admission = Semaphore.makeUnsafe(2)
  private readonly releases = new Map<ProcessReleaseFailed, string>()
  private readonly active = new Map<Promise<boolean>, AbortController>()
  private closed = false
  private released = false
  private closing: Promise<void> | undefined
  constructor(
    private readonly options: Options,
    private readonly platform: ProcessFacadeOptions = {}
  ) {
    this.application = makeApplicationRuntime(processLayer(platform), {
      project: (cause) => this.failure(cause),
      recover: () => this.recover()
    })
  }
  private failure(cause: Cause.Cause<unknown>) {
    return new NativeMachineCatalogVerificationFailure(cause, () => this.retryCleanup())
  }
  private recover = Effect.fnUntraced(
    function* (this: NativeMachineCatalogVerifierLegacy) {
      for (const release of [...this.releases.keys()]) {
        yield* release.retryTermination()
        this.releases.delete(release)
      }
    }.bind(this)
  )
  verify(request: NativeMachineCatalogVerificationRequest): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error('Provider verification owner is closed'))
    const scope = JSON.stringify([
      request.binding.accountId,
      request.binding.workspaceId,
      request.binding.machineId,
      request.candidate.id
    ])
    if ([...this.releases.values()].includes(scope))
      return Promise.reject(new Error('Provider verification cleanup is unconfirmed'))
    const abort = new AbortController()
    const signal = AbortSignal.any([
      abort.signal,
      ...(request.signal ? [request.signal] : []),
      ...(this.platform.signal ? [this.platform.signal] : [])
    ])
    const operation = this.application.runtime
      .runPromiseExit(
        this.admission
          .withPermits(1)(verifyNativeMachineCatalogCandidate(this.options, request))
          .pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit))
                  for (const reason of exit.cause.reasons)
                    if (Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed)
                      this.releases.set(reason.defect, scope)
              })
            )
          ),
        { signal }
      )
      .then((exit) => {
        if (Exit.isFailure(exit)) throw this.failure(exit.cause)
        return exit.value
      })
    this.active.set(operation, abort)
    void operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }
  async retryCleanup(): Promise<void> {
    if (this.released) return
    const result = await this.application.runtime.runPromiseExit(this.recover())
    if (Exit.isFailure(result)) throw this.failure(result.cause)
  }
  close(): Promise<void> {
    this.closed = true
    for (const abort of this.active.values()) abort.abort()
    if (this.closing) return this.closing
    if (this.released) return Promise.resolve()
    const operation = (async () => {
      await Promise.allSettled([...this.active.keys()])
      await this.retryCleanup()
      await this.application.closeLegacy()
      this.released = true
    })()
    this.closing = operation
    void operation.catch(() => {
      if (this.closing === operation) this.closing = undefined
    })
    return operation
  }
}
