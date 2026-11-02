import { EphemeralStoreAdaptor, EphemeralStreamCrdt } from '@loro-dev/streams-crdt/loro';
import {
  PromptSuggestionStore,
  LORO_STREAMS_BUCKET_ID,
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamsPresenceBaseUrl,
  toPromptSuggestionStreamUrl,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { CliMachineMonitorStreamsOptions } from './machine-monitor';

/** Workspace-owned advisory state, independent of prompt/history and presence lifetimes. */
export class CliPromptSuggestions {
  readonly state = new PromptSuggestionStore();
  private transport: EphemeralStreamCrdt | null = null;
  private closing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly workspaceId: WorkspaceId,
    private readonly logger: Logger
  ) {}

  attachStreams(options: CliMachineMonitorStreamsOptions): void {
    if (this.stopped || this.transport || this.closing) return;
    const adaptor = EphemeralStoreAdaptor(this.state.store);
    const transport = new EphemeralStreamCrdt({
      streamUrl: toPromptSuggestionStreamUrl(
        createLoroStreamUrl({
          bucketId: LORO_STREAMS_BUCKET_ID,
          streamId: getLoroMetaStreamId(this.workspaceId),
          baseUrl: getLoroStreamsPresenceBaseUrl(
            options.streamsBaseUrl,
            undefined,
            options.shardHostSuffix
          ),
        })
      ),
      auth: options.auth,
      // This source publishes only. Never import remote text into the local-origin snapshot.
      adaptor: { ...adaptor, applyRemoteUpdates: () => {} },
    });
    this.transport = transport;
    void transport
      .join({
        onStatusChange: (status) => {
          if (status !== 'joined' || this.transport !== transport || this.stopped) return;
          // Reconcile values produced while the optional cloud bridge was detached.
          for (const [key, value] of Object.entries(this.state.store.getAllStates())) {
            this.state.store.set(key, value);
          }
        },
      })
      .then((result) => {
        if (!result.ok && this.transport === transport && !this.stopped) {
          this.logger.warn('Prompt suggestion channel could not join');
        }
      })
      .catch(() => this.logger.warn('Prompt suggestion channel could not join'));
  }

  detachStreams(): Promise<void> {
    if (this.closing) return this.closing;
    const transport = this.transport;
    if (!transport) return Promise.resolve();
    this.closing = transport
      .disposeLegacy()
      .then(() => {
        this.transport = null;
      })
      .finally(() => {
        this.closing = null;
      });
    return this.closing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.detachStreams();
    this.state.destroy();
  }
}
