import { createContext, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { prRemoteImagesEnabledAtom } from '@/atoms/settings';

/** Only GitHub review Markdown opts into the isolated image loader. */
export const PrRemoteImageContext = createContext(false);

const styles = stylex.create({
  slot: { display: 'flex', alignItems: 'center', gap: space[2], marginBlock: space[2] },
  label: { color: colors.secondaryLabel, overflowWrap: 'anywhere' },
  frame: {
    display: 'block',
    border: 0,
    maxWidth: '100%',
    maxHeight: '32rem',
    marginBlock: space[2],
  },
});

export function PrRemoteImage({ src, alt }: { src: string; alt?: string }) {
  const { t } = useTranslation();
  const automatic = useAtomValue(prRemoteImagesEnabledAtom) === true;
  const [requested, setRequested] = useState(false);
  const [result, setResult] = useState<{ width: number; height: number } | 'failed' | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const enabled = automatic || requested;

  useLayoutEffect(() => {
    if (!enabled) return undefined;
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { kind?: unknown; width?: unknown; height?: unknown } | null;
      if (data?.kind === 'lody-pr-image-error') setResult('failed');
      if (
        data?.kind === 'lody-pr-image-loaded' &&
        typeof data.width === 'number' &&
        Number.isFinite(data.width) &&
        data.width > 0 &&
        typeof data.height === 'number' &&
        Number.isFinite(data.height) &&
        data.height > 0
      )
        setResult({ width: data.width, height: data.height });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [enabled, src]);

  if (!enabled || result === 'failed') {
    return (
      <span {...stylex.props(styles.slot)}>
        <span {...stylex.props(styles.label)}>{alt || t('sessions.prImage.image', 'Image')}</span>
        {result === 'failed' && (
          <span {...stylex.props(styles.label)}>
            {t('sessions.prImage.failed', 'Unable to load image')}
          </span>
        )}
        <Button
          size="small"
          variant="secondary"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRequested(true);
            setResult(null);
          }}
        >
          {result === 'failed'
            ? t('sessions.prImage.retry', 'Retry')
            : t('sessions.prImage.load', 'Load image')}
        </Button>
      </span>
    );
  }

  const frameUrl = new URL('pr-image.html', window.location.href);
  frameUrl.hash = encodeURIComponent(src);
  const width = result?.width ?? 320;
  const height = result?.height ?? 48;
  return (
    <iframe
      ref={frame}
      title={alt || t('sessions.prImage.image', 'Image')}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={frameUrl.href}
      style={{ width: `min(${width}px, 100%)`, aspectRatio: `${width} / ${height}` }}
      {...stylex.props(styles.frame)}
    />
  );
}
