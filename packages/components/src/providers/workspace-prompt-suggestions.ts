import { EphemeralStore } from 'loro-crdt';
import {
  PROMPT_SUGGESTION_TTL_MS,
  base64ToBytes,
  readPromptSuggestion,
  toPromptSuggestionStreamUrl,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import { EphemeralRoomTransport, type EphemeralRoomBaseOptions } from './ephemeral-room-transport';

type Options = EphemeralRoomBaseOptions & {
  resolvePlane: (machineId: MachineId) => 'local' | 'cloud' | null;
};
type Subscription = {
  machineId: MachineId;
  sessionId: SessionId;
  listener: (text: string | null) => void;
};

export class WorkspacePromptSuggestions extends EphemeralRoomTransport<EphemeralStore, Options> {
  protected readonly warnPrefix = 'WorkspacePromptSuggestions';
  protected readonly roomLabel = 'prompt suggestion room';
  private readonly subscribers = new Set<Subscription>();
  private localStore: EphemeralStore | null = null;
  private releaseLocal: (() => void) | null = null;

  attachLocal(connection: LocalLoroDataPlaneConnection): void {
    this.detachLocal();
    const store = new EphemeralStore(PROMPT_SUGGESTION_TTL_MS);
    this.localStore = store;
    const unsubscribe = connection.onMessage((message) => {
      if (message.type !== 'prompt-suggestions' || message.workspaceId !== this.options.workspaceId)
        return;
      try {
        store.apply(base64ToBytes(message.dataBase64));
      } catch {
        this.options.onWarning?.('Invalid prompt suggestion frame');
        return;
      }
      this.refreshRoutes();
    });
    this.releaseLocal = () => {
      unsubscribe();
      store.destroy();
    };
  }

  detachLocal(): void {
    this.releaseLocal?.();
    this.releaseLocal = null;
    this.localStore = null;
    this.refreshRoutes();
  }

  subscribeSession(
    machineId: MachineId,
    sessionId: SessionId,
    listener: (text: string | null) => void
  ): () => void {
    const subscription = { machineId, sessionId, listener };
    this.subscribers.add(subscription);
    this.emit(subscription);
    return () => {
      this.subscribers.delete(subscription);
    };
  }

  shouldRestartOnExternalWake(): boolean {
    const state = this.getSyncState();
    return state !== 'idle' && state !== 'synced';
  }

  refreshRoutes(): void {
    for (const subscriber of this.subscribers) this.emit(subscriber);
  }
  protected createStore(): EphemeralStore {
    return new EphemeralStore(PROMPT_SUGGESTION_TTL_MS);
  }
  protected tagStreamUrl(url: string): string {
    return toPromptSuggestionStreamUrl(url);
  }
  protected onStoreChange(): void {
    this.refreshRoutes();
  }
  protected override onJoined(): void {
    this.refreshRoutes();
  }
  private emit(subscription: Subscription): void {
    const plane = this.options.resolvePlane(subscription.machineId);
    const source = plane === 'local' ? this.localStore : plane === 'cloud' ? this.store : null;
    // TEMP prompt-suggestion-debug
    console.info('[prompt-suggestion-debug] route', {
      workspaceId: this.options.workspaceId,
      sessionId: subscription.sessionId,
      machineId: subscription.machineId,
      plane,
      hasStore: !!source,
      entries: source ? Object.keys(source.getAllStates()).length : 0,
    });
    subscription.listener(
      source
        ? readPromptSuggestion(
            source.getAllStates(),
            subscription.machineId,
            subscription.sessionId
          )
        : null
    );
  }
}
