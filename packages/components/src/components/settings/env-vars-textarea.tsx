import type { AgentConfigEdit } from '@lody/shared';
import { Button } from '@lody/ui/button';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@lody/ui/textarea';
import { Field as UiField } from '@lody/ui/field';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  errors: { display: 'flex', flexDirection: 'column', gap: space[1] },
  error: { margin: 0, fontSize: '12px', lineHeight: 1.375, color: colors.destructive },
  help: { margin: 0, fontSize: '12px', lineHeight: 1.375, color: colors.secondaryLabel },
});

/**
 * Result of parsing environment variables from text
 */
export interface EnvVarsParseResult {
  success: boolean;
  env: Record<string, string>;
  errors: Array<{ line: number; message: string }>;
}

/**
 * Parse environment variables from KEY=VALUE text format.
 * Each line should be in the format KEY=VALUE.
 * Empty lines and lines starting with # are ignored.
 *
 * @param text - The text to parse
 * @returns Parse result with env vars or errors
 */
export function parseEnvVarsText(text: string): EnvVarsParseResult {
  const lines = text.split('\n');
  const env: Record<string, string> = {};
  const errors: Array<{ line: number; message: string }> = [];

  lines.forEach((line, index) => {
    let trimmedLine = line.trim();

    // Skip empty lines and comments
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      return;
    }

    // Support shell-style `export KEY=VALUE` by stripping the leading `export`.
    // Only strip when followed by whitespace, so we don't accidentally drop
    // variables literally named `export…`.
    if (/^export\s+/i.test(trimmedLine)) {
      trimmedLine = trimmedLine.replace(/^export\s+/i, '');
    }

    // Find the first = sign
    const equalIndex = trimmedLine.indexOf('=');

    if (equalIndex === -1) {
      errors.push({
        line: index + 1,
        message: 'Missing "=" separator',
      });
      return;
    }

    if (equalIndex === 0) {
      errors.push({
        line: index + 1,
        message: 'Empty key',
      });
      return;
    }

    const key = trimmedLine.slice(0, equalIndex).trim();
    const rawValue = trimmedLine.slice(equalIndex + 1);
    const quote = rawValue[0];
    const value =
      rawValue.length >= 2 &&
      (quote === '"' || quote === "'") &&
      rawValue[rawValue.length - 1] === quote
        ? rawValue.slice(1, -1)
        : rawValue;

    // Validate key format (alphanumeric + underscore, starts with letter or underscore)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      errors.push({
        line: index + 1,
        message: `Invalid key "${key}": must start with letter or underscore, contain only alphanumeric and underscore`,
      });
      return;
    }

    env[key] = value;
  });

  return {
    success: errors.length === 0,
    env,
    errors,
  };
}

/**
 * Convert environment variables record to KEY=VALUE text format
 *
 * @param env - Environment variables record
 * @returns Text in KEY=VALUE format
 */
export function envVarsToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export type EnvCredentialEditMode = 'keep' | 'replace' | 'clear' | 'entries';
export interface EnvVarsTextareaProps {
  /** Values here are NEW input only when credentialEdit is present. */
  credentialEdit?: {
    readonly present: boolean | undefined;
    readonly mode: EnvCredentialEditMode;
    readonly onModeChange: (mode: EnvCredentialEditMode) => void;
    readonly onEntriesChange: (entries: NonNullable<AgentConfigEdit['envEntries']>) => void;
  };
  /**
   * Current value as Record<string, string>
   */
  value: Record<string, string>;
  /**
   * Called when valid environment variables are parsed
   */
  onChange: (env: Record<string, string>) => void;
  /**
   * Called with parse errors when text is invalid
   */
  onError?: (errors: Array<{ line: number; message: string }>) => void;
  /**
   * Whether to show the label
   */
  showLabel?: boolean;
  /**
   * Custom label text
   */
  label?: string;
  /**
   * Number of rows for the textarea
   */
  rows?: number;
  /**
   * Additional class name for the container
   */
  className?: string;
  /**
   * Whether the textarea is disabled
   */
  disabled?: boolean;
}

/**
 * Environment variables textarea component.
 * Allows users to input environment variables in KEY=VALUE format.
 * Each line represents one environment variable.
 * Lines starting with # are treated as comments.
 * Empty lines are ignored.
 */
export function EnvVarsTextarea({
  value,
  credentialEdit,
  onChange,
  onError,
  showLabel = true,
  label,
  rows = 4,
  className,
  disabled = false,
}: EnvVarsTextareaProps) {
  const { t } = useTranslation();
  const [text, setText] = React.useState(() => envVarsToText(value));
  const [parseErrors, setParseErrors] = React.useState<Array<{ line: number; message: string }>>(
    []
  );

  React.useEffect(() => {
    if (credentialEdit) {
      setText('');
      setParseErrors([]);
    }
  }, [credentialEdit?.mode]);

  // Sync text when value prop changes externally
  React.useEffect(() => {
    if (credentialEdit) return;
    const currentParsed = parseEnvVarsText(text);
    const valueKeys = Object.keys(value).sort();
    const parsedKeys = Object.keys(currentParsed.env).sort();

    // Only update if the actual values differ
    if (
      JSON.stringify(valueKeys) !== JSON.stringify(parsedKeys) ||
      valueKeys.some((key) => value[key] !== currentParsed.env[key])
    ) {
      setText(envVarsToText(value));
      setParseErrors([]);
    }
  }, [value, text, credentialEdit]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

    if (credentialEdit) {
      const invalid = newText.split('\n').flatMap((line, index) => {
        const text = line.trim();
        const name =
          text.startsWith('-') || text.startsWith('?')
            ? text.slice(1).trim()
            : text.slice(0, text.indexOf('=')).trim();
        return ['__proto__', 'constructor', 'prototype'].includes(name)
          ? [{ line: index + 1, message: 'Invalid variable name' }]
          : [];
      });
      if (invalid.length) {
        setParseErrors(invalid);
        onError?.(invalid);
        return;
      }
    }

    if (credentialEdit?.mode === 'entries') {
      const errors: Array<{ line: number; message: string }> = [];
      const entries: NonNullable<AgentConfigEdit['envEntries']> = [];
      for (const [index, line] of newText.split('\n').entries()) {
        const input = line.trim();
        if (!input || input.startsWith('#')) continue;
        if (input.startsWith('-') || input.startsWith('?')) {
          const name = input.slice(1).trim();
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
            errors.push({ line: index + 1, message: 'Invalid variable name' });
          else entries.push({ name, value: { kind: input[0] === '-' ? 'clear' : 'keep' } });
        } else {
          const parsed = parseEnvVarsText(input);
          errors.push(...parsed.errors.map((error) => ({ ...error, line: index + 1 })));
          entries.push(
            ...Object.entries(parsed.env).map(([name, value]) => ({
              name,
              value: { kind: 'replace' as const, value },
            }))
          );
        }
      }
      if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
        errors.push({ line: 1, message: 'Duplicate variable name' });
      if (entries.some((entry) => ['__proto__', 'constructor', 'prototype'].includes(entry.name)))
        errors.push({ line: 1, message: 'Invalid variable name' });
      setParseErrors(errors);
      onError?.(errors);
      credentialEdit.onEntriesChange(entries);
      return;
    }
    const result = parseEnvVarsText(newText);

    if (result.success) {
      setParseErrors([]);
      onChange(result.env);
      onError?.([]);
    } else {
      setParseErrors(result.errors);
      onError?.(result.errors);
      // Still call onChange with successfully parsed vars
      onChange(result.env);
    }
  };

  const hasErrors = parseErrors.length > 0;
  const displayLabel = label ?? t('agents.envVars');
  const placeholder = t('agents.envVarsTextareaPlaceholder', {
    defaultValue: 'ENV_A=value1\nexport ENV_B=value2\n# This is a comment',
  });

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      {showLabel && <UiField.Label>{displayLabel}</UiField.Label>}
      {credentialEdit && (
        <>
          <p {...stylex.props(styles.help)}>
            {credentialEdit.present === undefined
              ? t('settings.agent.credentials.stateUnknown', 'Saved variable state is unavailable.')
              : credentialEdit.present
                ? t(
                    'settings.agent.credentials.present',
                    'Saved variables are present. Their values stay on the machine.'
                  )
                : t('settings.agent.credentials.absent', 'No saved variables.')}
          </p>
          <div
            role="group"
            aria-label={t('settings.agent.credentials.envAction', 'Saved variable action')}
          >
            {(['keep', 'replace', 'clear', 'entries'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="small"
                variant={credentialEdit.mode === mode ? 'secondary' : 'ghost'}
                aria-pressed={credentialEdit.mode === mode}
                disabled={disabled}
                onClick={() => {
                  setText('');
                  setParseErrors([]);
                  onError?.([]);
                  onChange({});
                  credentialEdit.onEntriesChange([]);
                  credentialEdit.onModeChange(mode);
                }}
              >
                {t(`settings.agent.credentials.env.${mode}`, {
                  defaultValue: {
                    keep: 'Keep saved',
                    replace: 'Replace all',
                    clear: 'Clear all',
                    entries: 'Change individual keys',
                  }[mode],
                })}
              </Button>
            ))}
          </div>
        </>
      )}
      {(!credentialEdit ||
        credentialEdit.mode === 'replace' ||
        credentialEdit.mode === 'entries') && (
        <Textarea
          aria-label={displayLabel}
          value={text}
          onChange={handleChange}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          // The well rings destructive from `aria-invalid`, so what a screen
          // reader hears and what is drawn are one fact.
          aria-invalid={hasErrors || undefined}
        />
      )}
      {hasErrors && (
        <div {...stylex.props(styles.errors)}>
          {parseErrors.map((error, index) => (
            <p key={index} {...stylex.props(styles.error)}>
              {t('agents.envVarsLineError', {
                line: error.line,
                message: error.message,
                defaultValue: `Line ${error.line}: ${error.message}`,
              })}
            </p>
          ))}
        </div>
      )}
      <p {...stylex.props(styles.help)}>
        {credentialEdit?.mode === 'entries'
          ? t(
              'settings.agent.credentials.keyHelp',
              'KEY=value replaces one value; -KEY clears it; ?KEY keeps it. Other saved variables are kept.'
            )
          : credentialEdit && credentialEdit.mode !== 'replace'
            ? null
            : t('agents.envVarsTextareaHelp', {
                defaultValue:
                  'One variable per line in KEY=VALUE format. A leading "export" and matching quotes around values are stripped automatically. Lines starting with # are comments.',
              })}
      </p>
    </div>
  );
}
