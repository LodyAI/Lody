import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { cn } from '@/lib/utils';

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

export interface EnvVarsTextareaProps {
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

  // Sync text when value prop changes externally
  React.useEffect(() => {
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
  }, [value, text]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

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
    <div className={cn('space-y-2', className)}>
      {showLabel && <Label>{displayLabel}</Label>}
      <Textarea
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={cn(
          'font-mono text-sm',
          hasErrors && 'border-destructive focus-visible:ring-destructive'
        )}
      />
      {hasErrors && (
        <div className="space-y-1">
          {parseErrors.map((error, index) => (
            <p key={index} className="text-xs text-destructive">
              {t('agents.envVarsLineError', {
                line: error.line,
                message: error.message,
                defaultValue: `Line ${error.line}: ${error.message}`,
              })}
            </p>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t('agents.envVarsTextareaHelp', {
          defaultValue:
            'One variable per line in KEY=VALUE format. A leading "export" and matching quotes around values are stripped automatically. Lines starting with # are comments.',
        })}
      </p>
    </div>
  );
}
