import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { FileText, History, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  MEMORY_ENTRY_PATH,
  MEMORY_NAME_CHARACTERS,
  MemoryProfileSchema,
  readMemoryProfile,
  replaceMemoryProfile,
  type MemoryChange,
  type MemoryResult,
} from '@lody/memory';
import type { PersonalMemoryHandle } from '@lody/memory/repo';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { readWholeMemoryDocument } from '@/hooks/use-lody-memories';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { Field, FormMessage } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { useSettingsPane } from './settings-page-header';
import { LodyMemoryHistory } from './lody-memory-history';

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space[4] },
  layout: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    '@media (max-width: 600px)': { flexDirection: 'column' },
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    flexShrink: 0,
    width: '248px',
    paddingBlock: space[4],
    paddingInline: space[2],
    boxSizing: 'border-box',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderInlineEnd: `1px solid ${colors.separator}`,
    '@media (max-width: 600px)': {
      width: '100%',
      maxHeight: '40%',
      borderInlineEnd: 'none',
      borderBottom: `1px solid ${colors.separator}`,
    },
  },
  railTitle: { paddingInline: space[2] },
  topics: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' },
  topic: { gap: space[2], fontSize: '13px' },
  topicIcon: { flexShrink: 0, color: colors.secondaryLabel },
  addTopic: { display: 'flex', gap: space[1.5], paddingInline: space[1] },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: space[6],
    gap: space[4],
  },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
    padding: space[1],
  },
  fields: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[4] },
  topicHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  path: { fontWeight: 600, overflowWrap: 'anywhere' },
  /** Clears the corner controls. */
  detailHeader: { paddingInlineEnd: '56px' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  /** History and close share the panel's corner, above both views. */
  corner: {
    position: 'absolute',
    insetBlockStart: space[3],
    insetInlineEnd: space[3],
    zIndex: 1,
    display: 'flex',
    gap: space[1],
  },
});

/** Name and description become MEMORY.md front matter; the Agent reads them with the entry. */
export function LodyMemoryCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (memoryId: string) => void;
}) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const store = useAtomValue(activeWorkspaceRuntimeAtom)?.personalMemory;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const valid = MemoryProfileSchema.safeParse({ name, description }).success;
  const submit = async () => {
    if (!store || !valid || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const created = await store.create({ name, description: description || undefined });
      if (!created.ok) {
        setError(
          t(
            created.error.code === 'limit_exceeded'
              ? 'settings.memory.lody.limit'
              : 'settings.memory.lody.createError'
          )
        );
        return;
      }
      onCreated?.(created.value.memoryId);
      onClose();
    } catch {
      setError(t('settings.memory.lody.createError'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content centerOn={settingsPane}>
        <Dialog.Header>
          <Dialog.Title>{t('settings.memory.lody.create')}</Dialog.Title>
          <Dialog.Description>{t('settings.memory.lody.createHint')}</Dialog.Description>
        </Dialog.Header>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={t('settings.memory.name')}>
            <Input
              aria-label={t('settings.memory.name')}
              required
              autoFocus
              maxLength={MEMORY_NAME_CHARACTERS}
              placeholder={t('settings.memory.lody.namePlaceholder')}
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('settings.memory.fields.description')}>
            <Textarea
              aria-label={t('settings.memory.fields.description')}
              placeholder={t('settings.memory.lody.descriptionPlaceholder')}
              value={description}
              disabled={saving}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <Dialog.Footer>
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!store || !valid || saving}>
              {saving ? <Spinner size="small" /> : null}
              {t('settings.memory.lody.createSubmit')}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function LodyMemoryDeleteDialog({
  name,
  memoryId,
  onClose,
}: {
  name: string;
  memoryId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const store = useAtomValue(activeWorkspaceRuntimeAtom)?.personalMemory;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('settings.memory.lody.deleteTitle', { name })}</AlertDialog.Title>
          <AlertDialog.Description>{t('settings.memory.lody.deleteHint')}</AlertDialog.Description>
        </AlertDialog.Header>
        {failed ? (
          <FormMessage tone="error">{t('settings.memory.lody.deleteError')}</FormMessage>
        ) : null}
        <AlertDialog.Footer>
          <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
          <Button
            variant="destructive"
            disabled={!store || busy}
            onClick={() => {
              if (!store) return;
              setBusy(true);
              setFailed(false);
              void store.remove(memoryId).then(onClose, () => {
                setBusy(false);
                setFailed(true);
              });
            }}
          >
            {busy ? <Spinner size="small" /> : null}
            {t('settings.memory.lody.delete')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

type SaveStatus = 'loading' | 'saved' | 'saving' | 'failed' | 'invalid' | 'unavailable';

/** Browse and edit one Lody memory. Edits are authored in the Renderer's own replica. */
export function LodyMemoryEditor({ memoryId, onClose }: { memoryId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const store = useAtomValue(activeWorkspaceRuntimeAtom)?.personalMemory;
  const [opened, setOpened] = useState<{ handle: PersonalMemoryHandle; store: typeof store }>();
  const handle = opened?.store === store ? opened?.handle : undefined;
  const [selected, setSelected] = useState(MEMORY_ENTRY_PATH);
  const [newPath, setNewPath] = useState('');
  const [listOffset, setListOffset] = useState(0);
  const [view, setView] = useState<'edit' | 'history'>('edit');
  const [revision, refresh] = useState(0);
  const [status, setStatus] = useState<SaveStatus>('loading');
  // A name being typed may be briefly empty; it is only written once valid.
  const [draftName, setDraftName] = useState<string>();
  useEffect(() => {
    let retired = false;
    let release: (() => Promise<void>) | undefined;
    setOpened(undefined);
    setStatus('loading');
    void (async () => {
      if (!store) throw new Error('memory_unavailable');
      const next = await store.open(memoryId);
      if (retired) {
        await next.release();
        return;
      }
      const unsubscribe = next.doc.subscribe(() => refresh((value) => value + 1));
      release = async () => {
        unsubscribe();
        await next.release();
      };
      setOpened({ handle: next, store });
      setStatus('saved');
    })().catch(() => {
      if (!retired) setStatus('unavailable');
    });
    return () => {
      retired = true;
      void release?.();
    };
  }, [store, memoryId]);

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

  const list = handle?.memory.list({ offset: listOffset, limit: 50 });
  const topics = list?.ok ? list.value.items : [];
  const body = handle ? readWholeMemoryDocument(handle.memory, selected) : undefined;
  const document = handle?.memory.read({ path: selected, limit: 1 });
  const summary = document?.ok ? document.value.document : undefined;
  const entry = handle ? readWholeMemoryDocument(handle.memory, MEMORY_ENTRY_PATH) : undefined;
  const profile = readMemoryProfile(entry ?? '');
  const isEntry = selected === MEMORY_ENTRY_PATH;
  const writeEntry = (next: { name: string; description?: string; rest: string }) => {
    const valid = MemoryProfileSchema.safeParse({
      name: next.name,
      description: next.description || undefined,
    }).success;
    if (!handle || !valid) {
      setStatus('invalid');
      return;
    }
    void save(
      handle.memory.update(
        {
          path: MEMORY_ENTRY_PATH,
          body: replaceMemoryProfile(next.rest, {
            name: next.name,
            description: next.description || undefined,
          }),
        },
        context()
      )
    );
  };
  const addTopic = () => {
    if (!handle || !newPath.trim()) return;
    const path = newPath.trim().endsWith('.md') ? newPath.trim() : `${newPath.trim()}.md`;
    if (!handle.memory.read({ path }).ok) {
      const result = handle.memory.create({ path, body: '' }, context());
      void save(result);
      if (!result.ok) return;
    }
    setSelected(path);
    setNewPath('');
  };
  const title = draftName ?? profile.name ?? t('settings.memory.lody.untitled');

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content
        centerOn={settingsPane}
        width="min(920px, 96dvw)"
        closeButton={false}
        style={{
          maxWidth: 'none',
          height: 'min(640px, 92dvh)',
          padding: 0,
          gap: 0,
          overflow: 'hidden',
        }}
      >
        <div {...stylex.props(styles.corner)}>
          {view === 'edit' ? (
            <Button
              type="button"
              size="small"
              variant="ghost"
              icon
              disabled={!handle || !summary}
              aria-label={t('settings.memory.history.open')}
              title={t('settings.memory.history.open')}
              onClick={() => setView('history')}
            >
              <History size={15} />
            </Button>
          ) : null}
          <Button
            type="button"
            size="small"
            variant="ghost"
            icon
            aria-label={t('common.close', 'Close')}
            onClick={onClose}
          >
            <X size={15} />
          </Button>
        </div>
        {view === 'history' && handle ? (
          <LodyMemoryHistory
            memory={handle.memory}
            path={selected}
            revision={revision}
            onBack={() => setView('edit')}
          />
        ) : (
          <div {...stylex.props(styles.layout)}>
            <aside {...stylex.props(styles.rail)} aria-label={t('settings.memory.lody.topics')}>
              <span {...stylex.props(catalog.meta, styles.railTitle)}>
                {t('settings.memory.lody.topics')}
              </span>
              <div
                role="listbox"
                aria-label={t('settings.memory.lody.topics')}
                {...stylex.props(styles.topics)}
              >
                {topics.map((topic) => (
                  <button
                    key={topic.path}
                    type="button"
                    role="option"
                    aria-selected={topic.path === selected}
                    onClick={() => {
                      setSelected(topic.path);
                    }}
                    {...stylex.props(
                      surface.listRow,
                      topic.path === selected && surface.listRowSelected,
                      styles.topic
                    )}
                  >
                    <FileText size={14} {...stylex.props(styles.topicIcon)} />
                    <span {...stylex.props(surface.listRowLabel)}>
                      {topic.path === MEMORY_ENTRY_PATH
                        ? t('settings.memory.lody.entry')
                        : topic.path}
                    </span>
                  </button>
                ))}
                {listOffset > 0 ? (
                  <Button size="small" variant="ghost" onClick={() => setListOffset(0)}>
                    {t('settings.memory.builtin.first')}
                  </Button>
                ) : null}
                {list?.ok && list.value.nextOffset !== undefined ? (
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => setListOffset(list.value.nextOffset!)}
                  >
                    {t('settings.memory.builtin.next')}
                  </Button>
                ) : null}
              </div>
              <form
                {...stylex.props(styles.addTopic)}
                onSubmit={(event) => {
                  event.preventDefault();
                  addTopic();
                }}
              >
                <Input
                  aria-label={t('settings.memory.builtin.path')}
                  placeholder={t('settings.memory.builtin.path')}
                  value={newPath}
                  disabled={!handle}
                  onChange={(event) => setNewPath(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  icon
                  disabled={!handle || !newPath.trim()}
                  aria-label={t('settings.memory.builtin.add')}
                >
                  <Plus size={14} />
                </Button>
              </form>
            </aside>
            <section {...stylex.props(styles.detail)}>
              <div {...stylex.props(styles.detailHeader)}>
                <Dialog.Header>
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Description>{t('settings.memory.lody.editorHint')}</Dialog.Description>
                </Dialog.Header>
              </div>
              <div {...stylex.props(styles.scroll)}>
                {status === 'loading' ? <Spinner size="small" /> : null}
                {status === 'unavailable' ? (
                  <FormMessage tone="error">{t('settings.memory.builtin.unavailable')}</FormMessage>
                ) : null}
                {handle && body !== undefined ? (
                  isEntry ? (
                    <>
                      <div {...stylex.props(styles.fields)}>
                        <Field label={t('settings.memory.name')}>
                          <Input
                            aria-label={t('settings.memory.name')}
                            maxLength={MEMORY_NAME_CHARACTERS}
                            value={title}
                            onChange={(event) => {
                              const name = event.target.value;
                              setDraftName(name);
                              if (name.trim()) {
                                writeEntry({ ...profile, name });
                                setDraftName(undefined);
                              }
                            }}
                          />
                        </Field>
                        <Field label={t('settings.memory.fields.description')}>
                          <Input
                            aria-label={t('settings.memory.fields.description')}
                            value={profile.description ?? ''}
                            onChange={(event) =>
                              writeEntry({
                                ...profile,
                                name: profile.name ?? title,
                                description: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <Field label={t('settings.memory.lody.entryBody')}>
                        <Textarea
                          aria-label={t('settings.memory.lody.entryBody')}
                          placeholder={t('settings.memory.lody.entryPlaceholder')}
                          value={profile.rest}
                          rows={12}
                          onChange={(event) =>
                            writeEntry({
                              ...profile,
                              name: profile.name ?? title,
                              rest: event.target.value,
                            })
                          }
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <div {...stylex.props(styles.topicHeader)}>
                        <span {...stylex.props(styles.path)}>{selected}</span>
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => {
                            void save(handle.memory.forget({ path: selected }, context()));
                            setSelected(MEMORY_ENTRY_PATH);
                          }}
                        >
                          <Trash2 size={14} />
                          {t('settings.memory.builtin.delete')}
                        </Button>
                      </div>
                      <Field label={t('settings.memory.builtin.description')}>
                        <Input
                          aria-label={t('settings.memory.builtin.description')}
                          value={summary?.description ?? ''}
                          onChange={(event) =>
                            void save(
                              handle.memory.update(
                                { path: selected, description: event.target.value },
                                context()
                              )
                            )
                          }
                        />
                      </Field>
                      <Field label={t('settings.memory.builtin.body')}>
                        <Textarea
                          aria-label={t('settings.memory.builtin.body')}
                          value={body}
                          rows={12}
                          onChange={(event) =>
                            void save(
                              handle.memory.update(
                                { path: selected, body: event.target.value },
                                context()
                              )
                            )
                          }
                        />
                      </Field>
                    </>
                  )
                ) : null}
              </div>
              <div {...stylex.props(styles.footer)}>
                {/* Saving is silent; only a problem with this device's copy is reported. */}
                <span role="status" {...stylex.props(catalog.meta)}>
                  {status === 'failed' || status === 'invalid'
                    ? t(`settings.memory.builtin.${status}`)
                    : null}
                </span>
                <Button type="button" variant="secondary" onClick={onClose}>
                  {t('common.done', 'Done')}
                </Button>
              </div>
            </section>
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
