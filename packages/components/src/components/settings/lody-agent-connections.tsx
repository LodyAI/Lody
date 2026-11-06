import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { KeyRound, Plus, Server, Trash2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Radio, RadioGroup } from '@lody/ui/radio';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { CompactSection } from './compact-layout';
import { Field, FormMessage } from './form-primitives';
import { settingsCatalog as catalog } from './surface';

export interface LodyAgentCredential {
  providerId: string;
  type: string;
}

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
}

/**
 * What removing a connection asks of the agent: an account is a saved credential to
 * log out, an endpoint is a Provider definition that takes its own key with it.
 */
export type LodyAgentConnectionRef = { kind: 'account' | 'endpoint'; id: string };

export interface LodyAgentConnectionsProps {
  status: 'loading' | 'error' | 'unsupported' | 'ready';
  credentials: readonly LodyAgentCredential[];
  providers: readonly LodyAgentCustomProvider[];
  /** Connections whose removal was sent but never confirmed; they stay until a re-read. */
  uncertainRemovalIds: readonly string[];
  removingId?: string | null;
  onRetry: () => void;
  onRemove: (connection: LodyAgentConnectionRef) => void;
  /** Rejects when the agent did not store the endpoint; the form keeps the draft. */
  onCreate?: (draft: LodyAgentCustomProviderDraft) => Promise<void>;
  /** The agent's sign-in methods, drawn as the last lines of the same card. */
  signIn?: ReactNode;
  endpointSignIn?: (provider: LodyAgentCustomProvider) => ReactNode;
}

type Connection = LodyAgentConnectionRef & { name: string; meta: string; attention: boolean };

/** Vendor and request shape are what a person recognises; the wire names are not. */
const PROTOCOLS: readonly { value: LodyAgentProviderProtocol; labelKey: string }[] = [
  { value: 'openai-completions', labelKey: 'lodyAgentConnections.protocol.openaiCompletions' },
  { value: 'openai-responses', labelKey: 'lodyAgentConnections.protocol.openaiResponses' },
  { value: 'anthropic-messages', labelKey: 'lodyAgentConnections.protocol.anthropicMessages' },
];

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    paddingInlineStart: space[4],
    paddingBlock: space[2],
  },
  attention: { color: colors.warning },
  note: {
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    color: colors.secondaryLabel,
  },
  protocol: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: '13px',
    lineHeight: 1.375,
    color: colors.label,
    cursor: 'pointer',
  },
  noteWithAction: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingInlineEnd: space[3],
  },
});

/**
 * Where Lody Agent gets its models on one machine: saved account sign-ins and the
 * custom endpoints Lody named for it, read as one list. An endpoint's API key is
 * stored under the endpoint's own id, so it is part of that endpoint, not an account.
 */
export function LodyAgentConnections({
  status,
  credentials,
  providers,
  uncertainRemovalIds,
  removingId,
  onRetry,
  onRemove,
  onCreate,
  signIn,
  endpointSignIn,
}: LodyAgentConnectionsProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const endpointIds = new Set(providers.map((provider) => provider.id));
  const keyed = new Set(credentials.map((credential) => credential.providerId));
  const connections: Connection[] = [
    ...credentials
      .filter((credential) => !endpointIds.has(credential.providerId))
      .map((credential) => ({
        kind: 'account' as const,
        id: credential.providerId,
        name: credential.providerId,
        meta:
          credential.type === 'oauth'
            ? t('lodyAgentConnections.signedIn')
            : credential.type === 'api_key' || credential.type === 'api-key'
              ? t('lodyAgentConnections.apiKey')
              : t('lodyAgentConnections.savedCredential'),
        attention: false,
      })),
    ...providers.map((provider) => ({
      kind: 'endpoint' as const,
      id: provider.id,
      name: provider.name,
      meta: keyed.has(provider.id)
        ? t('lodyAgentConnections.endpoint')
        : t('lodyAgentConnections.needsKey'),
      attention: !keyed.has(provider.id),
    })),
  ];
  const busy = removingId != null;
  const uncertain = new Set(uncertainRemovalIds);
  // A refresh keeps whatever was read last: the list only gives way to a message
  // when there is nothing to show, and a first read draws nothing at all.
  const lines =
    status === 'unsupported'
      ? [
          <p key="unsupported" {...stylex.props(styles.note)}>
            {t('lodyAgentConnections.unsupported')}
          </p>,
        ]
      : connections.length > 0
        ? connections.map((connection) => (
            <div
              key={`${connection.kind}:${connection.id}`}
              data-connection-id={connection.id}
              {...stylex.props(styles.row)}
            >
              <span {...stylex.props(catalog.glyph)} aria-hidden="true">
                {connection.kind === 'endpoint' ? (
                  <Server {...stylex.props(catalog.icon)} />
                ) : (
                  <KeyRound {...stylex.props(catalog.icon)} />
                )}
              </span>
              <div {...stylex.props(catalog.body)}>
                <span {...stylex.props(catalog.name)}>{connection.name}</span>
                <span
                  {...stylex.props(
                    catalog.meta,
                    (connection.attention || uncertain.has(connection.id)) && styles.attention
                  )}
                >
                  {uncertain.has(connection.id)
                    ? t('lodyAgentConnections.uncertain')
                    : connection.meta}
                </span>
              </div>
              <div {...stylex.props(catalog.actions)}>
                {connection.kind === 'endpoint' && !uncertain.has(connection.id)
                  ? endpointSignIn?.(providers.find((provider) => provider.id === connection.id)!)
                  : null}
                {uncertain.has(connection.id) ? (
                  <Button size="small" variant="secondary" disabled={busy} onClick={onRetry}>
                    {t('lodyAgentConnections.checkAgain')}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="ghost"
                    icon
                    disabled={busy || status !== 'ready'}
                    aria-label={t('lodyAgentConnections.removeLabel', { name: connection.name })}
                    onClick={() => setConfirming(connection)}
                  >
                    <Trash2 {...stylex.props(catalog.icon)} />
                  </Button>
                )}
              </div>
            </div>
          ))
        : status === 'error'
          ? [
              <div key="error" {...stylex.props(styles.note, styles.noteWithAction)}>
                <span role="alert">{t('lodyAgentConnections.error')}</span>
                <Button size="small" variant="secondary" onClick={onRetry}>
                  {t('lodyAgentConnections.retry')}
                </Button>
              </div>,
            ]
          : status === 'ready' && !signIn
            ? [
                <p key="empty" {...stylex.props(styles.note)}>
                  {t('lodyAgentConnections.empty')}
                </p>,
              ]
            : [];

  return (
    <>
      {lines.length > 0 || signIn ? (
        <CompactSection
          boxed
          title={t('lodyAgentConnections.title')}
          headerRightUnclipped
          headerRight={
            onCreate ? (
              <Button
                size="small"
                variant="secondary"
                disabled={status === 'unsupported'}
                onClick={() => setAdding(true)}
              >
                <Plus {...stylex.props(catalog.icon)} />
                {t('lodyAgentConnections.add')}
              </Button>
            ) : null
          }
        >
          {lines}
          {signIn ?? null}
        </CompactSection>
      ) : null}

      {onCreate ? (
        <Dialog.Root open={adding} onOpenChange={setAdding}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{t('lodyAgentConnections.addTitle')}</Dialog.Title>
            </Dialog.Header>
            {adding ? (
              <EndpointForm
                onCancel={() => setAdding(false)}
                onSubmit={async (draft) => {
                  await onCreate(draft);
                  setAdding(false);
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Root>
      ) : null}

      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('lodyAgentConnections.confirmTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {confirming?.kind === 'endpoint'
                ? t('lodyAgentConnections.confirmEndpoint', { name: confirming.name })
                : t('lodyAgentConnections.confirmAccount', { name: confirming?.name })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={busy || !confirming}
              onClick={() => {
                if (!confirming) return;
                onRemove({ kind: confirming.kind, id: confirming.id });
                setConfirming(null);
              }}
            >
              {t('lodyAgentConnections.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function EndpointForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (draft: LodyAgentCustomProviderDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<LodyAgentProviderProtocol>('openai-completions');
  const [baseUrl, setBaseUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const complete = name.trim().length > 0 && baseUrl.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      await onSubmit({
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
      });
    } catch {
      setFailed(true);
      setSubmitting(false);
    }
  };

  return (
    <form {...stylex.props(catalog.editorForm)} onSubmit={(event) => void submit(event)}>
      <div {...stylex.props(catalog.editorBody)}>
        <Field htmlFor={`${id}-name`} label={t('lodyAgentConnections.nameLabel')}>
          <Input
            id={`${id}-name`}
            required
            autoComplete="off"
            placeholder={t('lodyAgentConnections.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field labelId={`${id}-protocol`} label={t('lodyAgentConnections.protocolLabel')}>
          <RadioGroup
            aria-labelledby={`${id}-protocol`}
            value={protocol}
            onValueChange={(next) => {
              if (typeof next === 'string') setProtocol(next as LodyAgentProviderProtocol);
            }}
          >
            {PROTOCOLS.map((option) => (
              <label key={option.value} {...stylex.props(styles.protocol)}>
                <Radio value={option.value} />
                {t(option.labelKey)}
              </label>
            ))}
          </RadioGroup>
        </Field>
        <Field htmlFor={`${id}-url`} label={t('lodyAgentConnections.baseUrlLabel')}>
          <Input
            id={`${id}-url`}
            required
            type="url"
            autoComplete="off"
            placeholder={t('lodyAgentConnections.baseUrlPlaceholder')}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        {failed ? (
          <FormMessage tone="error">{t('lodyAgentConnections.createFailed')}</FormMessage>
        ) : null}
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!complete || submitting}>
          {t('lodyAgentConnections.add')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}
