import { useEffect, useId, useState, type FormEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ClipboardPaste } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Field } from '@lody/ui/field';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import {
  IOS_SIMULATOR_TEXT_MAX_LENGTH,
  IOS_SIMULATOR_URL_MAX_LENGTH,
  validateIosSimulatorText,
  validateIosSimulatorUrl,
} from '@/lib/ios-simulator/ios-simulator-controls';

export type IosSimulatorInputKind = 'text' | 'url';

export type IosSimulatorInputDialogProps = {
  /** Which input is open; null closes the dialog. */
  kind: IosSimulatorInputKind | null;
  deviceName: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sends the value to the device. Resolves true when it arrived. */
  onSubmit: (kind: IosSimulatorInputKind, value: string) => Promise<boolean>;
};

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space[3] },
  meta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  count: { fontVariantNumeric: 'tabular-nums' },
});

async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Typing into the simulator, or opening a URL or deep link in it. Nothing is
 * read from the clipboard until the person asks, and nothing reaches the device
 * until they submit: this is a form, not a live keyboard bridge.
 */
export function IosSimulatorInputDialog({
  kind,
  deviceName,
  busy = false,
  onOpenChange,
  onSubmit,
}: IosSimulatorInputDialogProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);

  // Each opening starts empty: a URL typed for one app is not the next one's.
  useEffect(() => {
    if (kind === null) return;
    setValue('');
    setTouched(false);
    setPasteFailed(false);
  }, [kind]);

  const textProblem = kind === 'text' ? validateIosSimulatorText(value) : null;
  const urlProblem = kind === 'url' ? validateIosSimulatorUrl(value) : null;
  const problem = textProblem ?? urlProblem;
  const problemMessage =
    problem === 'too-long'
      ? kind === 'text'
        ? t('sessions.iosSimulator.input.textTooLong', 'Keep it under {{count}} characters.', {
            count: IOS_SIMULATOR_TEXT_MAX_LENGTH,
          })
        : t('sessions.iosSimulator.input.urlTooLong', 'Keep it under {{count}} characters.', {
            count: IOS_SIMULATOR_URL_MAX_LENGTH,
          })
      : problem === 'invalid'
        ? t(
            'sessions.iosSimulator.input.urlInvalid',
            'Enter a full address with its scheme, like https://example.com or myapp://path.'
          )
        : problem === 'scheme'
          ? t(
              'sessions.iosSimulator.input.urlScheme',
              'That kind of link can’t be opened on the simulator.'
            )
          : null;
  const showProblem = touched && problem !== null && problem !== 'empty';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!kind || problem !== null || busy) return;
    const delivered = await onSubmit(kind, kind === 'url' ? value.trim() : value);
    if (delivered) onOpenChange(false);
  };

  const paste = async () => {
    const clipboard = await readClipboardText();
    if (clipboard === null) {
      setPasteFailed(true);
      return;
    }
    setPasteFailed(false);
    setValue((current) => current + clipboard);
  };

  return (
    <Dialog.Root open={kind !== null} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {kind === 'url'
              ? t('sessions.iosSimulator.input.urlTitle', 'Open on {{device}}', {
                  device: deviceName,
                })
              : t('sessions.iosSimulator.input.textTitle', 'Type on {{device}}', {
                  device: deviceName,
                })}
          </Dialog.Title>
          <Dialog.Description>
            {kind === 'url'
              ? t(
                  'sessions.iosSimulator.input.urlDescription',
                  'A web address opens in Safari; an app’s own link opens that app.'
                )
              : t(
                  'sessions.iosSimulator.input.textDescription',
                  'The text is typed into whatever field has focus on the simulator.'
                )}
          </Dialog.Description>
        </Dialog.Header>
        <form {...stylex.props(styles.form)} onSubmit={(event) => void submit(event)}>
          <Field.Root invalid={showProblem}>
            <Field.Label htmlFor={fieldId}>
              {kind === 'url'
                ? t('sessions.iosSimulator.input.urlLabel', 'URL or deep link')
                : t('sessions.iosSimulator.input.textLabel', 'Text')}
            </Field.Label>
            {kind === 'url' ? (
              <Input
                id={fieldId}
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                placeholder="https://example.com"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => setTouched(true)}
              />
            ) : (
              <Textarea
                id={fieldId}
                autoFocus
                rows={4}
                resize="vertical"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => setTouched(true)}
              />
            )}
            {showProblem ? <Field.Error match>{problemMessage}</Field.Error> : null}
          </Field.Root>
          {kind === 'text' ? (
            <div {...stylex.props(styles.meta)}>
              <Button type="button" variant="ghost" size="mini" onClick={() => void paste()}>
                <ClipboardPaste size={12} aria-hidden />
                {pasteFailed
                  ? t('sessions.iosSimulator.input.pasteFailed', 'Clipboard unavailable')
                  : t('sessions.iosSimulator.input.paste', 'Paste from clipboard')}
              </Button>
              <span {...stylex.props(styles.count)}>
                {value.length} / {IOS_SIMULATOR_TEXT_MAX_LENGTH}
              </span>
            </div>
          ) : null}
          <Dialog.Footer>
            <Dialog.Close render={<Button type="button" variant="secondary" size="small" />}>
              {t('common.cancel', 'Cancel')}
            </Dialog.Close>
            <Button
              type="submit"
              variant="primary"
              size="small"
              disabled={busy || problem === 'empty'}
            >
              {kind === 'url'
                ? t('sessions.iosSimulator.input.open', 'Open')
                : t('sessions.iosSimulator.input.type', 'Type')}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
