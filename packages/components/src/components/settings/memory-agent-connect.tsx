import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { Spinner } from '@lody/ui/spinner';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { MemoryAgent } from '@lody/shared';
import { buildMemoryAgentRows, type MemoryAgentConfigSummary } from '@/lib/memory-agent-rows';
import type { useMemoryProvider } from '@/hooks/use-memory-provider';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import { MemoryProviderHeading } from './memory-provider-heading';

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  // `catalog.rowMain` is the body *as a button* — it carries a pointer cursor
  // and a focus ring. These rows act through their trailing button, so the
  // body uses the plain padding instead of inviting a click that does nothing.
  rowBody: {
    boxSizing: 'border-box',
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  // The name and its facts share the catalog's 12px, which left the pair
  // reading as one block. Weight lifts the name without growing it into the
  // section title; the facts drop a step so the gap is a size, not just a grey.
  rowName: { fontWeight: type.headingWeight },
  rowFacts: { fontSize: text.captionSize, lineHeight: text.captionLeading },
});

/**
 * EverMe-style providers hold one memory per account, so there is nothing to
 * pick: the only choice is which local agents may reach it. Rows are the
 * provider's own view of this machine, never Lody's saved associations.
 */
export function MemoryAgentConnectList({
  logo,
  name,
  providerKey,
  configs,
  agents: reported,
  state,
  disabled,
}: {
  /** Passed in rather than resolved here, so this file stays a leaf module. */
  logo?: ReactNode;
  name: string;
  /** Picks the one-line copy that says how this provider divides a memory up. */
  providerKey: string;
  /** This machine's agent configs; the rows are built from these. */
  configs: readonly MemoryAgentConfigSummary[];
  agents: readonly MemoryAgent[];
  state: ReturnType<typeof useMemoryProvider>;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState<readonly string[]>([]);
  /** Targets waiting on the upload notice; `null` while it is closed. */
  const [confirming, setConfirming] = useState<readonly string[] | null>(null);
  // A failed or timed-out probe answers without an inventory. Dropping to an
  // empty list there would read as "this machine has no agents", which is a
  // claim the reply never made, so the last inventory stays on screen instead.
  const lastReported = useRef<readonly MemoryAgent[]>(reported);
  if (reported.length) lastReported.current = reported;
  const known = reported.length ? reported : lastReported.current;
  const rows = buildMemoryAgentRows(configs, known, state.result !== undefined);
  const adapted = rows.filter((row) => row.everme);
  const missing = adapted.filter((row) => !row.everme?.connected && row.everme?.connectable);
  // Only a click the user made disables the list. `state.busy` also covers the
  // ambient refresh, which would grey every control out every thirty seconds.
  const busy = pending.length > 0;
  const run = async (action: 'connect' | 'disconnect', targets: readonly string[]) => {
    if (busy || disabled || !targets.length) return;
    setPending(targets);
    try {
      await (action === 'connect' ? state.connect : state.disconnect)([...targets]);
    } finally {
      setPending([]);
    }
  };
  // The first connection on a machine is the one that starts uploading its
  // conversations, so it is the one that has to say so. Once an agent is
  // connected the user has already agreed, and asking again on every row would
  // only teach them to click through it.
  const firstConnection = !adapted.some((row) => row.everme?.connected);
  const ask = (action: 'connect' | 'disconnect', targets: readonly string[]) => {
    if (busy || disabled || !targets.length) return;
    if (action === 'connect' && firstConnection) setConfirming(targets);
    else void run(action, targets);
  };
  const confirmingNames = confirming
    ? new Intl.ListFormat(toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language), {
        type: 'conjunction',
      }).format(
        confirming.map(
          (target) => rows.find((row) => row.agentType === target)?.displayName ?? target
        )
      )
    : '';
  const account = state.result?.account;
  return (
    <div {...stylex.props(styles.stack)}>
      <MemoryProviderHeading
        logo={logo}
        name={name}
        providerKey={providerKey}
        action={
          // Gone rather than disabled once everything is connected: a button
          // with nothing left to do is furniture, and the dots already say so.
          missing.length ? (
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={disabled || busy}
              onClick={() =>
                ask(
                  'connect',
                  missing.map((row) => row.agentType)
                )
              }
            >
              {t('settings.memory.everme.connectAll', { count: missing.length })}
            </Button>
          ) : null
        }
      />
      {rows.length === 0 ? (
        // Only an answered, readable inventory can claim the machine is empty.
        disabled ? null : (
          <SettingsEmptyList>{t('settings.memory.everme.noConfigs')}</SettingsEmptyList>
        )
      ) : (
        <div {...stylex.props(settingsRecordsCard)}>
          {rows.map((row, index) => {
            // One line of facts, the way every other settings row reads: the
            // integration, the state, and — only when there is one — what is
            // wrong. Stacking these would make a seven-row list a page long.
            const facts = row.pending
              ? [t('settings.memory.everme.checking')]
              : row.everme
                ? [
                    t(`settings.memory.everme.integration.${row.everme.integration}`),
                    row.everme.connected
                      ? t('settings.memory.everme.connected')
                      : row.everme.connectable
                        ? t('settings.memory.everme.notConnected')
                        : t('settings.memory.everme.unavailable'),
                  ]
                : [t('settings.memory.everme.notAdapted')];
            return (
              <div
                key={row.agentType}
                {...stylex.props(
                  stylex.defaultMarker(),
                  catalog.row,
                  surface.line,
                  index > 0 && surface.lineRuled
                )}
              >
                <div {...stylex.props(styles.rowBody)}>
                  <div {...stylex.props(catalog.body)}>
                    <div {...stylex.props(catalog.titleLine)}>
                      {/* The dot is the row's glanceable state, so it may not
                          show one before the provider has given one: a grey
                          dot reads as "not connected", and half these rows
                          turn green a moment later. */}
                      {row.pending ? null : (
                        <span
                          aria-hidden="true"
                          {...stylex.props(
                            catalog.statusDot,
                            row.everme?.connected && catalog.statusDotOnline
                          )}
                        />
                      )}
                      <span {...stylex.props(catalog.name, styles.rowName)}>{row.displayName}</span>
                    </div>
                    <span {...stylex.props(catalog.meta, styles.rowFacts)}>
                      <span {...stylex.props(catalog.truncate)}>
                        {facts.join(' · ')}
                        {row.everme?.notice ? (
                          <span
                            {...stylex.props(catalog.metaWarning)}
                            // The short form sits in the line; the whole
                            // sentence waits on hover rather than pushing the
                            // next six rows down the page.
                            title={t(`settings.memory.everme.notice.${row.everme.notice}`)}
                          >
                            {` · ${t(`settings.memory.everme.noticeShort.${row.everme.notice}`)}`}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </div>
                </div>
                <div {...stylex.props(catalog.actions)}>
                  {/* An agent the provider has not adapted has no action at
                      all: a disabled button would read as something to wait
                      for. */}
                  {!row.everme ? null : (
                    <Button
                      type="button"
                      size="small"
                      variant={row.everme.connected ? 'ghost' : 'secondary'}
                      disabled={disabled || busy || !row.everme.connectable}
                      // Every row's button is worded the same, so read aloud
                      // the list is seven identical "Connect"s. The name is
                      // the only thing that tells them apart.
                      aria-label={t(
                        row.everme.connected
                          ? 'settings.memory.everme.disconnectName'
                          : 'settings.memory.everme.connectName',
                        { name: row.displayName }
                      )}
                      aria-busy={pending.includes(row.agentType)}
                      onClick={() =>
                        ask(row.everme?.connected ? 'disconnect' : 'connect', [row.agentType])
                      }
                    >
                      {/* The spinner goes inside the control. Swapping the
                          button out for a bare mark collapses the row's action
                          column mid-action, which is when it matters most. */}
                      {pending.includes(row.agentType) ? (
                        <Spinner size="small" label={null} {...stylex.props(catalog.icon)} />
                      ) : null}
                      {row.everme.connected
                        ? t('settings.memory.everme.disconnect')
                        : t('settings.memory.everme.connect')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.memory.everme.syncTitle', { provider: name })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                account
                  ? 'settings.memory.everme.syncNoticeAccount'
                  : 'settings.memory.everme.syncNotice',
                { provider: name, agents: confirmingNames, account }
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              type="button"
              onClick={() => {
                const targets = confirming;
                setConfirming(null);
                if (targets) void run('connect', targets);
              }}
            >
              {t('settings.memory.everme.syncConfirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}
