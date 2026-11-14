import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';
import {
  changeFusionPair,
  findFusionPair,
  fusionApplyEdits,
  initialFusionDraft,
  isFusionConfigConfirmed,
  type FusionApplyEdits,
  type FusionCatalog,
  type FusionControls,
  type FusionControlsResolver,
  type FusionNotice,
} from '@/lib/devin-fusion';

/**
 * The Devin Fusion builder: Devin advertises each lead+sidekick combination as
 * one `fusion-…` model value, so this dialog decomposes that list into Lead /
 * effort / Sidekick / Fast rows and turns the draft back into composer edits
 * the ordinary run-config channels apply.
 */

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    minWidth: 0,
  },
  hint: {
    fontSize: '12px',
    lineHeight: 1.4,
    color: colors.tertiaryLabel,
  },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  status: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    fontSize: '12px',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
  statusItem: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
});

export type FusionBuilderDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  catalog: FusionCatalog;
  controlsFor: FusionControlsResolver;
  current: {
    modelId: string | null;
    configOptionValues: Record<string, AcpConfigOptionValue>;
  };
  /** The agent-confirmed state, when this session already reports one. */
  runtime?: {
    modelId?: string | null;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  } | null;
  appliesOn: 'nextMessage' | 'conversationStart';
  modelLabel: (value: string) => string;
  onApply: (edits: FusionApplyEdits) => void;
};

export function FusionBuilderDialog(props: FusionBuilderDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content data-testid="fusion-builder-dialog">
        <Dialog.Header>
          <Dialog.Title>{t('chat.runConfig.fusion.title', 'Devin Fusion')}</Dialog.Title>
          <Dialog.Description>
            {t(
              'chat.runConfig.fusion.description',
              'The lead model plans and reviews; the sidekick explores, implements and tests. Only combinations Devin offers can be applied.'
            )}
          </Dialog.Description>
        </Dialog.Header>
        {/* Remounted on each open so the draft always starts from the live
            configuration rather than a stale earlier visit. */}
        {props.open ? <FusionBuilderForm {...props} /> : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function FusionBuilderForm({
  catalog,
  controlsFor,
  current,
  runtime,
  appliesOn,
  modelLabel,
  onApply,
  onOpenChange,
}: FusionBuilderDialogProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [draft, setDraft] = useState(() => initialFusionDraft(catalog, current, controlsFor));
  const [notices, setNotices] = useState<FusionNotice[]>([]);

  const pair = findFusionPair(catalog, draft.leadKey, draft.sidekickKey);
  const controls: FusionControls = pair
    ? controlsFor(pair.modelValue)
    : { effort: null, fast: null, unknown: { effort: false, fast: false } };
  const edits = fusionApplyEdits(draft, catalog, controlsFor);

  const leadLabel =
    catalog.leads.find((lead) => lead.key === draft.leadKey)?.label ?? draft.leadKey;
  const offeredSidekickKeys = new Set(
    catalog.pairs.filter((p) => p.leadKey === draft.leadKey).map((p) => p.sidekickKey)
  );

  const applyPairChange = (next: { leadKey?: string; sidekickKey?: string }) => {
    const result = changeFusionPair(draft, next, catalog, controlsFor);
    setDraft(result.draft);
    setNotices(result.notices);
  };

  const noticeText = (notice: FusionNotice): string =>
    notice.kind === 'effortReset'
      ? t('chat.runConfig.fusion.effortResetNotice', {
          defaultValue: "{{from}} isn't offered for this combination; lead effort set to {{to}}.",
          from: notice.from,
          to: notice.to,
        })
      : t(
          'chat.runConfig.fusion.fastOffNotice',
          "Fast Mode turned off: this combination doesn't offer it."
        );

  /* A control Devin declares but Lody cannot express yet is unknown, not
     absent — it must never read as "doesn't offer". Hints exist per control,
     and an unadvertised combination shows only its own line. */
  const effortHint = !pair
    ? null
    : controls.effort
      ? null
      : controls.unknown.effort
        ? t(
            'chat.runConfig.fusion.settingUnknown',
            "Lody hasn't loaded this setting from Devin yet."
          )
        : t(
            'chat.runConfig.fusion.effortUnavailable',
            "Devin doesn't offer an effort setting for this combination."
          );
  const fastHint = !pair
    ? null
    : controls.fast
      ? null
      : controls.unknown.fast
        ? t(
            'chat.runConfig.fusion.settingUnknown',
            "Lody hasn't loaded this setting from Devin yet."
          )
        : t(
            'chat.runConfig.fusion.fastUnavailable',
            "Devin doesn't offer Fast Mode for this combination."
          );

  const pendingText =
    appliesOn === 'nextMessage'
      ? t(
          'chat.runConfig.fusion.pendingNextMessage',
          'Applies from your next message; Devin confirms it when that turn starts.'
        )
      : t(
          'chat.runConfig.fusion.pendingConversationStart',
          'Applies when the conversation starts.'
        );

  const runtimeConfirmed = edits != null && isFusionConfigConfirmed(edits, runtime);
  /* What Devin is actually running: the pair's name plus its confirmed effort
     and Fast when that model's controls name them. */
  const runtimeSummary = (() => {
    if (!runtime?.modelId) return null;
    const parts = [modelLabel(runtime.modelId)];
    const runtimeControls = controlsFor(runtime.modelId);
    const effortValue = runtime.configOptionValues?.[runtimeControls.effort?.configId ?? ''];
    if (typeof effortValue === 'string') {
      parts.push(
        runtimeControls.effort?.options.find((option) => option.value === effortValue)?.label ??
          effortValue
      );
    }
    if (
      runtimeControls.fast &&
      runtime.configOptionValues?.[runtimeControls.fast.configId] === runtimeControls.fast.onValue
    ) {
      parts.push(t('chat.runConfig.fastLabel', 'Fast'));
    }
    return parts.join(' · ');
  })();

  return (
    <div {...stylex.props(styles.body)}>
      <div {...stylex.props(styles.row)}>
        <UiField.Label htmlFor={`${fieldId}-lead`}>
          {t('chat.runConfig.fusion.leadLabel', 'Lead model')}
        </UiField.Label>
        <Select.Root
          items={catalog.leads.map((lead) => ({ value: lead.key, label: lead.label }))}
          value={draft.leadKey}
          onValueChange={(leadKey) => {
            if (leadKey != null) applyPairChange({ leadKey });
          }}
        >
          <Select.Trigger id={`${fieldId}-lead`} data-testid="fusion-lead-select">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {catalog.leads.map((lead) => (
              <Select.Item key={lead.key} value={lead.key}>
                {lead.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      <div {...stylex.props(styles.row)}>
        <UiField.Label htmlFor={`${fieldId}-effort`}>
          {t('chat.runConfig.fusion.effortLabel', 'Lead effort')}
        </UiField.Label>
        <Select.Root
          items={(controls.effort?.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          value={draft.effort ?? ''}
          onValueChange={(effort) => {
            if (effort != null) setDraft({ ...draft, effort });
          }}
          disabled={!controls.effort}
        >
          <Select.Trigger
            id={`${fieldId}-effort`}
            data-testid="fusion-effort-select"
            disabled={!controls.effort}
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {(controls.effort?.options ?? []).map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {effortHint ? <span {...stylex.props(styles.hint)}>{effortHint}</span> : null}
      </div>

      <div {...stylex.props(styles.row)}>
        <UiField.Label htmlFor={`${fieldId}-sidekick`}>
          {t('chat.runConfig.fusion.sidekickLabel', 'Sidekick model')}
        </UiField.Label>
        <Select.Root
          items={catalog.sidekicks.map((sidekick) => ({
            value: sidekick.key,
            label: offeredSidekickKeys.has(sidekick.key)
              ? sidekick.label
              : `${sidekick.label} — ${t('chat.runConfig.fusion.notOfferedWith', {
                  defaultValue: 'Not offered with {{lead}}',
                  lead: leadLabel,
                })}`,
          }))}
          value={draft.sidekickKey}
          onValueChange={(sidekickKey) => {
            if (sidekickKey != null) applyPairChange({ sidekickKey });
          }}
        >
          <Select.Trigger id={`${fieldId}-sidekick`} data-testid="fusion-sidekick-select">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {catalog.sidekicks.map((sidekick) => (
              <Select.Item
                key={sidekick.key}
                value={sidekick.key}
                disabled={!offeredSidekickKeys.has(sidekick.key)}
              >
                {sidekick.label}
                {!offeredSidekickKeys.has(sidekick.key)
                  ? ` — ${t('chat.runConfig.fusion.notOfferedWith', {
                      defaultValue: 'Not offered with {{lead}}',
                      lead: leadLabel,
                    })}`
                  : ''}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <span {...stylex.props(styles.hint)}>
          {t(
            'chat.runConfig.fusion.sidekickHint',
            'Each sidekick option already includes its effort; there is no separate sidekick effort.'
          )}
        </span>
      </div>

      <div {...stylex.props(styles.switchRow)}>
        <UiField.Label htmlFor={`${fieldId}-fast`}>
          {t('chat.runConfig.fusion.fastLabel', 'Fast Mode')}
        </UiField.Label>
        <Switch
          id={`${fieldId}-fast`}
          data-testid="fusion-fast-switch"
          checked={draft.fast}
          disabled={!controls.fast}
          onCheckedChange={(checked) => setDraft({ ...draft, fast: checked })}
        />
      </div>
      {fastHint ? <span {...stylex.props(styles.hint)}>{fastHint}</span> : null}

      <div {...stylex.props(styles.status)} aria-live="polite">
        {notices.map((notice, index) => (
          <span key={index} {...stylex.props(styles.statusItem)}>
            {noticeText(notice)}
          </span>
        ))}
        {!pair ? (
          <span {...stylex.props(styles.statusItem)}>
            {t('chat.runConfig.fusion.unavailable', "Devin's ACP doesn't offer this combination.")}
          </span>
        ) : null}
        {controls.unknown.effort || controls.unknown.fast ? (
          <span {...stylex.props(styles.statusItem)}>
            {t(
              'chat.runConfig.fusion.controlsUnknown',
              "Until Devin's options for this combination are loaded, Devin uses its defaults. Refresh the agent's capabilities in Settings to load them."
            )}
          </span>
        ) : null}
        {pair ? (
          <span {...stylex.props(styles.statusItem)}>
            {t('chat.runConfig.fusion.devinModel', {
              defaultValue: 'Devin model: {{name}}',
              name: pair.label,
            })}
          </span>
        ) : null}
        {runtimeConfirmed ? (
          <span {...stylex.props(styles.statusItem)}>
            {t(
              'chat.runConfig.fusion.confirmed',
              'Devin confirmed this configuration for the conversation.'
            )}
          </span>
        ) : runtimeSummary ? (
          <span {...stylex.props(styles.statusItem)}>
            {t('chat.runConfig.fusion.runningAs', {
              defaultValue: 'Devin is currently running {{summary}}.',
              summary: runtimeSummary,
            })}{' '}
            {pendingText}
          </span>
        ) : (
          <span {...stylex.props(styles.statusItem)}>{pendingText}</span>
        )}
      </div>

      <Dialog.Footer>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          data-testid="fusion-apply"
          disabled={!edits}
          onClick={() => {
            if (!edits) return;
            onApply(edits);
            onOpenChange(false);
          }}
        >
          {t('chat.runConfig.fusion.apply', 'Apply')}
        </Button>
      </Dialog.Footer>
    </div>
  );
}
