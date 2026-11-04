import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import type { McpAuthenticationResult } from '@lody/shared';
import { CollapsibleSection, Field, Section } from './form-primitives';
import { settingsCatalog as catalog } from './surface';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[2] },
});

export function McpAuthenticationView({
  status,
  disabled = false,
  available = true,
  busy = false,
  httpControls = true,
  client,
  onClientChange,
  onAction,
}: {
  status?: McpAuthenticationResult;
  disabled?: boolean;
  available?: boolean;
  busy?: boolean;
  httpControls?: boolean;
  client: { id: string; secret: string };
  onClientChange: (value: { id: string; secret: string }) => void;
  onAction: (action: 'authorize' | 'check' | 'cancel' | 'signout') => void;
}) {
  const { t } = useTranslation();
  const clientField = useId();
  const canAuthorize =
    status?.reason === 'oauth_required' ||
    status?.reason === 'expired' ||
    status?.reason === 'client_required' ||
    status?.reason === 'cancelled' ||
    status?.mode === 'oauth' ||
    Boolean(client.id.trim());
  const waiting = status?.status === 'waiting';
  const message = !available
    ? 'localRequired'
    : disabled
      ? 'saveFirst'
      : status?.reason === 'storage_unavailable'
        ? 'storageUnavailable'
        : status?.reason === 'client_required'
          ? 'clientRequired'
          : status?.reason === 'expired'
            ? 'expired'
            : status?.reason === 'unsupported'
              ? 'unsupported'
              : status?.reason === 'cancelled'
                ? 'cancelled'
                : !httpControls && !status?.hasCredentials
                  ? 'stdio'
                  : (status?.status ?? 'unknown');
  return (
    <Section title={t('settings.mcp.authentication.title')}>
      <div aria-live="polite">{t(`settings.mcp.authentication.${message}`)}</div>
      <div {...stylex.props(styles.actions)}>
        {busy ? <Spinner size="small" /> : null}
        {waiting ? (
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={busy || !available}
            onClick={() => onAction('cancel')}
          >
            {t('common.cancel')}
          </Button>
        ) : (
          <>
            {httpControls ? (
              canAuthorize ? (
                <Button
                  type="button"
                  size="small"
                  disabled={disabled || busy || !available}
                  onClick={() => onAction('authorize')}
                >
                  {t('settings.mcp.authentication.authorize')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={disabled || busy || !available}
                  onClick={() => onAction('check')}
                >
                  {t('settings.mcp.authentication.check')}
                </Button>
              )
            ) : null}
            {status?.hasCredentials ? (
              <Button
                type="button"
                size="small"
                variant="ghost"
                disabled={busy || disabled || !available}
                onClick={() => onAction('signout')}
              >
                {t('settings.mcp.authentication.signout')}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {httpControls ? (
        <CollapsibleSection title={t('settings.mcp.authentication.client')}>
          <Field htmlFor={`${clientField}-id`} label={t('settings.mcp.authentication.clientId')}>
            <Input
              id={`${clientField}-id`}
              autoComplete="off"
              value={client.id}
              onChange={(event) => onClientChange({ ...client, id: event.target.value })}
            />
          </Field>
          <Field
            htmlFor={`${clientField}-secret`}
            label={t('settings.mcp.authentication.clientSecret')}
          >
            <Input
              id={`${clientField}-secret`}
              type="password"
              autoComplete="off"
              value={client.secret}
              onChange={(event) => onClientChange({ ...client, secret: event.target.value })}
            />
          </Field>
        </CollapsibleSection>
      ) : null}
      {status?.authorizationUrl ? (
        <p {...stylex.props(catalog.blockHint)}>{new URL(status.authorizationUrl).origin}</p>
      ) : null}
    </Section>
  );
}
