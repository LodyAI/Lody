import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Combobox } from '@lody/ui/combobox';
import { Toggle } from '@lody/ui/toggle';
import { ToggleGroup } from '@lody/ui/toggle-group';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import {
  groupIosSimulatorDevices,
  type IosSimulatorDeviceGroup,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorPanelStatus,
  IosSimulatorRuntimeEntry,
} from '@/lib/ios-simulator/ios-simulator-types';
import { useIosSimulatorDeviceStateLabel } from './ios-simulator-copy';

const ALL_RUNTIMES = '__all__';

const styles = stylex.create({
  trigger: { minWidth: 0, maxWidth: '100%', flexShrink: 1 },
  value: { display: 'flex', alignItems: 'baseline', gap: space[1.5], minWidth: 0 },
  valueName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  valueRuntime: { flexShrink: 0, color: colors.secondaryLabel },
  searchRow: { display: 'flex', alignItems: 'center', gap: space[1] },
  searchField: { flexGrow: 1, minWidth: 0 },
  filters: { paddingBottom: space[1.5] },
  /** The device's condition, after its name: one word, never a pill. */
  rowState: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    paddingInlineStart: space[2],
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  rowStateLive: { color: colors.accent },
  rowStateBlocked: { color: colors.secondaryLabel },
});

export type IosSimulatorDevicePickerProps = {
  runtimes: readonly IosSimulatorRuntimeEntry[];
  devices: readonly IosSimulatorDeviceEntry[];
  status: IosSimulatorPanelStatus;
  selectedUdid: string | null;
  disabled?: boolean;
  refreshing?: boolean;
  onSelect: (udid: string) => void;
  /** Opening the list is when a person expects it fresh. */
  onOpenChange?: (open: boolean) => void;
  onRefresh?: () => void;
};

/**
 * The toolbar's one control: which simulator, and which OS it runs. Every
 * device stays listed — occupied and unavailable ones too — so the list agrees
 * with Xcode; the stage below says what can be done with the chosen one.
 */
export function IosSimulatorDevicePicker({
  runtimes,
  devices,
  status,
  selectedUdid,
  disabled,
  refreshing,
  onSelect,
  onOpenChange,
  onRefresh,
}: IosSimulatorDevicePickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [runtimeFilter, setRuntimeFilter] = useState<string | null>(null);
  const stateLabel = useIosSimulatorDeviceStateLabel();

  const runtimeByKey = useMemo(
    () => new Map(runtimes.map((runtime) => [runtime.key, runtime])),
    [runtimes]
  );
  const catalog = useMemo(
    () => ({ runtimes: [...runtimes], devices: [...devices] }),
    [devices, runtimes]
  );
  const allGroups = useMemo(() => groupIosSimulatorDevices(catalog), [catalog]);
  // Runtimes that actually hold a device, for the filter row.
  const filterRuntimes = useMemo(() => allGroups.map((group) => group.runtime), [allGroups]);
  const effectiveRuntimeFilter =
    runtimeFilter && filterRuntimes.some((runtime) => runtime.key === runtimeFilter)
      ? runtimeFilter
      : null;
  const filteredGroups = useMemo(
    () => groupIosSimulatorDevices(catalog, { query, runtimeKey: effectiveRuntimeFilter }),
    [catalog, effectiveRuntimeFilter, query]
  );
  const selected = devices.find((device) => device.udid === selectedUdid) ?? null;

  const label = t('sessions.iosSimulator.picker.label', 'Simulator');
  const placeholder = t('sessions.iosSimulator.picker.placeholder', 'Choose a simulator');
  return (
    <Combobox.Root
      items={allGroups}
      filteredItems={filteredGroups}
      value={selected}
      disabled={disabled}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(device: IosSimulatorDeviceEntry) => device.name}
      isItemEqualToValue={(a: IosSimulatorDeviceEntry, b: IosSimulatorDeviceEntry) =>
        a.udid === b.udid
      }
      onValueChange={(device: IosSimulatorDeviceEntry | null) => {
        if (device) onSelect(device.udid);
      }}
      onOpenChange={(open) => {
        if (!open) setQuery('');
        onOpenChange?.(open);
      }}
    >
      <Combobox.Button
        size="small"
        aria-label={label}
        placeholder={placeholder}
        {...stylex.props(styles.trigger)}
      >
        {/* A render function replaces Base UI's placeholder, so it restates it. */}
        {(device: IosSimulatorDeviceEntry | null) =>
          device ? (
            <span {...stylex.props(styles.value)}>
              <span {...stylex.props(styles.valueName)}>{device.name}</span>
              <span {...stylex.props(styles.valueRuntime)}>
                {runtimeByKey.get(device.runtimeKey)?.name ?? ''}
              </span>
            </span>
          ) : (
            placeholder
          )
        }
      </Combobox.Button>
      <Combobox.Content
        align="start"
        search={
          <div>
            <div {...stylex.props(styles.searchRow)}>
              <span {...stylex.props(styles.searchField)}>
                <Combobox.Search
                  aria-label={t('sessions.iosSimulator.picker.search', 'Search simulators')}
                  placeholder={t('sessions.iosSimulator.picker.search', 'Search simulators')}
                />
              </span>
              {onRefresh ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon
                  disabled={refreshing}
                  aria-label={t('sessions.iosSimulator.picker.refresh', 'Refresh simulators')}
                  onClick={onRefresh}
                >
                  <RefreshCw />
                </Button>
              ) : null}
            </div>
            {filterRuntimes.length > 1 ? (
              <div {...stylex.props(styles.filters)}>
                <ToggleGroup
                  size="mini"
                  shape="pill"
                  wrap
                  aria-label={t('sessions.iosSimulator.picker.runtimeFilter', 'Runtime')}
                  value={[effectiveRuntimeFilter ?? ALL_RUNTIMES]}
                  onValueChange={(value) => {
                    const next = value[0];
                    setRuntimeFilter(!next || next === ALL_RUNTIMES ? null : next);
                  }}
                >
                  <Toggle value={ALL_RUNTIMES}>
                    {t('sessions.iosSimulator.picker.allRuntimes', 'All')}
                  </Toggle>
                  {filterRuntimes.map((runtime) => (
                    <Toggle key={runtime.key} value={runtime.key}>
                      {runtime.name}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}
          </div>
        }
        empty={
          <Combobox.Empty>
            {t('sessions.iosSimulator.picker.noMatch', 'No simulators match')}
          </Combobox.Empty>
        }
      >
        {(group: IosSimulatorDeviceGroup) => (
          <Combobox.Group key={group.runtime.key} items={group.devices}>
            <Combobox.GroupLabel>{group.runtime.name}</Combobox.GroupLabel>
            {group.devices.map((device) => {
              const state = stateLabel(device, status);
              return (
                <Combobox.Item key={device.udid} value={device}>
                  {device.name}
                  <span
                    {...stylex.props(
                      styles.rowState,
                      state.tone === 'live' && styles.rowStateLive,
                      state.tone === 'blocked' && styles.rowStateBlocked
                    )}
                  >
                    {state.label}
                  </span>
                </Combobox.Item>
              );
            })}
          </Combobox.Group>
        )}
      </Combobox.Content>
    </Combobox.Root>
  );
}
