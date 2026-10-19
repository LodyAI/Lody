import { Effect, Exit, Scope } from 'effect';
import type { LoroRepo } from 'loro-repo';
import type { WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { makeWorkspaceCatalogSync, type WorkspaceCatalogSync } from './workspace-catalog-sync';

/** @deprecated Promise document-manager entry. Remove with its native consumer migration.
 * Borrows the existing Promise Repo; never creates a second Repo or storage owner.
 */
export class WorkspaceCatalogSyncLegacy {
  private readonly scope = Effect.runSync(Scope.make());
  private readonly catalog: WorkspaceCatalogSync;
  private closing?: Promise<void>;

  constructor(repo: LoroRepo, workspaceId: WorkspaceId, logger: Logger, remote: boolean) {
    this.catalog = Effect.runSync(
      Scope.provide(makeWorkspaceCatalogSync(repo, workspaceId, logger, remote), this.scope)
    );
  }

  hold(id: string): Promise<void> {
    return this.closing ? Promise.resolve() : Effect.runPromise(this.catalog.hold(id));
  }

  ready(id: string | undefined, timeoutMs: number): Promise<boolean> {
    return this.closing
      ? Promise.resolve(false)
      : Effect.runPromise(this.catalog.ready(id, timeoutMs));
  }

  close(): Promise<void> {
    return (this.closing ??= Effect.runPromise(Scope.close(this.scope, Exit.void)));
  }
}
