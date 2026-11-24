import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { setPluginOwnerSync } from '@/lib/workspace-catalog-write';
import { useWorkspaceClientPlugins } from '../../plugins/client-host-provider';
import { useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatform } from '@lody/platform/react';
import { workspacePluginEntrySchema } from '@lody/shared/plugins/workspace-entry';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useOrganization } from '@/hooks/useOrganization';
import { useStatusViewWritable } from '@/hooks/use-status-view-writable';
import { putWorkspacePlugin } from '@/lib/workspace-catalog-write';

export function WorkspacePluginImport() {
  const { t } = useTranslation(),
    runtime = useAtomValue(activeWorkspaceRuntimeAtom),
    store = useStore(),
    platform = usePlatform();
  const { role, activeOrganization } = useOrganization();
  const writable = useStatusViewWritable(role);
  const [message, setMessage] = useState('');
  const catalog = useWorkspaceCatalog();
  const owner = useWorkspaceClientPlugins();
  const mayImport = !(
    !runtime ||
    !writable ||
    (runtime.contentMode !== 'e2ee' &&
      platform.kind !== 'local' &&
      (activeOrganization?.id !== runtime.workspaceId || !role || role === 'guest'))
  );
  if (!owner || !runtime) return null;
  const importFile = async (file: File) => {
    try {
      if (!mayImport || file.size > 256 * 1024) throw Error();
      const json = JSON.parse(await file.text());
      const row = workspacePluginEntrySchema.parse(json.workspaceEntry ?? json);
      if (
        row.machine_sync !== 'manual' ||
        row.sync_signature ||
        row.sync_owner_user_id ||
        store.get(activeWorkspaceRuntimeAtom) !== runtime ||
        (runtime.contentMode === 'e2ee' && runtime.protectedCodeCollabRole?.get() !== 'write')
      )
        throw Error();
      await putWorkspacePlugin(runtime, row);
      setMessage(t('settings.plugins.pinImported'));
    } catch {
      setMessage(t('settings.plugins.pinFailed'));
    }
  };
  return (
    <div>
      <label>
        {t('settings.plugins.registry')}{' '}
        <input
          type="url"
          key={owner.storageNamespace}
          defaultValue={owner.registry}
          onChange={(e) => {
            owner.registry = e.currentTarget.value.trim() || 'https://registry.npmjs.org/';
          }}
        />
      </label>
      {mayImport && (
        <label>
          {t('settings.plugins.importPin')}{' '}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </label>
      )}
      {mayImport &&
        runtime.signPluginOwnerSync &&
        catalog.plugins.map((pin) => (
          <label key={pin.plugin_id}>
            <input
              type="checkbox"
              checked={catalog.ownerPins.some(
                (p) =>
                  p.machine_sync === 'owner_machines' &&
                  p.plugin_id === pin.plugin_id &&
                  p.sync_owner_user_id === runtime.accountId
              )}
              onChange={(event) =>
                void setPluginOwnerSync(
                  runtime,
                  pin,
                  event.currentTarget.checked,
                  owner.ownerSync,
                  () => store.get(activeWorkspaceRuntimeAtom) === runtime
                ).catch(() => setMessage(t('settings.plugins.pinFailed')))
              }
            />
            {t('settings.plugins.ownerSync', {
              title: pin.manifest_summary.title,
              version: pin.source.exact_version,
            })}
          </label>
        ))}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
