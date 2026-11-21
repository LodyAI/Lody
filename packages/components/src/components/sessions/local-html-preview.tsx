import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { AlertDialog } from '@/ui/dialog';

const styles = stylex.create({
  frame: {
    display: 'block',
    width: '100%',
    height: '100%',
    minHeight: 0,
    borderWidth: 0,
    backgroundColor: 'white',
  },
  option: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1.45,
  },
  optionText: { display: 'flex', flexDirection: 'column', gap: 2 },
  optionHint: { color: 'hsl(var(--muted-foreground))', fontSize: 12 },
});

/**
 * Desktop-only, same-machine HTML preview. The page is served by Electron main
 * from its own `lody-html-preview://<token>/` origin, so relative CSS, scripts
 * and images resolve next to the file, while the page can never reach the
 * renderer (different origin, no preload, no popups, no top navigation).
 */
export function LocalHtmlPreviewFrame({
  url,
  allowScripts,
  title,
}: {
  readonly url: string;
  readonly allowScripts: boolean;
  readonly title: string;
}) {
  return (
    <iframe
      {...stylex.props(styles.frame)}
      title={title}
      src={url}
      // Without consent the frame stays fully sandboxed: no scripts or forms.
      // With consent the page keeps its own origin so storage, fetch and module
      // scripts behave as they would when opened directly. Modal dialogs stay
      // off so a page cannot block Lody's window with alert loops.
      sandbox={allowScripts ? 'allow-scripts allow-same-origin allow-forms' : ''}
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'"
    />
  );
}

/** Asks once per preview entry; scripts stay off unless the user ticks the box. */
export function LocalHtmlPreviewConsentDialog({
  open,
  fileName,
  workspaceRoot,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly fileName: string;
  readonly workspaceRoot?: string | null;
  readonly onConfirm: (allowScripts: boolean, workspaceRoot?: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [allowScripts, setAllowScripts] = useState(false);
  const checkboxId = useId();
  const workspaceCheckboxId = useId();
  const [allowWorkspaceResources, setAllowWorkspaceResources] = useState(false);
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {t('sessions.fileViewer.htmlPreview.consentTitle', 'Preview {{fileName}}?', {
              fileName,
            })}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {t(
              'sessions.fileViewer.htmlPreview.consentDescription',
              'The page opens from the file on disk and may load files from its own folder, such as stylesheets and images. It runs isolated from Lody.'
            )}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <label htmlFor={checkboxId} {...stylex.props(styles.option)}>
          <Checkbox
            id={checkboxId}
            checked={allowScripts}
            onCheckedChange={(next) => setAllowScripts(next === true)}
          />
          <span {...stylex.props(styles.optionText)}>
            <span>{t('sessions.fileViewer.htmlPreview.allowScripts', 'Allow JavaScript')}</span>
            <span {...stylex.props(styles.optionHint)}>
              {t(
                'sessions.fileViewer.htmlPreview.allowScriptsHint',
                'Only allow this for pages you trust. Scripts can make network requests.'
              )}
            </span>
          </span>
        </label>
        {workspaceRoot && (
          <label htmlFor={workspaceCheckboxId} {...stylex.props(styles.option)}>
            <Checkbox
              id={workspaceCheckboxId}
              checked={allowWorkspaceResources}
              onCheckedChange={(next) => setAllowWorkspaceResources(next === true)}
            />
            <span>
              {t(
                'sessions.fileViewer.htmlPreview.allowWorkspaceResources',
                'Allow this page to read files in {{folder}}',
                { folder: workspaceRoot }
              )}
            </span>
          </label>
        )}
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
          {/* Not `AlertDialog.Action`: that is a `Close`, whose close request would
              reach `onOpenChange` as a cancellation. Confirming moves the caller's
              state on, which closes this controlled dialog. */}
          <Button
            onClick={() =>
              onConfirm(
                allowScripts,
                allowWorkspaceResources ? (workspaceRoot ?? undefined) : undefined
              )
            }
          >
            {t('sessions.fileViewer.preview.show', 'Preview')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

export type LocalHtmlPreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'confirming' }
  | { readonly status: 'opening' }
  | { readonly status: 'ready'; readonly url: string; readonly allowScripts: boolean }
  | { readonly status: 'error'; readonly message: string };

/**
 * Drives the desktop direct preview for one file: ask (with the JavaScript
 * choice) each time the rendered view is entered, then obtain a fresh preview
 * origin from Electron main. `hostPath` null disables it; the caller keeps the
 * inline `srcdoc` preview. A null IPC answer (file not on this machine) also
 * falls back to that path through `onUnavailable`.
 */
export function useLocalHtmlPreview({
  active,
  machineId,
  hostPath,
  onCancel,
  onUnavailable,
}: {
  readonly active: boolean;
  readonly machineId: string;
  readonly hostPath: string | null;
  readonly onCancel: () => void;
  readonly onUnavailable: () => void;
}) {
  const [state, setState] = useState<LocalHtmlPreviewState>({ status: 'idle' });
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const enabled = active && hostPath !== null;

  useEffect(() => {
    requestRef.current += 1;
    setState(enabled ? { status: 'confirming' } : { status: 'idle' });
  }, [enabled, hostPath]);

  const confirm = useCallback(
    (allowScripts: boolean, workspaceRoot?: string) => {
      if (hostPath === null) return;
      const request = ++requestRef.current;
      setState({ status: 'opening' });
      void (async () => {
        try {
          const services = getIpcServices();
          const result = services
            ? await services.machineRpc.openHtmlPreview({
                machineId,
                path: hostPath,
                allowScripts,
                ...(workspaceRoot ? { workspaceRoot, allowWorkspaceResources: true } : {}),
              })
            : null;
          if (request !== requestRef.current) return;
          if (result === null) {
            setState({ status: 'idle' });
            onUnavailable();
          } else if (result.status === 'ok') {
            setState({ status: 'ready', url: result.url, allowScripts });
          } else {
            setState({ status: 'error', message: result.message });
          }
        } catch (error) {
          if (request !== requestRef.current) return;
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    [hostPath, machineId, onUnavailable]
  );

  const cancel = useCallback(() => {
    requestRef.current += 1;
    setState({ status: 'idle' });
    onCancel();
  }, [onCancel]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const retry = useCallback(() => {
    requestRef.current += 1;
    setState({ status: 'confirming' });
  }, []);

  return { enabled, state, reloadKey, confirm, cancel, reload, retry };
}
