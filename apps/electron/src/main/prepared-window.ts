import type { BrowserWindow } from 'electron'
import {
  IPC_PUSH_CHANNELS,
  type ElectronWindowTarget,
  type PreparedWindowTarget
} from '@lody/shared/electron-ipc'

/** One target-bound spare. Until claimed it retains hidden-spare lifetime. */
export class PreparedWindow {
  readonly binding: PreparedWindowTarget
  ready = false
  get isClaimed(): boolean {
    return this.claimed
  }
  readonly originalThrottling: boolean
  private claimed = false
  private cancelled = false
  private expiry: ReturnType<typeof setTimeout>
  private reveal: (() => void) | undefined

  constructor(
    readonly window: BrowserWindow,
    readonly sourceId: number,
    public requestId: string,
    target: ElectronWindowTarget,
    private readonly onDispose: () => void
  ) {
    this.originalThrottling = window.webContents.getBackgroundThrottling()
    this.binding = { ...target, preparationId: crypto.randomUUID() }
    this.expiry = setTimeout(() => this.dispose(), 30_000)
    this.expiry.unref?.()
    window.webContents.setBackgroundThrottling(false)
    window.on('resize', this.invalidateViewport)
    window.once('closed', () => this.dispose())
  }

  private invalidateViewport = (): void => {
    this.ready = false
  }

  renew(requestId: string): void {
    this.requestId = requestId
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => this.dispose(), 30_000)
    this.expiry.unref?.()
  }

  fail(): void {
    if (this.claimed) this.reveal?.()
    else this.dispose()
  }

  start(): void {
    this.window.webContents.send(IPC_PUSH_CHANNELS.appPrepareWindowTarget, this.binding)
  }

  matches(target: ElectronWindowTarget): boolean {
    return (
      !this.cancelled &&
      !this.window.isDestroyed() &&
      target.workspace === this.binding.workspace &&
      target.sessionId === this.binding.sessionId
    )
  }

  update(senderId: number, raw: unknown): boolean {
    if (
      this.cancelled ||
      senderId !== this.window.webContents.id ||
      !raw ||
      typeof raw !== 'object'
    )
      return false
    const state = raw as Partial<PreparedWindowTarget> & { ready?: boolean }
    if (
      state.preparationId !== this.binding.preparationId ||
      !this.matches(state as ElectronWindowTarget) ||
      typeof state.ready !== 'boolean'
    )
      return false
    this.ready = state.ready
    if (this.ready && this.claimed) this.reveal?.()
    return true
  }

  claim(reveal: () => void): void {
    this.claimed = true
    clearTimeout(this.expiry)
    this.reveal = () => {
      this.reveal = undefined
      clearTimeout(this.expiry)
      this.window.removeListener('resize', this.invalidateViewport)
      reveal()
      if (!this.window.isDestroyed())
        this.window.webContents.send(IPC_PUSH_CHANNELS.appActivatePreparedWindow, this.binding)
    }
    if (this.ready) this.reveal()
    else this.expiry = setTimeout(() => this.reveal?.(), 5000)
  }

  cancel(sourceId: number, requestId: string): void {
    if (this.claimed || this.sourceId !== sourceId || this.requestId !== requestId) return
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => this.dispose(), 2000)
    this.expiry.unref?.()
  }

  dispose(): void {
    if (this.cancelled) return
    this.cancelled = true
    clearTimeout(this.expiry)
    this.reveal = undefined
    this.window.removeListener('resize', this.invalidateViewport)
    this.onDispose()
    if (!this.claimed && !this.window.isDestroyed()) this.window.destroy()
  }
}
