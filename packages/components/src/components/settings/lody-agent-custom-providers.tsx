import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { settingsRecordsCard } from './compact-layout';

export type LodyAgentProviderProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions';

/** One custom Provider as Sorbet stores it; Lody only names the endpoint and its models. */
export interface LodyAgentCustomProvider {
  id: string;
  name: string;
  protocol: LodyAgentProviderProtocol;
  baseUrl: string;
  models: readonly { id: string; name?: string }[];
}

export interface LodyAgentCustomProviderDraft {
  name: string;
  protocol: LodyAgentProviderProtocol;
  baseUrl: string;
  models: readonly { id: string }[];
}

export interface LodyAgentCustomProvidersProps {
  status: 'loading' | 'error' | 'unsupported' | 'ready';
  providers: readonly LodyAgentCustomProvider[];
  error?: string | null;
  removingProviderId?: string | null;
  creating?: boolean;
  onRefresh: () => void;
  onRemove: (provider: LodyAgentCustomProvider) => void;
  onCreate?: (draft: LodyAgentCustomProviderDraft) => void;
}

/** The agent's protocol names are wire identifiers; a person reads the vendor and shape. */
const PROTOCOL_LABEL: Record<LodyAgentProviderProtocol, string> = {
  'openai-completions': 'OpenAI chat completions',
  'openai-responses': 'OpenAI responses',
  'anthropic-messages': 'Anthropic messages',
};

const PROTOCOLS: readonly LodyAgentProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

const styles = stylex.create({
  container: { display: 'flex', flexDirection: 'column', gap: space[2] },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  actions: { display: 'flex', alignItems: 'center', gap: space[2] },
  description: { margin: 0, color: colors.secondaryLabel, fontSize: text.footnoteSize },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    padding: space[3],
  },
  identity: { minWidth: 0, overflowWrap: 'anywhere' },
  error: { margin: 0, color: colors.destructive },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    border: `1px solid ${colors.separator}`,
    borderRadius: 8,
  },
  field: { display: 'flex', flexDirection: 'column', gap: space[1] },
  input: {
    padding: space[2],
    borderRadius: 6,
    border: `1px solid ${colors.separator}`,
    background: colors.background,
    color: colors.label,
    fontSize: text.footnoteSize,
  },
});

/**
 * Custom Providers are endpoints Lody names for Sorbet. The definition is stored by the
 * agent, so a Provider created here survives restarts and is offered to later processes.
 */
export function LodyAgentCustomProviders({
  status,
  providers,
  error,
  removingProviderId,
  creating = false,
  onRefresh,
  onRemove,
  onCreate,
}: LodyAgentCustomProvidersProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<LodyAgentCustomProvider | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<LodyAgentProviderProtocol>('openai-completions');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const pending = removingProviderId != null;
  const disabled = status !== 'ready' || pending || creating;
  const draftModels = models
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const canSubmit =
    !disabled && name.trim().length > 0 && baseUrl.trim().length > 0 && draftModels.length > 0;
  const reset = () => {
    setDrafting(false);
    setName('');
    setBaseUrl('');
    setModels('');
    setProtocol('openai-completions');
  };
  return (
    <section {...stylex.props(styles.container)} aria-label={t('lodyAgentProviders.title')}>
      <div {...stylex.props(styles.header)}>
        <strong>{t('lodyAgentProviders.title')}</strong>
        <div {...stylex.props(styles.actions)}>
          <Button
            size="small"
            variant="secondary"
            onClick={onRefresh}
            disabled={status === 'loading' || status === 'unsupported' || pending}
          >
            {t('lodyAgentProviders.refresh')}
          </Button>
          {onCreate ? (
            <Button size="small" onClick={() => setDrafting(true)} disabled={disabled}>
              {t('lodyAgentProviders.add')}
            </Button>
          ) : null}
        </div>
      </div>
      <p {...stylex.props(styles.description)}>{t('lodyAgentProviders.description')}</p>
      {status === 'loading' && <p role="status">{t('lodyAgentProviders.loading')}</p>}
      {status === 'unsupported' && <p>{t('lodyAgentProviders.unsupported')}</p>}
      {status === 'error' && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error || t('lodyAgentProviders.error')}
        </p>
      )}
      {status === 'ready' && (
        <>
          {error ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          ) : null}
          {providers.length === 0 ? (
            <p>{t('lodyAgentProviders.empty')}</p>
          ) : (
            <div {...stylex.props(settingsRecordsCard)}>
              {providers.map((provider) => (
                <div key={provider.id} {...stylex.props(styles.row)}>
                  <div {...stylex.props(styles.identity)}>
                    <div>{provider.name}</div>
                    <div {...stylex.props(styles.description)}>
                      {PROTOCOL_LABEL[provider.protocol]} · {provider.baseUrl} ·{' '}
                      {t('lodyAgentProviders.modelCount', { count: provider.models.length })}
                    </div>
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending}
                    aria-label={t('lodyAgentProviders.removeLabel', { name: provider.name })}
                    onClick={() => setSelected(provider)}
                  >
                    {t('lodyAgentProviders.remove')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {drafting ? (
            <form
              {...stylex.props(styles.form)}
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmit) return;
                onCreate?.({
                  name: name.trim(),
                  protocol,
                  baseUrl: baseUrl.trim(),
                  models: draftModels.map((id) => ({ id })),
                });
                reset();
              }}
            >
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.description)}>
                  {t('lodyAgentProviders.nameLabel')}
                </span>
                <input
                  {...stylex.props(styles.input)}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Acme Gateway"
                  required
                />
              </label>
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.description)}>
                  {t('lodyAgentProviders.protocolLabel')}
                </span>
                <select
                  {...stylex.props(styles.input)}
                  value={protocol}
                  onChange={(event) => setProtocol(event.target.value as LodyAgentProviderProtocol)}
                >
                  {PROTOCOLS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.description)}>
                  {t('lodyAgentProviders.baseUrlLabel')}
                </span>
                <input
                  {...stylex.props(styles.input)}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://gateway.example.com/v1"
                  required
                />
              </label>
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.description)}>
                  {t('lodyAgentProviders.modelsLabel')}
                </span>
                <input
                  {...stylex.props(styles.input)}
                  value={models}
                  onChange={(event) => setModels(event.target.value)}
                  placeholder="acme-large, acme-small"
                  required
                />
              </label>
              <div {...stylex.props(styles.actions)}>
                <Button size="small" type="submit" disabled={!canSubmit}>
                  {creating ? t('lodyAgentProviders.saving') : t('lodyAgentProviders.save')}
                </Button>
                <Button size="small" variant="secondary" onClick={reset} disabled={creating}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : null}
        </>
      )}
      <AlertDialog.Root
        open={selected !== null && status === 'ready'}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('lodyAgentProviders.confirmTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('lodyAgentProviders.confirmDescription', { name: selected?.name })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={pending}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={pending || !selected}
              onClick={() => {
                if (selected) {
                  onRemove(selected);
                  setSelected(null);
                }
              }}
            >
              {t('lodyAgentProviders.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </section>
  );
}
