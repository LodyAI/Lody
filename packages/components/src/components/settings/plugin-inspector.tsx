import {pluginCapabilities} from '@lody/shared/plugins/capabilities';
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
  projectPreferences?: Readonly<Record<string, Readonly<Record<string, Value>>>>;
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
  projects,
  canControl,
  clientConfig,
  chooseTheme,
  perform,
}: {
  inspection: PluginInspection;
  projects?: readonly { id: string; name: string }[];
  canControl: boolean;
  clientConfig?: boolean;
  chooseTheme?: (themeId: string) => void;
  perform: (
    action: InspectorAction,
    changes?: Record<string, Value>,
    projectId?: string
  ) => Promise<void>;
}) {
  return (
    <Inspection
      key={JSON.stringify([p.manifest.id, p.clientDigest, p.devSessionNonce])}
      projects={projects}
      inspection={p}
      clientConfig={clientConfig}
      canControl={canControl}
      chooseTheme={chooseTheme}
      perform={perform}
    />
  );
}
function Inspection({
  inspection: p,
  projects,
  canControl,
  clientConfig,
  chooseTheme,
  perform,
}: Parameters<typeof PluginInspector>[0]) {
  const { t } = useTranslation();
  const dirty = useRef(new Set<string>());
  const [form, setForm] = useState<'enable' | 'configure'>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState('');
  const activeProject = form === 'configure' ? projectId : '';
  const preferences = activeProject ? (p.projectPreferences?.[activeProject] ?? {}) : p.preferences;
  const configured = activeProject ? Object.keys(preferences) : p.configured;
  const fields = Object.entries(p.manifest.config ?? {}).filter(
    ([, f]) =>
      (!clientConfig || f.scope === 'client') && (f.scope === 'project') === Boolean(activeProject)
  );
  const shown = fields.filter(
    ([k, f]) =>
      form !== 'enable' ||
      p.manifest.onboarding?.fields.includes(k) ||
      (f.required && !configured.includes(k))
  );
  async function run(action: InspectorAction, changes?: Record<string, Value>) {
    setBusy(true);
    setError('');
    try {
      await perform(
        action,
        changes,
        action === 'configure' ? activeProject || undefined : undefined
      );
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
      if (configured.includes(k) && !dirty.current.has(k)) continue;
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
        {pluginCapabilities(p.manifest).map(cap=>{
          const label=({client:'client',machine:'machine',mcpServers:'mcp',acpProviders:'acp',secrets:'secrets'} as Record<string,string>)[cap];
          return label?t(`settings.plugins.${label}`):cap;
        }).join(', ') || t('settings.plugins.declarative')}
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
                fields.some(([k, f]) => f.required && !configured.includes(k))
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
        {clientConfig && fields.length > 0 && (
          <Button variant="secondary" onClick={() => setForm('configure')}>
            {t('settings.plugins.configure')}
          </Button>
        )}
        {(canControl || clientConfig) && form && (
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
                key={JSON.stringify([form, activeProject])}
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
                {form === 'configure' &&
                projects?.length &&
                Object.values(p.manifest.config ?? {}).some((f) => f.scope === 'project') ? (
                  <select
                    aria-label={t('settings.plugins.configuration')}
                    value={activeProject}
                    onChange={(e) => {
                      dirty.current.clear();
                      setProjectId(e.target.value);
                    }}
                  >
                    <option value="">{p.manifest.title}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                {shown.map(([k, f]) => {
                  const value = f.type === 'secret' ? undefined : (preferences[k] ?? f.default);
                  const required = f.required && !configured.includes(k);
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

export function WorkflowApproval({ entry }: { entry: ClientCatalogInstallation }) {
  const { t } = useTranslation();
  const owner = useWorkspaceClientPlugins();
  const { projects } = useVisibleLocalProjects({ workspaceId: entry.workspaceId as WorkspaceId });
  const [id, setId] = useState(''),
    [message, status] = useState(''),
    [busy, setBusy] = useState(false);
  const [role, setRole] = useState(''),
    [op, setOp] = useState<
      import('@lody/shared/plugins/machine-rpc').DeclaredWorkflowGrant['allowed_ops'][number]
    >(
      entry.dev.manifest.permissions?.includes('sessions.write')
        ? 'sessions.create'
        : 'sessions.respondInteraction'
    );
  const available = [...projects.values()].filter((p) => p.machine.id === entry.machineId);
  const change = async (action: 'grant' | 'revoke') => {
    if (
      !entry.workflowApproval ||
      !entry.workflowBinding ||
      !owner
        ?.installations()
        .some((i) => i.workflowApproval && i.workflowBinding === entry.workflowBinding) ||
      (action === 'grant' &&
        (!role || (id !== '*' && !available.some((p) => p.project.id === id)))) ||
      pluginSafeMode()
    )
      return;
    setBusy(true);
    try {
      await entry.workflowApproval(id, action, role === '*' || !role ? '*' : [role], [op]);
      status(
        action === 'grant'
          ? t('settings.plugins.workflowGranted')
          : t('settings.plugins.workflowRevoked')
      );
    } catch {
      status(t('settings.plugins.workflowFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset disabled={busy || pluginSafeMode()}>
      <legend>{t('settings.plugins.workflowTitle')}</legend>
      {entry.declaredGrant && (
        <p>
          Active: {entry.declaredGrant.allowed_ops.join(', ')} · Projects:{' '}
          {JSON.stringify(entry.declaredGrant.allowed_project_ids)} · Roles:{' '}
          {JSON.stringify(entry.declaredGrant.allowed_role_ids)}
        </p>
      )}
      <label>
        {t('settings.plugins.workflowOperation')}{' '}
        <select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
          {(
            [
              'sessions.create',
              'sessions.send',
              'sessions.respondInteraction',
              'sessions.requestStop',
              'sessions.requestArchive',
              'sessionFork',
            ] as const
          )
            .filter((o) =>
              entry.dev.manifest.permissions?.includes(
                o === 'sessions.respondInteraction' ? 'sessions.approve' : 'sessions.write'
              )
            )
            .map((o) => (
              <option key={o}>{o}</option>
            ))}
        </select>
      </label>
      <label>
        {t('settings.plugins.workflowRole')}{' '}
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">{t('settings.plugins.workflowSelectRole')}</option>
          <option value="*">{t('settings.plugins.workflowAllRoles')}</option>
          {entry.dev.manifest.agentRoles?.map((r) => (
            <option key={r.id} value={`plugin:${entry.pluginId}:${r.id}`}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        {t('settings.plugins.workflowScope', { plugin: entry.pluginId, machine: entry.machineId })}
      </p>
      <label>
        {t('settings.plugins.workflowProject')}{' '}
        <select
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            status('');
          }}
        >
          <option value="">{t('settings.plugins.workflowSelect')}</option>
          <option value="*">{t('settings.plugins.workflowAllProjects')}</option>
          {available.map(({ project }) => (
            <option key={project.id} value={project.id}>
              {project.name} ({project.id})
            </option>
          ))}
        </select>
      </label>
      <Button
        disabled={!role || (id !== '*' && !available.some((p) => p.project.id === id))}
        onClick={() => void change('grant')}
      >
        {t('settings.plugins.workflowGrant')}
      </Button>
      <Button
        disabled={!entry.declaredGrant}
        variant="secondary"
        onClick={() => void change('revoke')}
      >
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
  const { projects } = useVisibleLocalProjects({
    workspaceId: entries[0]?.workspaceId as WorkspaceId | undefined,
    enabled: entries.some(
      (i) =>
        !!i.control && Object.values(i.dev.manifest.config ?? {}).some((f) => f.scope === 'project')
    ),
  });
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
              projects={[...projects.values()]
                .filter((p) => p.machine.id === i.machineId)
                .map((p) => p.project)}
              clientConfig={!!i.configureClient}
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
              perform={async (action, changes, projectId) => {
                if (action === 'approve-dev') return owner.trustDev(i);
                if (action === 'approve-release') return owner.trustRelease(i);
                if (action === 'revoke') return owner.revoke(i);
                if (action === 'configure' && i.configureClient)
                  return i.configureClient(changes ?? {});
                if (!i.control) throw new Error('Plugin control unavailable on this machine');
                await i.control(action, changes, projectId);
              }}
            />
            {i.workflowBinding && i.workflowApproval && (
              <WorkflowApproval key={i.workflowBinding} entry={i} />
            )}
            <PluginInstallationSettings entry={i} />
          </section>
        ))}
    </section>
  );
}
