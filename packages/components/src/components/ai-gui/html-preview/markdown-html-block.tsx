import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { control, radius, space } from '@lody/ui/tokens/scales.stylex';
// A fetched document owns its CSP; inlining it as a data URL would inherit the host's.
import frameUrl from './markdown-html-frame.htm?url&no-inline';
import { conversation } from '../conversation.tokens.stylex';
import { CodeBlockBody, CodeBlockContainer } from '../markdown-code-block';

const SAMPLED = [
  'text',
  'accent',
  'raised',
  'shadow',
  'well',
  'inset',
  'radius',
  'height',
] as const;

// The frame body keeps the UA's 8px margin, so the frame bleeds by it to sit on the prose rail.
const BODY_MARGIN = space[2];

const styles = stylex.create({
  host: {
    width: '100%',
    marginBlock: conversation.surfaceGap,
    '--preview-text': conversation.reading,
    '--preview-accent': colors.accent,
    '--preview-raised': colors.raisedBackground,
    '--preview-shadow': shadow.raised,
    '--preview-well': colors.wellBackground,
    '--preview-inset': shadow.inset,
    '--preview-radius': radius.small,
    '--preview-height': control.small,
  },
  viewport: {
    marginBlock: `calc(${BODY_MARGIN} * -1)`,
    marginInline: `calc(${conversation.railInset} - ${BODY_MARGIN})`,
  },
  frame: { width: '100%', border: 0, display: 'block' },
});

const cache = new Map<string, { height: number; seen: boolean }>();

function documentSource(code: string, id: string, dark: boolean, theme: string) {
  const script = `<script>(() => {
    const id = ${JSON.stringify(id).replace(/</g, '\u003c')};
    const send = (type, value) => parent.postMessage({ id, type, value }, '*');
    let last = 0;
    let delta = 0;
    let repeats = 0;
    let blocked = false;
    let queued = false;

    const measure = () => {
      queued = false;
      if (blocked) return;
      const height = Math.ceil(Math.max(
        document.body?.scrollHeight || 0,
        document.body?.getBoundingClientRect().height || 0
      ) + 16);
      if (height === last) return;
      const growth = height - last;
      if (growth > 0 && growth === delta) repeats++;
      else repeats = 0;
      delta = growth;
      if (repeats >= 2) {
        blocked = true;
        return;
      }
      last = height;
      send('height', height);
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    const reset = () => {
      blocked = false;
      repeats = 0;
      schedule();
    };

    addEventListener('error', event => {
      send('error', String(event.message || 'Resource failed to load').slice(0, 500));
    }, true);
    addEventListener('unhandledrejection', event => {
      send('error', String(event.reason).slice(0, 500));
    });
    let width = innerWidth;
    addEventListener('resize', () => {
      if (innerWidth === width) return;
      width = innerWidth;
      reset();
    });
    addEventListener('click', event => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const href = anchor?.getAttribute('href');
      if (!href?.startsWith('#')) return;
      event.preventDefault();
      let fragment;
      try { fragment = decodeURIComponent(href.slice(1)); } catch { return; }
      if (!fragment) { scrollTo(0, 0); return; }
      const target = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
      target?.scrollIntoView();
    });
    // Resource load does not bubble; capture also catches images added after startup.
    addEventListener('load', schedule, true);
    addEventListener('load', () => {
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(schedule);
        observer.observe(document.body);
        observer.observe(document.documentElement);
      }
      new MutationObserver(reset).observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true
      });
      schedule();
    });
  })();<\/script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@layer lody-preview-fallback {
  :where(:root) { ${theme} color-scheme: ${dark ? 'dark' : 'light'}; }
  :where(body) { color: var(--preview-text); font-family: var(--preview-font); font-size: var(--preview-font-size); line-height: var(--preview-line-height); }
  :where(button, input, textarea, select) { font: inherit; color: inherit; vertical-align: middle; accent-color: var(--preview-accent); }
  :where(button, input:is([type="button"], [type="submit"], [type="reset"])) {
    min-height: var(--preview-height); padding: 0 10px; border: 0; border-radius: var(--preview-radius);
    background: var(--preview-raised); box-shadow: var(--preview-shadow); cursor: pointer;
  }
  :where(input:not([type]), input:is([type="text"], [type="email"], [type="password"], [type="search"], [type="url"], [type="tel"], [type="number"]), textarea, select) {
    box-sizing: border-box; min-height: var(--preview-height); padding: 0 8px; border: 0;
    border-radius: var(--preview-radius); background: var(--preview-well); box-shadow: var(--preview-inset);
  }
  :where(button, input, textarea, select):where(:focus-visible) { outline: 2px solid var(--preview-accent); outline-offset: 0; }
  :where(button, input, textarea, select):where(:disabled) { opacity: 0.45; cursor: default; }
}
</style>${script}</head><body>${code}</body></html>`;
}

export const MarkdownHtmlBlock = memo(function MarkdownHtmlBlock({
  code,
}: {
  code: string;
  meta: string | undefined;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const initialized = useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState('');
  const [active, setActive] = useState(false);
  const [height, setHeight] = useState(120);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<
    null | { kind: 'load' } | { kind: 'runtime'; message: string }
  >(null);
  const [dark, setDark] = useState(false);
  const instance = useMemo(() => crypto.randomUUID(), [code, dark, theme]);
  const srcDoc = useMemo(
    () => documentSource(code, instance, dark, theme),
    [code, instance, dark, theme]
  );
  useEffect(() => {
    setMounted(true);
    const update = () => {
      setDark(document.documentElement.classList.contains('dark'));
      const css = getComputedStyle(host.current ?? document.documentElement);
      setTheme(
        SAMPLED.map(
          (name) => `--preview-${name}:${css.getPropertyValue(`--preview-${name}`)};`
        ).join('') +
          `--preview-font:${css.fontFamily};--preview-font-size:${css.fontSize};` +
          `--preview-line-height:${css.lineHeight};`
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (cache.get(code)?.seen) {
      setActive(true);
      return;
    }
    if (!host.current || typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return;
    }
    let root = host.current.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY))
      root = root.parentElement;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { root, rootMargin: '800px' }
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!active) return;
    setReady(false);
    setHeight(cache.get(code)?.height ?? 120);
    setError(null);
    cache.set(code, { height: cache.get(code)?.height ?? 120, seen: true });
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
    let initialized = false;
    const timer = window.setTimeout(() => {
      setReady(true);
      if (!initialized) setError({ kind: 'load' });
    }, 1000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.id !== instance) return;
      const { type, value } = event.data;
      if (type === 'initialized') {
        initialized = true;
        setError((error) => (error?.kind === 'load' ? null : error));
      }
      if (type === 'height' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        // Measured content sets the height; the 120px reservation only covers loading.
        const height = Math.min(10000, value);
        setHeight(height);
        cache.set(code, { height, seen: true });
        while (cache.size > 500) cache.delete(cache.keys().next().value!);
        setReady(true);
      }
      if (type === 'error' && typeof value === 'string')
        setError(value ? { kind: 'runtime', message: value.slice(0, 500) } : null);
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [active, instance, code]);
  const label = t('sessions.htmlPreview.title', 'HTML preview');
  return (
    <div ref={host} {...stylex.props(styles.host)}>
      {error?.kind === 'load' && (
        // The document never started, so the reply shows what the agent wrote instead.
        <CodeBlockContainer language="html" isIncomplete={false} style={{ marginBlock: 0 }}>
          <CodeBlockBody>{code}</CodeBlockBody>
        </CodeBlockContainer>
      )}
      <div
        hidden={error?.kind === 'load'}
        {...stylex.props(styles.viewport)}
        style={{ minHeight: ready ? undefined : 120 }}
      >
        {mounted && active && (
          <iframe
            key={instance}
            ref={frame}
            title={label}
            sandbox="allow-scripts"
            onLoad={() => {
              if (initialized.current !== instance) {
                initialized.current = instance;
                frame.current?.contentWindow?.postMessage({ id: instance, document: srcDoc }, '*');
              }
            }}
            src={frameUrl}
            referrerPolicy="no-referrer"
            {...stylex.props(styles.frame)}
            style={{
              // Matching the host's scheme keeps the frame transparent over the conversation.
              colorScheme: dark ? 'dark' : 'light',
              height,
              visibility: ready ? 'visible' : 'hidden',
            }}
          />
        )}
      </div>
      {error?.kind === 'runtime' && <div role="status">{error.message}</div>}
    </div>
  );
});
