import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { resolveMarkdownImagePath } from '@/lib/session-file-open-target';

const styles = stylex.create({
  container: { display: 'block', marginBlock: space[2], maxWidth: '100%' },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    padding: space[4],
    minHeight: 160,
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  skeleton: {
    display: 'block',
    width: 64,
    height: 40,
    borderRadius: radius.small,
    backgroundColor: colors.separator,
  },
  image: {
    display: 'block',
    maxHeight: '32rem',
    maxWidth: '100%',
    objectFit: 'contain',
    borderRadius: radius.small,
  },
  pendingImage: { display: 'none' },
});

type Resources = {
  provider: Pick<FileWorkspaceProvider, 'openFile'>;
  documentPath: string;
  automatic: boolean;
  active: boolean;
};

export const MarkdownFileResourcesContext = createContext<Resources | null>(null);

/** Only live file surfaces grant this capability. Chat and public shares do not. */
export function MarkdownFileResources({
  children,
  ...resources
}: Resources & { children: ReactNode }) {
  const { provider, documentPath, automatic, active } = resources;
  const value = useMemo(
    () => ({ provider, documentPath, automatic, active }),
    [provider, documentPath, automatic, active]
  );
  return (
    <MarkdownFileResourcesContext.Provider value={value}>
      {children}
    </MarkdownFileResourcesContext.Provider>
  );
}

export function MarkdownFileImage({ src, alt }: { src: string; alt?: string }) {
  const resources = useContext(MarkdownFileResourcesContext)!;
  const path = resolveMarkdownImagePath(resources.documentPath, src);
  if (path === null) return null;
  return (
    <FileImage
      key={`${resources.documentPath}\0${src}`}
      resources={resources}
      path={path}
      alt={alt}
    />
  );
}

type ImageState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; url: string; provider: Resources['provider']; path: string }
  | { status: 'error'; message?: string };

function FileImage({ resources, path, alt }: { resources: Resources; path: string; alt?: string }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const { provider, automatic, active } = resources;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ImageState>({ status: 'idle' });
  const [decoded, setDecoded] = useState(false);
  const [previousProvider, setPreviousProvider] = useState(provider);
  if (previousProvider !== provider) {
    setPreviousProvider(provider);
    setAttempt(0);
    setState({ status: 'idle' });
    setDecoded(false);
  }

  useEffect(() => {
    if (!active || (!automatic && attempt === 0)) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    setDecoded(false);
    setState({ status: 'loading' });
    void (async () => {
      try {
        const result = await provider.openFile(path);
        if (cancelled) return;
        if (result.status === 'unavailable') throw new Error(result.message ?? result.reason);
        const { snapshot } = result;
        const mime = getImageMimeTypeForPath(result.entry.path);
        if (!mime)
          throw new Error(
            tRef.current('sessions.markdownImage.unsupported', 'Unsupported image format')
          );
        let url: string;
        if (snapshot.kind === 'binary' && snapshot.url) {
          // Electron owns this capability URL and its lifetime; never fetch it into base64.
          url = snapshot.url;
        } else {
          const content =
            snapshot.kind === 'binary' && snapshot.bytes
              ? Uint8Array.from(snapshot.bytes)
              : snapshot.kind === 'text' && mime === 'image/svg+xml'
                ? snapshot.text
                : null;
          if (content === null)
            throw new Error(
              tRef.current('sessions.markdownImage.unsupported', 'Unsupported image format')
            );
          objectUrl = URL.createObjectURL(new Blob([content], { type: mime }));
          url = objectUrl;
        }
        setState({ status: 'ready', url, provider, path });
      } catch (error) {
        if (!cancelled)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : undefined,
          });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [provider, path, automatic, active, attempt]);

  const ready = state.status === 'ready' && state.provider === provider && state.path === path;
  const loading = state.status === 'loading' || (ready && !decoded);
  return (
    <span {...stylex.props(styles.container)}>
      {ready && state.status === 'ready' ? (
        <img
          src={state.url}
          alt={alt ?? ''}
          {...stylex.props(styles.image, !decoded && styles.pendingImage)}
          onLoad={() => setDecoded(true)}
          onError={() => setState({ status: 'error' })}
        />
      ) : null}
      {!ready || !decoded ? (
        <span {...stylex.props(styles.placeholder)} aria-busy={loading}>
          <span {...stylex.props(styles.skeleton)} aria-hidden="true" />
          <span>{alt || t('sessions.markdownImage.image', 'Image')}</span>
          {state.status === 'error' ? (
            <span role="status" title={state.message}>
              {t('sessions.markdownImage.failed', 'Image could not be loaded')}
              {state.message ? `: ${state.message}` : ''}
            </span>
          ) : null}
          <Button
            size="small"
            variant="secondary"
            disabled={loading || !active}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {loading
              ? t('sessions.markdownImage.loading', 'Loading image…')
              : state.status === 'error'
                ? t('sessions.markdownImage.retry', 'Retry')
                : t('sessions.markdownImage.load', 'Click to load image')}
          </Button>
        </span>
      ) : null}
    </span>
  );
}
