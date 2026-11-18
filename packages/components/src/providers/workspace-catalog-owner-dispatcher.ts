import {
  WorkspaceCatalogError,
  type WorkspaceCatalogReader,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogObservation,
  type WorkspaceCatalogUpdate,
} from '@lody/shared';

type Backend = { reader: WorkspaceCatalogReader; commands: WorkspaceCatalogCommands };
/** A stable logical observer crosses the planned legacy -> frozen -> native handoff. */
export function createWorkspaceCatalogOwnerDispatcher(options: {
  owner(): 'legacy' | 'frozen' | 'native';
  subscribeOwner(listener: () => void): () => void;
  legacy: Backend;
  native(): Backend;
}) {
  let closed = false;
  const selected = () => {
    if (closed || options.owner() === 'frozen')
      throw new WorkspaceCatalogError(
        'restart_required',
        'Workspace catalog maintenance in progress'
      );
    return options.owner() === 'native' ? options.native() : options.legacy;
  };
  type View = { stop(): Promise<void>; changed(): void };
  const views = new Set<View>();
  const reader: WorkspaceCatalogReader = {
    async read(binding) {
      return selected().reader.read(binding);
    },
    async observe(binding, onUpdate, onError) {
      if (closed)
        throw new WorkspaceCatalogError('restart_required', 'Workspace catalog dispatcher closed');
      let stopped = false;
      let dirty = true;
      let running: Promise<void> | undefined;
      let source: WorkspaceCatalogObservation | undefined;
      let sourceOwner: string | undefined;
      let generation = 0;
      let last: WorkspaceCatalogUpdate | undefined;
      const update = () => {
        dirty = true;
        if (running) return running;
        const operation = (async () => {
          while (dirty && !stopped && !closed) {
            dirty = false;
            const owner = options.owner();
            if (sourceOwner === owner) continue;
            generation++;
            await source?.close();
            source = undefined;
            sourceOwner = undefined;
            if (owner === 'frozen') {
              if (last) onUpdate({ ...last, synced: false });
              continue;
            }
            const token = generation;
            sourceOwner = owner;
            const backend = owner === 'native' ? options.native() : options.legacy;
            source = await backend.reader.observe(
              binding,
              (value) => {
                if (!stopped && !closed && token === generation && options.owner() === owner) {
                  last = value;
                  onUpdate(value);
                }
              },
              (cause) => {
                if (!stopped && !closed && token === generation) onError(cause);
              }
            );
            if (options.owner() !== owner) dirty = true;
          }
        })();
        running = operation;
        void operation
          .finally(() => {
            if (running === operation) running = undefined;
          })
          .catch(() => {});
        return operation;
      };
      let stopping: Promise<void> | undefined;
      const view: View = {
        changed: () => {
          void update().catch(onError);
        },
        stop: () => {
          stopped = true;
          generation++;
          if (stopping) return stopping;
          const operation = (async () => {
            try {
              await running;
            } catch {}
            await source?.close();
            source = undefined;
            views.delete(view);
          })();
          stopping = operation;
          void operation.catch(() => {
            if (stopping === operation) stopping = undefined;
          });
          return operation;
        },
      };
      views.add(view);
      try {
        await update();
        return { close: view.stop };
      } catch (cause) {
        try {
          await view.stop();
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            'Catalog source acquisition and release failed'
          );
        }
        throw cause;
      }
    },
  };
  const unlisten = options.subscribeOwner(() => {
    for (const view of views) view.changed();
  });
  const commands: WorkspaceCatalogCommands = {
    execute: (binding, command, execution) =>
      selected().commands.execute(binding, command, execution),
    upload: (binding) => selected().commands.upload(binding),
  };
  return {
    reader,
    commands,
    async close() {
      closed = true;
      unlisten();
      const results = await Promise.allSettled([...views].map((view) => view.stop()));
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, 'Catalog dispatcher release failed');
    },
  };
}
