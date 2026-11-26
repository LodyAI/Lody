import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cmdUpdateAgentConfigAtom, getAllAgentConfigAtom } from '@/atoms/agents';
import {
  readAgentPermissionDefault,
  writeAgentPermissionDefault,
  type PermissionDefaultSource,
} from '@/lib/agent-permission-default';
import { toast } from '@/lib/toast';

/**
 * Reads and writes one Provider's synced default permission for new
 * conversations, for the permission menu's "Use for new conversations" row.
 * `undefined` while the Provider row is unknown.
 */
export function useAgentPermissionDefault(agentConfigId: string | null | undefined) {
  const { t } = useTranslation();
  const configs = useAtomValue(getAllAgentConfigAtom);
  const updateConfig = useSetAtom(cmdUpdateAgentConfigAtom);
  const config = agentConfigId ? configs.find((entry) => entry.id === agentConfigId) : undefined;

  return useMemo(() => {
    if (!config) return undefined;
    return {
      value: (source: PermissionDefaultSource) =>
        readAgentPermissionDefault(config.sessionDefaults, source),
      onChange: (source: PermissionDefaultSource, value: string | null) => {
        updateConfig({
          ...config,
          sessionDefaults: writeAgentPermissionDefault(config.sessionDefaults, source, value),
        }).then(
          () =>
            toast.success(
              value === null
                ? t(
                    'chat.runConfig.permissionDefaultCleared',
                    'New conversations use the last permission you picked'
                  )
                : t(
                    'chat.runConfig.permissionDefaultSaved',
                    'New conversations will start with this permission'
                  )
            ),
          () =>
            toast.error(
              t('chat.runConfig.permissionDefaultFailed', 'Could not save the default permission')
            )
        );
      },
    };
  }, [config, t, updateConfig]);
}
