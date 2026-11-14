import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { control, radius, space } from '@lody/ui/tokens/scales.stylex';
// A fetched document owns its CSP; inlining it as a data URL would inherit the host's.
import frameUrl from './markdown-html-frame.htm?url&no-inline';
import { CodeBlockBody, CodeBlockCopyButton } from '../markdown-code-block';

const styles = stylex.create({
  host: {
    width: '100%',
    marginBlock: space[3],
    '--preview-raised': colors.raisedBackground,
    '--preview-well': colors.wellBackground,
    '--preview-accent': colors.accent,
    '--preview-hover': colors.hoverFill,
    '--preview-shadow': shadow.raised,
    '--preview-inset': shadow.inset,
    '--preview-radius': radius.medium,
    '--preview-height': control.medium,
    '--preview-space': space[2],
  },
  dialog: {
    position: 'static',
    display: 'block',
    width: '100%',
    maxWidth: 'none',
    margin: 0,
    padding: 0,
    border: 0,
    color: 'inherit',
    backgroundColor: 'var(--background)',
    ':modal': {
      position: 'fixed',
      width: '95vw',
      height: '95vh',
      maxHeight: '95vh',
      overflow: 'auto',
      margin: 'auto',
    },
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[1],
  },
  frame: { width: '100%', border: 0, display: 'block' },
  viewport: { overflow: 'auto' },
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
    addEventListener('message', event => {
      if (event.source === parent && event.data?.id === id && event.data.type === 'measure') reset();
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
  :where(body) { background: hsl(var(--background)); color: hsl(var(--foreground)); font-family: var(--preview-font); font-size: var(--preview-font-size); }
  :where(button, input, textarea, select) { font: inherit; color: inherit; accent-color: var(--preview-accent); }
  :where(button, input:is([type="button"], [type="submit"], [type="reset"])) {
    background: var(--preview-raised); border: 0; box-shadow: var(--preview-shadow);
    border-radius: var(--preview-radius); min-height: var(--preview-height); padding: var(--preview-space); cursor: pointer;
  }
  :where(button, input:is([type="button"], [type="submit"], [type="reset"])):where(:hover:not(:disabled)) { background: var(--preview-hover); }
  :where(input:not([type]), input:is([type="text"], [type="email"], [type="password"], [type="search"], [type="url"], [type="tel"], [type="number"]), textarea, select) {
    box-sizing: border-box; background: var(--preview-well); border: 0; box-shadow: var(--preview-inset);
    border-radius: var(--preview-radius); min-height: var(--preview-height); padding: var(--preview-space);
  }
  :where(input:is([type="checkbox"], [type="radio"])) { cursor: pointer; }
  :where(button, input, textarea, select):where(:focus-visible) { outline: 2px solid var(--preview-accent); outline-offset: 2px; }
  :where(button, input, textarea, select):where(:disabled) { opacity: 0.5; cursor: not-allowed; }
}
</style>${script}</head><body>${code}</body></html>`;
}

export const MarkdownHtmlBlock = memo(function MarkdownHtmlBlock({
  code,
  meta,
}: {
  code: string;
  meta: string | undefined;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const initialized = useRef<string | null>(null);
  const fullscreenRef = useRef(false);
  const sourceBeforeFullscreen = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState('');
  const [active, setActive] = useState(false);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(120);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<
    null | { kind: 'load' } | { kind: 'runtime'; message: string }
  >(null);
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(false);
  const instance = useMemo(() => crypto.randomUUID(), [code, dark, theme, revision]);
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
        ['raised', 'well', 'accent', 'hover', 'shadow', 'inset', 'radius', 'height', 'space']
          .map((name) => `--preview-${name}:${css.getPropertyValue(`--preview-${name}`)};`)
          .join('') +
          `--background:${css.getPropertyValue('--background')};--foreground:${css.getPropertyValue('--foreground')};--preview-font:${css.fontFamily};--preview-font-size:${css.fontSize};`
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
      if (
        type === 'height' &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        !fullscreenRef.current
      ) {
        const height = Math.max(120, Math.min(10000, value));
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
      <dialog
        ref={dialog}
        open
        {...stylex.props(styles.dialog)}
        aria-label={label}
        onCancel={() => {
          fullscreenRef.current = false;
          setFullscreen(false);
        }}
        onClose={() => {
          fullscreenRef.current = false;
          frame.current?.contentWindow?.postMessage({ id: instance, type: 'measure' }, '*');
          setFullscreen(false);
          setSource(sourceBeforeFullscreen.current);
          dialog.current?.setAttribute('open', '');
        }}
      >
        <div {...stylex.props(styles.toolbar)}>
          <span>
            {meta
              ?.match(/(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/)
              ?.slice(1)
              .find(Boolean) || label}
          </span>
          <Button aria-pressed={source} onClick={() => setSource(!source)}>
            {t('sessions.htmlPreview.source', 'Source')}
          </Button>
          <CodeBlockCopyButton code={code} />
          <Button onClick={() => setRevision(revision + 1)}>
            {t('sessions.htmlPreview.reload', 'Reload')}
          </Button>
          {height > 480 && (
            <Button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded
                ? t('sessions.htmlPreview.collapse', 'Collapse')
                : t('sessions.htmlPreview.expand', 'Expand')}
            </Button>
          )}
          <Button
            onClick={() => {
              if (fullscreen) dialog.current?.close();
              else {
                sourceBeforeFullscreen.current = source;
                setSource(false);
                dialog.current?.removeAttribute('open');
                dialog.current?.showModal();
                fullscreenRef.current = true;
                setFullscreen(true);
              }
            }}
          >
            {fullscreen
              ? t('common.close', 'Close')
              : t('sessions.htmlPreview.fullscreen', 'Fullscreen')}
          </Button>
        </div>
        {source && (
          <CodeBlockBody tabIndex={0} aria-label={t('sessions.htmlPreview.source', 'Source')}>
            {code}
          </CodeBlockBody>
        )}
        <div
          hidden={source}
          {...stylex.props(styles.viewport)}
          style={{
            minHeight: 120,
            maxHeight: fullscreen ? undefined : expanded ? 10000 : 480,
          }}
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
                  frame.current?.contentWindow?.postMessage(
                    { id: instance, document: srcDoc },
                    '*'
                  );
                }
              }}
              src={frameUrl}
              referrerPolicy="no-referrer"
              {...stylex.props(styles.frame)}
              style={{
                height: fullscreen ? '80vh' : height,
                visibility: ready ? 'visible' : 'hidden',
              }}
            />
          )}
        </div>
        {error && (
          <div role="status">
            {error.kind === 'load'
              ? t(
                  'sessions.htmlPreview.loadError',
                  'HTML preview failed to load. Try Reload or view Source.'
                )
              : error.message}
          </div>
        )}
      </dialog>
    </div>
  );
});
