import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../ui/dialog';
import { useTranslation } from 'react-i18next';
import type { ClientHostBindings } from '@lody/plugin-sdk/client';
import type { ClientCatalogInstallation } from './client-host-provider';

interface SecretRequest {
  label: string;
  signal: AbortSignal;
  save: (value: string) => Promise<void>;
}
const SecretEditor = createContext<((r: SecretRequest) => void) | null>(null);
export function PluginSecretEditorProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<SecretRequest | null>(null);
  return (
    <SecretEditor.Provider value={setRequest}>
      {children}
      {request && <SecretEditorDialog request={request} close={() => setRequest(null)} />}
    </SecretEditor.Provider>
  );
}
// Keep password inputs outside the plugin's DOM and React event ancestry.
function SecretEditorDialog({ request, close }: { request: SecretRequest; close: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (request.signal.aborted) {
      close();
      return;
    }
    request.signal.addEventListener('abort', close);
    return () => request.signal.removeEventListener('abort', close);
  }, [request, close]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Content>
        <Dialog.Title>{request.label}</Dialog.Title>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            setBusy(true);
            setError(false);
            try {
              request.signal.throwIfAborted();
              await request.save(String(new FormData(form).get('value')));
              form.reset();
              close();
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {request.label}
            <input name="value" type="password" autoComplete="new-password" required />
          </label>
          <button disabled={busy}>{t('common.save')}</button>
          {error && <p role="alert">{t('settings.plugins.failed')}</p>}
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
export function settingsFields(
  entry: ClientCatalogInstallation,
  signal: AbortSignal,
  resolveMachine: (id: string) => ClientCatalogInstallation
): Pick<ClientHostBindings, 'PluginConfigForm' | 'PluginSecretField'> {
  const lookup = (id: string) => {
    signal.throwIfAborted();
    return resolveMachine(id);
  };
  function PluginSecretField({
    fieldKey,
    target,
    onSaved,
  }: import('@lody/plugin-sdk/client').PluginSecretFieldProps) {
    const { t } = useTranslation();
    const open = useContext(SecretEditor);
    const [saved, setSaved] = useState(false);
    const field = entry.dev.manifest.config?.[fieldKey];
    if (target.workspaceId !== entry.workspaceId || field?.type !== 'secret')
      throw Error('Invalid secret field');
    const configured = saved || lookup(target.machineId).inspection?.configured.includes(fieldKey);
    return (
      <>
        <button
          type="button"
          disabled={!open}
          onClick={() =>
            open?.({
              label: field.label,
              signal,
              save: async (value) => {
                const dest = lookup(target.machineId);
                if (!dest.setSecret || dest.dev.manifest.config?.[fieldKey]?.type !== 'secret')
                  throw Error('Secret field unavailable');
                await dest.setSecret(fieldKey, value);
                signal.throwIfAborted();
                setSaved(true);
                onSaved?.({ configured: true });
              },
            })
          }
        >
          {field.label}
        </button>
        {configured && <span role="status">{t('common.saved', 'Saved')}</span>}
      </>
    );
  }
  return {
    PluginSecretField,
    PluginConfigForm({ target, scope, fields }) {
      const { t } = useTranslation();
      const [busy, setBusy] = useState(false),
        [error, setError] = useState(false);
      if (
        target.workspaceId !== entry.workspaceId ||
        (scope === 'machine' && !('machineId' in target)) ||
        (scope === 'project' && !('projectId' in target))
      )
        throw Error('Invalid configuration target');
      const dirty = useRef(new Set<string>());
      const rows = Object.entries(entry.dev.manifest.config ?? {}).filter(
        ([key, f]) =>
          (!fields || fields.includes(key)) &&
          (f.type === 'secret' || f.scope === 'machine'
            ? 'machine'
            : f.scope === 'project'
              ? 'project'
              : 'workspace') === scope
      );
      const destination =
        'machineId' in target && !(scope === 'project' && entry.readProject)
          ? lookup(target.machineId)
          : entry;
      const projectId = 'projectId' in target ? target.projectId : undefined;
      const prefs = projectId
        ? (('machineId' in target ? entry.readProject?.(target.machineId, projectId) : undefined) ??
          destination.projectValues?.[projectId])
        : destination.inspection?.preferences;
      return (
        <>
          {rows
            .filter(([, f]) => f.type === 'secret')
            .map(([key]) => (
              <PluginSecretField
                key={key}
                fieldKey={key}
                target={target as import('@lody/plugin-sdk').MachineRef}
              />
            ))}
          {rows.some(([, f]) => f.type !== 'secret') && (
            <form
              onChange={(e) => {
                const el = e.target;
                if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)
                  dirty.current.add(el.name);
              }}
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const changes = Object.fromEntries(
                  rows.flatMap(([key, f]) => {
                    if (f.type === 'secret' || !dirty.current.has(key)) return [];
                    const value = data.get(key);
                    if (f.type !== 'boolean' && (value === null || value === '')) return [];
                    return [
                      [
                        key,
                        f.type === 'boolean'
                          ? value !== null
                          : f.type === 'number'
                            ? Number(value)
                            : String(value),
                      ],
                    ];
                  })
                );
                if (!Object.keys(changes).length) return;
                setBusy(true);
                setError(false);
                try {
                  signal.throwIfAborted();
                  const dest =
                    scope !== 'project' && 'machineId' in target ? lookup(target.machineId) : entry;
                  if (scope === 'project') {
                    if (!projectId || !('machineId' in target) || !dest.configureProject)
                      throw Error('Project configuration unavailable');
                    await dest.configureProject(target.machineId, projectId, changes);
                  } else if (dest.configureClient && scope === 'workspace')
                    await dest.configureClient(changes);
                  else if (dest.control) await dest.control('configure', changes);
                  else throw Error();
                  dirty.current.clear();
                } catch {
                  setError(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {rows.map(([k, f]) => {
                if (f.type === 'secret') return null;
                const v = prefs?.[k] ?? f.default;
                return (
                  <label key={k}>
                    {f.label}
                    {f.type === 'select' ? (
                      <select name={k} defaultValue={String(v ?? '')} required={f.required}>
                        <option value="" />
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'boolean' ? (
                      <input name={k} type="checkbox" defaultChecked={v === true} />
                    ) : (
                      <input
                        name={k}
                        type={f.type === 'number' ? 'number' : 'text'}
                        defaultValue={String(v ?? '')}
                        required={f.required}
                        {...(f.type === 'number'
                          ? { min: f.min, max: f.max, step: f.step ?? 'any' }
                          : {})}
                      />
                    )}
                  </label>
                );
              })}
              <button disabled={busy}>{t('common.save')}</button>
              {error && <p role="alert">{t('settings.plugins.failed')}</p>}
            </form>
          )}
        </>
      );
    },
  };
}
