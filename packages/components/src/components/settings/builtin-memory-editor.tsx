import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { space } from '@lody/ui/tokens/scales.stylex';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { Dialog } from '@/ui/dialog';
import type { MachineId } from '@lody/shared';
import type { PersonalMemoryHandle } from '@lody/memory/repo';
import { MEMORY_ENTRY_PATH, type MemoryChange, type MemoryResult } from '@lody/memory';

const styles = stylex.create({
  column: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  row: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  sources: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
});

export function BuiltinMemoryEditor({
  roleId,
  machineId,
  onClose,
}: {
  roleId: string;
  machineId: MachineId;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [opened, setOpened] = useState<{ handle: PersonalMemoryHandle; runtime: typeof runtime }>();
  const handle = opened?.runtime === runtime ? opened?.handle : undefined;
  const [selected, setSelected] = useState(MEMORY_ENTRY_PATH);
  const [newPath, setNewPath] = useState('');
  const [offset, setOffset] = useState(0);
  const [sourcesOffset, setSourcesOffset] = useState(0);
  const [, refresh] = useState(0);
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let retired = false;
    let release: (() => Promise<void>) | undefined;
    setOpened(undefined);
    setStatus('loading');
    const open = async () => {
      if (!runtime?.openPersonalMemory) throw new Error('memory_unavailable');
      const opened = await runtime.openPersonalMemory(roleId, machineId);
      if (retired) {
        await opened.release();
        return;
      }
      const unsubscribe = opened.doc.subscribe(() => refresh((value) => value + 1));
      release = async () => {
        unsubscribe();
        await opened.release();
      };
      setOpened({ handle: opened, runtime });
      setStatus('saved');
    };
    void open().catch(() => {
      if (!retired) setStatus('unavailable');
    });
    return () => {
      retired = true;
      void release?.();
    };
  }, [runtime, roleId, machineId]);

  const context = () => ({
    changeId: crypto.randomUUID(),
    recordedAt: Date.now(),
    source: { actor: 'user' as const },
  });
  const save = async (result: MemoryResult<MemoryChange>) => {
    if (!handle) return;
    if (!result.ok) {
      setStatus('invalid');
      return;
    }
    setStatus('saving');
    try {
      await handle.save(result);
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };
  const list = handle?.memory.list({ offset });
  const first = handle?.memory.read({ path: selected });
  let body = first?.ok ? first.value.body : '';
  let next = first?.ok ? first.value.nextOffset : undefined;
  while (handle && next !== undefined) {
    const page = handle.memory.read({ path: selected, offset: next });
    if (!page.ok) break;
    body += page.value.body;
    next = page.value.nextOffset;
  }
  const sources = handle?.memory.provenance(selected, { offset: sourcesOffset });
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('settings.memory.builtin.title')}</Dialog.Title>
          <Dialog.Description>{t('settings.memory.builtin.localOnly')}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.column)}>
          <p role="status">{t(`settings.memory.builtin.${status}`)}</p>
          <div {...stylex.props(styles.row)}>
            {list?.ok &&
              list.value.items.map((entry) => (
                <Button
                  key={entry.path}
                  variant="ghost"
                  onClick={() => {
                    setSelected(entry.path);
                    setSourcesOffset(0);
                  }}
                >
                  {entry.path}
                </Button>
              ))}
            {offset > 0 && (
              <Button onClick={() => setOffset(0)}>{t('settings.memory.builtin.first')}</Button>
            )}
            {list?.ok && list.value.nextOffset !== undefined && (
              <Button onClick={() => setOffset(list.value.nextOffset!)}>
                {t('settings.memory.builtin.next')}
              </Button>
            )}
          </div>
          <div {...stylex.props(styles.row)}>
            <Input
              aria-label={t('settings.memory.builtin.path')}
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <Button
              disabled={!handle || !newPath}
              onClick={() => {
                if (!handle) return;
                if (handle.memory.read({ path: newPath }).ok) {
                  setSelected(newPath);
                  setNewPath('');
                  return;
                }
                const result = handle.memory.create({ path: newPath, body: '' }, context());
                void save(result);
                if (result.ok) {
                  setSelected(newPath);
                  setNewPath('');
                }
              }}
            >
              {t('settings.memory.builtin.add')}
            </Button>
          </div>
          {handle && first?.ok && (
            <>
              <strong>{selected}</strong>
              <Input
                aria-label={t('settings.memory.builtin.description')}
                value={first.value.document.description ?? ''}
                onChange={(event) => {
                  void save(
                    handle.memory.update(
                      { path: selected, description: event.target.value },
                      context()
                    )
                  );
                }}
              />
              <Textarea
                aria-label={t('settings.memory.builtin.body')}
                value={body}
                rows={12}
                onChange={(event) => {
                  void save(
                    handle.memory.update({ path: selected, body: event.target.value }, context())
                  );
                }}
              />
              {selected !== MEMORY_ENTRY_PATH && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void save(handle.memory.forget({ path: selected }, context()));
                    setSelected(MEMORY_ENTRY_PATH);
                  }}
                >
                  {t('settings.memory.builtin.delete')}
                </Button>
              )}
              <details>
                <summary>{t('settings.memory.builtin.sources')}</summary>
                <ul {...stylex.props(styles.column)}>
                  {sources?.ok &&
                    sources.value.items.map((source) => (
                      <li key={source.changeId} {...stylex.props(styles.sources)}>
                        {t(`settings.memory.builtin.${source.source.actor}`)} ·{' '}
                        {t(`settings.memory.builtin.${source.kind}`)} ·{' '}
                        <time>{new Date(source.recordedAt).toISOString()}</time>
                        {source.source.turn && (
                          <div>
                            {t('settings.memory.builtin.turn')}: {source.source.turn.sessionId} /{' '}
                            {source.source.turn.turnId}
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
                {sources?.ok && sources.value.nextOffset !== undefined && (
                  <Button onClick={() => setSourcesOffset(sources.value.nextOffset!)}>
                    {t('settings.memory.builtin.next')}
                  </Button>
                )}
              </details>
            </>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
