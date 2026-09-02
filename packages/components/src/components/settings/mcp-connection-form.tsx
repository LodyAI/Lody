import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { McpConnectionSpec, McpTransport, WorkspaceMcpServerMeta } from '@lody/shared';
import {
  MCP_TRANSPORT_SHORT_LABELS,
  MCP_TRANSPORTS,
  McpTransportIcon,
} from '@/components/shared/mcp-transport';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';
import { Field, Section } from './form-primitives';

type KeyValueDraft = { key: string; value: string };

type McpConnectionFormDraft = {
  name: string;
  description: string;
  transport: McpTransport;
  enabledByDefault: boolean;
  command: string;
  args: string[];
  env: KeyValueDraft[];
  envPassthrough: string[];
  url: string;
  bearerToken: string;
  headers: KeyValueDraft[];
};

export type McpConnectionFormValue = {
  name: string;
  description?: string;
  transport: McpTransport;
  enabledByDefault: boolean;
  connection?: McpConnectionSpec;
};

const emptyConnectionFields = (transport: McpTransport) => ({
  command: '',
  args: transport === 'stdio' ? [''] : [],
  env: [] as KeyValueDraft[],
  envPassthrough: [] as string[],
  url: '',
  bearerToken: '',
  headers: [] as KeyValueDraft[],
});

const createMcpConnectionFormDraft = (entry?: WorkspaceMcpServerMeta): McpConnectionFormDraft => {
  const transport = entry?.transport ?? 'stdio';
  const connection = entry?.connection;
  return {
    name: entry?.name ?? '',
    description: entry?.description ?? '',
    transport,
    enabledByDefault: entry?.enabledByDefault ?? false,
    ...emptyConnectionFields(transport),
    ...(connection?.transport === 'stdio'
      ? {
          command: connection.command,
          args: connection.args?.length ? [...connection.args] : [''],
          env: Object.entries(connection.env ?? {}).map(([key, value]) => ({ key, value })),
          envPassthrough: connection.envPassthrough?.length ? [...connection.envPassthrough] : [],
        }
      : connection?.transport === 'http'
        ? {
            url: connection.url,
            bearerToken: connection.bearerToken ?? '',
            headers: Object.entries(connection.headers ?? {}).map(([key, value]) => ({
              key,
              value,
            })),
          }
        : {}),
  };
};

const compactRecord = (rows: readonly KeyValueDraft[]): Record<string, string> | undefined => {
  const entries = rows
    .map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const buildStdioConnection = (draft: McpConnectionFormDraft): McpConnectionSpec | undefined => {
  const command = draft.command.trim();
  if (!command) return undefined;
  const args = draft.args.filter((arg) => arg.length > 0);
  const env = compactRecord(draft.env);
  const envPassthrough = [...new Set(draft.envPassthrough.map((name) => name.trim()))].filter(
    Boolean
  );
  return {
    transport: 'stdio',
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(env ? { env } : {}),
    ...(envPassthrough.length > 0 ? { envPassthrough } : {}),
  };
};

const buildHttpConnection = (draft: McpConnectionFormDraft): McpConnectionSpec | undefined => {
  const url = draft.url.trim();
  if (!url) return undefined;
  const headers = compactRecord(draft.headers);
  const bearerToken = draft.bearerToken || undefined;
  return {
    transport: 'http',
    url,
    ...(bearerToken ? { bearerToken } : {}),
    ...(headers ? { headers } : {}),
  };
};

const buildMcpConnectionFormValue = (draft: McpConnectionFormDraft): McpConnectionFormValue => {
  const description = draft.description.trim() || undefined;
  const connection =
    draft.transport === 'stdio' ? buildStdioConnection(draft) : buildHttpConnection(draft);
  return {
    name: draft.name.trim(),
    ...(description ? { description } : {}),
    transport: draft.transport,
    enabledByDefault: draft.enabledByDefault,
    ...(connection ? { connection } : {}),
  };
};

/** Server editor body: a scrolling field stack plus the sticky action footer.
 *  It is sized by its container (the settings dialog), so it stays a plain
 *  `flex` column instead of owning any width or backdrop of its own. */
export function McpConnectionForm({
  initialEntry,
  submitting = false,
  error,
  onSubmit,
  onCancel,
  className,
}: {
  initialEntry?: WorkspaceMcpServerMeta;
  submitting?: boolean;
  error?: string;
  onSubmit: (value: McpConnectionFormValue) => void | Promise<void>;
  onCancel: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [draft, setDraft] = useState(() => createMcpConnectionFormDraft(initialEntry));
  const setTransport = (transport: McpTransport) => {
    setDraft((current) => ({
      name: current.name,
      description: current.description,
      enabledByDefault: current.enabledByDefault,
      transport,
      ...emptyConnectionFields(transport),
    }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSubmit(buildMcpConnectionFormValue(draft));
  };
  const isStdio = draft.transport === 'stdio';

  return (
    <form className={cn('flex min-h-0 flex-col', className)} onSubmit={submit}>
      <div className="scrollbar-pro min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <Section title={t('settings.mcp.form.sectionIdentity')}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field htmlFor={`${fieldId}-name`} label={t('settings.mcp.form.name')}>
              <Input
                id={`${fieldId}-name`}
                required
                autoComplete="off"
                className="h-9"
                placeholder={t('settings.mcp.form.namePlaceholder')}
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </Field>
            <Field label={t('settings.mcp.form.transport')}>
              <TransportToggle value={draft.transport} onChange={setTransport} />
            </Field>
          </div>
          <Field
            htmlFor={`${fieldId}-description`}
            label={t('settings.mcp.form.description')}
            hint={t('settings.mcp.form.descriptionHint')}
          >
            <Textarea
              id={`${fieldId}-description`}
              rows={2}
              className="resize-none"
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
        </Section>

        <Section
          title={t('settings.mcp.form.sectionConnection')}
          hint={t('settings.mcp.form.envHint')}
        >
          {isStdio ? (
            <>
              <Field
                htmlFor={`${fieldId}-command`}
                label={t('settings.mcp.form.command')}
                icon={<McpTransportIcon transport="stdio" />}
              >
                <Input
                  id={`${fieldId}-command`}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                  placeholder="/absolute/path/to/mcp-server"
                  value={draft.command}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, command: event.target.value }))
                  }
                />
              </Field>
              <StringListEditor
                label={t('settings.mcp.form.arguments')}
                addLabel={t('settings.mcp.form.addArgument')}
                values={draft.args}
                placeholder="--flag"
                onChange={(args) => setDraft((current) => ({ ...current, args }))}
              />
              <KeyValueEditor
                label={t('settings.mcp.form.environment')}
                addLabel={t('settings.mcp.form.addEnvironment')}
                rows={draft.env}
                onChange={(env) => setDraft((current) => ({ ...current, env }))}
              />
              <StringListEditor
                label={t('settings.mcp.form.envPassthrough')}
                addLabel={t('settings.mcp.form.addPassthrough')}
                hint={t('settings.mcp.form.envPassthroughHint')}
                values={draft.envPassthrough}
                placeholder="API_TOKEN"
                onChange={(envPassthrough) =>
                  setDraft((current) => ({ ...current, envPassthrough }))
                }
              />
            </>
          ) : (
            <>
              <Field
                htmlFor={`${fieldId}-url`}
                label={t('settings.mcp.form.url')}
                icon={<McpTransportIcon transport="http" />}
              >
                <Input
                  id={`${fieldId}-url`}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                  placeholder="https://mcp.example.com/mcp"
                  value={draft.url}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, url: event.target.value }))
                  }
                />
              </Field>
              <Field
                htmlFor={`${fieldId}-token`}
                label={t('settings.mcp.form.bearerToken')}
                icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                <Input
                  id={`${fieldId}-token`}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                  placeholder="${MCP_TOKEN}"
                  value={draft.bearerToken}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, bearerToken: event.target.value }))
                  }
                />
              </Field>
              <KeyValueEditor
                label={t('settings.mcp.form.headers')}
                addLabel={t('settings.mcp.form.addHeader')}
                rows={draft.headers}
                keyPlaceholder="X-Header"
                onChange={(headers) => setDraft((current) => ({ ...current, headers }))}
              />
            </>
          )}
        </Section>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-card/60 px-3 py-2.5">
          <div className="min-w-0">
            <Label htmlFor={`${fieldId}-default`} className="text-sm">
              {t('settings.mcp.form.defaultEnabled')}
            </Label>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {t('settings.mcp.form.defaultEnabledHint')}
            </p>
          </div>
          <Switch
            id={`${fieldId}-default`}
            checked={draft.enabledByDefault}
            onCheckedChange={(enabledByDefault) =>
              setDraft((current) => ({ ...current, enabledByDefault }))
            }
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={submitting}
          onClick={onCancel}
        >
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="small" disabled={submitting || draft.name.trim().length === 0}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {submitting ? t('settings.mcp.form.saving') : t('common.save')}
        </Button>
      </footer>
    </form>
  );
}

/** Two-state transport switch. Same segmented grammar as the other binary
 *  settings controls, so it reads as one control rather than a dropdown. */
function TransportToggle({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (transport: McpTransport) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t('settings.mcp.form.transport')}
      className="inline-grid h-9 grid-cols-2 rounded-full border border-border/70 bg-muted/60 p-0.5"
    >
      {MCP_TRANSPORTS.map((transport) => {
        const selected = value === transport;
        return (
          <button
            key={transport}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(transport)}
            className={cn(
              'flex min-w-20 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <McpTransportIcon transport={transport} />
            {MCP_TRANSPORT_SHORT_LABELS[transport]}
          </button>
        );
      })}
    </div>
  );
}

/** Shared frame for the repeatable rows (arguments, passthrough, key/value):
 *  label, the rows themselves, then one quiet add affordance. */
function ListEditor({
  label,
  hint,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  hint?: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-1.5">
        {children}
        <Button type="button" variant="ghost" size="small" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
    </Field>
  );
}

function RemoveRowButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      icon
      tone="destructive"
      className="shrink-0"
      aria-label={t('common.remove')}
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}

function StringListEditor({
  label,
  addLabel,
  values,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  addLabel: string;
  values: string[];
  placeholder: string;
  hint?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <ListEditor
      label={label}
      hint={hint}
      addLabel={addLabel}
      onAdd={() => onChange([...values, ''])}
    >
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={(event) =>
              onChange(
                values.map((item, itemIndex) => (itemIndex === index ? event.target.value : item))
              )
            }
          />
          <RemoveRowButton
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          />
        </div>
      ))}
    </ListEditor>
  );
}

function KeyValueEditor({
  label,
  addLabel,
  rows,
  keyPlaceholder,
  onChange,
}: {
  label: string;
  addLabel: string;
  rows: KeyValueDraft[];
  keyPlaceholder?: string;
  onChange: (rows: KeyValueDraft[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <ListEditor
      label={label}
      addLabel={addLabel}
      onAdd={() => onChange([...rows, { key: '', value: '' }])}
    >
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-1.5"
        >
          <Input
            aria-label={t('settings.mcp.form.key')}
            placeholder={keyPlaceholder ?? t('settings.mcp.form.key')}
            value={row.key}
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, key: event.target.value } : item
                )
              )
            }
          />
          <Input
            aria-label={t('settings.mcp.form.value')}
            placeholder={t('settings.mcp.form.value')}
            value={row.value}
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item
                )
              )
            }
          />
          <RemoveRowButton
            onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}
          />
        </div>
      ))}
    </ListEditor>
  );
}
