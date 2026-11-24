import { useEffect, useRef, useState } from 'react';
import { Input } from '@lody/ui/input';
import { Button } from '@lody/ui/button';
import { z } from 'zod';
import type { AttachmentItem, AttachmentSourceDescriptor } from '@lody/plugin-sdk';
import type { ComposerActionProps } from '@lody/plugin-sdk/client';
import type { PluginCallPort } from './query-bindings';
const items = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.string().optional(),
  })
);
export function AttachmentAction({
  session,
  appendToDraft,
  source,
  port,
  signal,
  renderItem,
}: ComposerActionProps & {
  source: AttachmentSourceDescriptor;
  port: PluginCallPort;
  signal: AbortSignal;
  renderItem?: (item: AttachmentItem) => React.ReactNode;
}) {
  const [query, setQuery] = useState<string | null>(null),
    [result, setResult] = useState<readonly AttachmentItem[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    setResult([]);
    setError('');
    void port
      .call('plugin/attachment-search', source.id, session, query, active)
      .then((r) => {
        if (!active.aborted) setResult(items.parse(r));
      })
      .catch((e) => {
        if (!active.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [query, session.workspaceId, session.machineId, session.sessionId, source, signal, port]);
  const resolution = useRef<AbortController | null>(null);
  useEffect(
    () => () => resolution.current?.abort(),
    [query, session.sessionId, session.machineId, session.workspaceId]
  );
  return (
    <>
      <Button onClick={() => setQuery(query === null ? '' : null)}>{source.title}</Button>
      {query !== null && (
        <>
          <Input
            aria-label={source.title}
            placeholder={source.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {result.map((item) => (
            <Button
              key={item.id}
              onClick={async () => {
                resolution.current?.abort();
                const scope = new AbortController();
                resolution.current = scope;
                const active = AbortSignal.any([signal, scope.signal]);
                try {
                  const data = await port.call(
                    'plugin/attachment-resolve',
                    source.id,
                    session,
                    item.id,
                    active
                  );
                  active.throwIfAborted();
                  const snapshot = z
                    .object({
                      title: z.string(),
                      markdown: z.string(),
                      url: z.string().optional(),
                      metadata: (source.metadataSchema ?? z.json()).optional(),
                    })
                    .parse(data);
                  appendToDraft({ kind: 'attachment', snapshot });
                  setQuery(null);
                } catch (e) {
                  if (!active.aborted) setError(String(e));
                }
              }}
            >
              {renderItem ? renderItem(item) : item.title}
            </Button>
          ))}
          {error && <span role="alert">{error}</span>}
        </>
      )}
    </>
  );
}
