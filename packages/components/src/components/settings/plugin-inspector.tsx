import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import type { WorkspaceId } from '@lody/shared';
import type { ClientCatalogInstallation } from '../../plugins/client-host-provider';
import { PluginInstallationSettings } from '../../plugins/shell-surfaces';
import { clientDiagnostics } from '../../plugins/client-diagnostics';
import { activatePluginTheme } from '../../plugins/appearance';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/ui/dialog';
import { useWorkspaceClientPlugins } from '../../plugins/client-host-provider';
import { pluginSafeMode } from '../../plugins/safe-mode';
import { useSyncExternalStore, useState, useRef, type FormEvent } from 'react';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';

type Value = string | number | boolean;
export interface PluginInspection {
  manifest: PluginManifest;
  lifecycle: string;
  pid?: number;
  clientDigest?: string;
  devSessionNonce?: string;
  trusted: 'release' | 'dev' | false;
  registrations: readonly string[];
  diagnostics: readonly string[];
  logs: readonly string[];
  /** Never include machine secrets; configured contains their names only. */
  preferences: Readonly<Record<string, Value>>;
  configured: readonly string[];
}
export type InspectorAction =
  | 'approve-release'
  | 'approve-dev'
  | 'revoke'
  | 'enable'
  | 'configure'
  | 'disable'
  | 'reload';
export function PluginInspector({
  inspection: p,
  canControl,
  chooseTheme,
  perform,
}: {
  inspection: PluginInspection;
  canControl: boolean;
  chooseTheme?: (themeId: string) => void;
  perform: (action: InspectorAction, changes?: Record<string, Value>) => Promise<void>;
}) {
  return (
    <Inspection
      key={JSON.stringify([p.manifest.id, p.clientDigest, p.devSessionNonce])}
      inspection={p}
      canControl={canControl}
      chooseTheme={chooseTheme}
      perform={perform}
    />
  );
}
function Inspection({
  inspection: p,
  canControl,
  chooseTheme,
  perform,
}: Parameters<typeof PluginInspector>[0]) {
  const { t } = useTranslation();
  const dirty = useRef(new Set<string>());
  const [form, setForm] = useState<'enable' | 'configure'>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = Object.entries(p.manifest.config ?? {});
  const shown = fields.filter(
    ([k, f]) =>
      form !== 'enable' ||
      p.manifest.onboarding?.fields.includes(k) ||
      (f.required && !p.configured.includes(k))
  );
  async function run(action: InspectorAction, changes?: Record<string, Value>) {
    setBusy(true);
    setError('');
    try {
      await perform(action, changes);
      setForm(undefined);
      dirty.current.clear();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.plugins.failed'));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    const data = new FormData(e.currentTarget);
    const changes: Record<string, Value> = Object.create(null);
    for (const [k, f] of shown) {
      if (p.configured.includes(k) && !dirty.current.has(k)) continue;
      const v = data.get(k);
      if (f.type === 'boolean') changes[k] = v === 'on';
      else if (typeof v === 'string' && v !== '') changes[k] = f.type === 'number' ? Number(v) : v;
    }
    void run(form, changes);
  }
  return (
    <section aria-label={t('settings.plugins.inspector')}>
      <h2>{p.manifest.title}</h2>
      <p>
        {p.lifecycle}
        {p.pid !== undefined && ` · PID ${p.pid}`}
      </p>
      <p>
        {p.clientDigest} ·{' '}
        {p.trusted === 'dev'
          ? t('settings.plugins.trustedDev')
          : p.trusted
            ? t('settings.plugins.approved')
            : t('settings.plugins.unapproved')}
      </p>
      <p>
        {t('settings.plugins.caps')}{' '}
        {[
          p.manifest.client && t('settings.plugins.client'),
          p.manifest.machine && t('settings.plugins.machine'),
          p.manifest.mcpServers?.length && t('settings.plugins.mcp'),
          p.manifest.acpProviders?.length && t('settings.plugins.acp'),
          fields.some(([, f]) => f.type === 'secret') && t('settings.plugins.secrets'),
        ]
          .filter(Boolean)
          .join(', ') || t('settings.plugins.declarative')}
      </p>
      <fieldset disabled={busy || pluginSafeMode()}>
        {chooseTheme &&
          p.manifest.themes?.map((theme) => (
            <Button
              variant="secondary"
              key={theme.id}
              onClick={() => {
                try {
                  chooseTheme(theme.id);
                } catch {
                  setError(t('settings.plugins.themeUnavailable'));
                }
              }}
            >
              {theme.label}
            </Button>
          ))}
        {p.trusted ? (
          <Button variant="secondary" onClick={() => void run('revoke')}>
            {t('settings.plugins.revokeTrust')}
          </Button>
        ) : (
          <>
            {p.clientDigest && (
              <Button variant="secondary" onClick={() => void run('approve-release')}>
                {t('settings.plugins.approveRelease')}
              </Button>
            )}
            {p.devSessionNonce && (
              <Button variant="secondary" onClick={() => void run('approve-dev')}>
                {t('settings.plugins.trustDev')}
              </Button>
            )}
          </>
        )}
        {canControl ? (
          <>
            <Button
              variant="secondary"
              onClick={() =>
                p.manifest.onboarding ||
                fields.some(([k, f]) => f.required && !p.configured.includes(k))
                  ? setForm('enable')
                  : void run('enable')
              }
            >
              {t('settings.plugins.enable')}
            </Button>
            <Button variant="secondary" onClick={() => setForm('configure')}>
              {t('settings.plugins.configure')}
            </Button>
            <Button variant="secondary" onClick={() => void run('reload')}>
              {t('settings.plugins.reload')}
            </Button>
            <Button variant="secondary" onClick={() => void run('disable')}>
              {t('settings.plugins.disable')}
            </Button>
          </>
        ) : (
          <>
            <p>{t('settings.plugins.localControl')}</p>
            <dl>
              {fields.flatMap(([key, field]) =>
                field.type === 'secret' || field.scope === 'machine'
                  ? []
                  : [
                      <div key={key}>
                        <dt>{field.label}</dt>
                        <dd>{String(p.preferences[key] ?? field.default ?? '—')}</dd>
                      </div>,
                    ]
              )}
            </dl>
          </>
        )}
        {canControl && form && (
          <Dialog.Root
            open
            onOpenChange={(open) => {
              if (!open && !busy) {
                dirty.current.clear();
                setForm(undefined);
              }
            }}
          >
            <Dialog.Content>
              <form
                key={form}
                onChange={(e) => {
                  const target = e.target;
                  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement)
                    dirty.current.add(target.name);
                }}
                onSubmit={submit}
              >
                <Dialog.Title>
                  {form === 'enable'
                    ? (p.manifest.onboarding?.title ?? t('settings.plugins.setup'))
                    : t('settings.plugins.configuration')}
                </Dialog.Title>
                {form === 'enable' && <p>{p.manifest.onboarding?.summary}</p>}
                {shown.map(([k, f]) => {
                  const value = f.type === 'secret' ? undefined : (p.preferences[k] ?? f.default);
                  const required = f.required && !p.configured.includes(k);
                  return (
                    <label key={k}>
                      {f.label}
                      {f.type === 'boolean' ? (
                        <input type="checkbox" name={k} defaultChecked={value === true} />
                      ) : f.type === 'select' ? (
                        <select name={k} required={required} defaultValue={String(value ?? '')}>
                          <option value="" />
                          {f.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          name={k}
                          type={
                            f.type === 'secret'
                              ? 'password'
                              : f.type === 'number'
                                ? 'number'
                                : 'text'
                          }
                          autoComplete={f.type === 'secret' ? 'new-password' : undefined}
                          defaultValue={String(value ?? '')}
                          required={required}
                          {...(f.type === 'number'
                            ? { min: f.min, max: f.max, step: f.step ?? 'any' }
                            : { placeholder: f.placeholder })}
                        />
                      )}{' '}
                      {f.description}
                    </label>
                  );
                })}
                {error && <p role="alert">{error}</p>}
                <Button variant="secondary" type="submit" disabled={busy}>
                  {form === 'enable'
                    ? t('settings.plugins.saveEnable')
                    : t('settings.plugins.save')}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    dirty.current.clear();
                    setForm(undefined);
                  }}
                >
                  {t('settings.plugins.cancel')}
                </Button>
              </form>
            </Dialog.Content>
          </Dialog.Root>
        )}
      </fieldset>
      {error && !form && <p role="alert">{error}</p>}
      {Object.entries({
        [t('settings.plugins.registrations')]: p.registrations,
        [t('settings.plugins.diagnostics')]: p.diagnostics,
        [t('settings.plugins.logs')]: p.logs.slice(-500),
      }).map(([title, lines]) => (
        <details key={title}>
          <summary>{title}</summary>
          <pre>{lines.join('\n')}</pre>
        </details>
      ))}
    </section>
  );
}

function WorkflowApproval({ entry }: { entry: ClientCatalogInstallation }) {
  const { t } = useTranslation();
  const owner = useWorkspaceClientPlugins();
  const { projects } = useVisibleLocalProjects({ workspaceId: entry.workspaceId as WorkspaceId });
  const [id, setId] = useState(''),
    [message, status] = useState(''),
    [busy, setBusy] = useState(false);
  const [reads, setReads] = useState<
    import('@lody/shared/plugins/machine-rpc').WorkflowReadOperation[]
  >([]);
  const available = [...projects.values()].filter((p) => p.machine.id === entry.machineId);
  const change = async (action: 'grant' | 'revoke') => {
    if (!entry.workflowApproval || !entry.workflowBinding || !owner?.installations().some(i=>i.workflowApproval && i.workflowBinding === entry.workflowBinding) || !available.some(p=>p.project.id===id) || pluginSafeMode()) return;
    setBusy(true);
    try {
      const expiresAt = await entry.workflowApproval(id, action, reads);
      status(action === 'grant' ? t('settings.plugins.workflowGranted',{expiration:new Date(expiresAt).toLocaleString()}) : t('settings.plugins.workflowRevoked'));
    } catch {
      status(t('settings.plugins.workflowFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset disabled={busy || pluginSafeMode()}>
      <legend>{t('settings.plugins.workflowTitle')}</legend>
      <p>{t('settings.plugins.workflowScope',{plugin:entry.pluginId,machine:entry.machineId})}</p>
      <label>
        {t('settings.plugins.workflowProject')}{' '}
        <select
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setReads([]);
            status('');
          }}
        >
          <option value="">{t('settings.plugins.workflowSelect')}</option>
          {available.map(({ project }) => (
            <option key={project.id} value={project.id}>
              {project.name} ({project.id})
            </option>
          ))}
        </select>
      </label>
      {(
        [
          ['sessions', 'settings.plugins.workflowList'],
          ['session-meta', 'settings.plugins.workflowMeta'],
          ['sessionTurns', 'settings.plugins.workflowTurns'],
        ] as const
      ).map(([op, label]) => (
        <label key={op}>
          <input
            type="checkbox"
            checked={reads.includes(op)}
            onChange={(e) =>
              setReads(e.target.checked ? [...reads, op] : reads.filter((r) => r !== op))
            }
          />
          {t(label)}
        </label>
      ))}
      <Button
        disabled={!available.some((p) => p.project.id === id)}
        onClick={() => void change('grant')}
      >
        {t('settings.plugins.workflowGrant')}
      </Button>
      <Button disabled={!available.some(p=>p.project.id===id)} variant="secondary" onClick={() => void change('revoke')}>
        {t('settings.plugins.workflowRevoke')}
      </Button>
      <p role="status">{message}</p>
    </fieldset>
  );
}
const noopSubscribe = () => () => {};
const zero = () => 0;
export function PluginsSettings() {
  const { t } = useTranslation();
  const owner = useWorkspaceClientPlugins();
  useSyncExternalStore(owner?.subscribe ?? noopSubscribe, owner?.snapshot ?? zero, zero);
  useSyncExternalStore(
    clientDiagnostics.subscribe,
    clientDiagnostics.snapshot,
    clientDiagnostics.snapshot
  );
  const entries = owner?.installations() ?? [];
  return (
    <section aria-label={t('settings.tabs.plugins')}>
      <h2>{t('settings.tabs.plugins')}</h2>
      {pluginSafeMode() && <p>{t('settings.plugins.safe')}</p>}
      {!entries.length && <p>{t('settings.plugins.empty')}</p>}
      {owner &&
        entries.map((i) => (
          <section key={JSON.stringify([i.workspaceId, i.sourceKey, i.pluginId])}>
            <PluginInspector
              chooseTheme={
                i.enabled &&
                !!i.digest &&
                !pluginSafeMode() &&
                (i.sourceKey === 'local' || owner.trustState(i))
                  ? (id) => {
                      if (
                        !owner.installations().includes(i) ||
                        pluginSafeMode() ||
                        (i.sourceKey !== 'local' && !owner.trustState(i))
                      )
                        throw Error('Unavailable');
                      activatePluginTheme(i, id);
                    }
                  : undefined
              }
              canControl={!!i.control}
              inspection={{
                lifecycle: i.enabled ? 'Enabled' : 'Disabled',
                registrations: [],
                logs: [],
                configured: [],
                preferences: {},
                ...i.inspection,
                diagnostics: [...(i.inspection?.diagnostics ?? []), ...clientDiagnostics.read(i)],
                manifest: i.dev.manifest,
                clientDigest: i.digest,
                devSessionNonce: i.dev.owner && i.dev.devMode ? i.dev.devSessionNonce : undefined,
                trusted: owner.trustState(i),
              }}
              perform={async (action, changes) => {
                if (action === 'approve-dev') return owner.trustDev(i);
                if (action === 'approve-release') return owner.trustRelease(i);
                if (action === 'revoke') return owner.revoke(i);
                if (!i.control) throw new Error('Plugin control unavailable on this machine');
                await i.control(action, changes);
              }}
            />
            {i.workflowBinding && i.workflowApproval && <WorkflowApproval key={i.workflowBinding} entry={i} />}
            <PluginInstallationSettings entry={i} />
          </section>
        ))}
    </section>
  );
}
