import { memo, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { downloadBytesAsFile } from '@/lib/download-file';
import { Menu } from '@/ui/armed-overlays';
import type { ResolvedTheme } from '../../theme-provider';
import { CodeBlockCopyButton } from './markdown-code-block';
import { renderMarkdownMermaidSvg } from './markdown-mermaid';

const SVG_CACHE_MAX_ENTRIES = 32;
const PNG_EXPORT_SCALE = 5;

// Keyed by theme and source so a remount (the streaming renderer handing over
// to the static one, a virtualized row scrolling back in) paints the diagram
// in the same frame instead of flashing the empty frame while it re-renders.
const svgCache = new Map<string, string>();

const writeSvgCache = (key: string, svg: string) => {
  svgCache.set(key, svg);
  while (svgCache.size > SVG_CACHE_MAX_ENTRIES) {
    const oldestKey = svgCache.keys().next().value;
    if (oldestKey === undefined) break;
    svgCache.delete(oldestKey);
  }
};

function useMermaidSvg(code: string, theme: ResolvedTheme): string | null {
  const key = `${theme}\0${code}`;
  const [rendered, setRendered] = useState<string | null>(null);

  useEffect(() => {
    if (svgCache.has(key)) return undefined;
    let cancelled = false;
    void renderMarkdownMermaidSvg(code, theme).then((svg) => {
      writeSvgCache(key, svg);
      if (!cancelled) setRendered(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, theme]);

  return svgCache.get(key) ?? rendered;
}

const encodeText = (text: string) => new TextEncoder().encode(text);

const svgToPngBytes = (svg: string): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width * PNG_EXPORT_SCALE;
      canvas.height = image.height * PNG_EXPORT_SCALE;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('PNG encoding failed'));
          return;
        }
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      }, 'image/png');
    };
    image.onerror = () => reject(new Error('SVG failed to load'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

function MermaidDownloadMenu({ code, svg }: { code: string; svg: string | null }) {
  const { t } = useTranslation();
  const label = t('sessions.diagram.download', 'Download diagram');

  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} title={label}>
        <Download size={14} />
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Item
          disabled={!svg}
          onClick={() => svg && downloadBytesAsFile('diagram.svg', encodeText(svg))}
        >
          {t('sessions.diagram.downloadSvg', 'SVG')}
        </Menu.Item>
        <Menu.Item
          disabled={!svg}
          onClick={() => {
            if (!svg) return;
            void svgToPngBytes(svg)
              .then((bytes) => downloadBytesAsFile('diagram.png', bytes))
              .catch((error: unknown) => console.warn('[Lody] Diagram PNG export failed.', error));
          }}
        >
          {t('sessions.diagram.downloadPng', 'PNG')}
        </Menu.Item>
        <Menu.Item onClick={() => downloadBytesAsFile('diagram.mmd', encodeText(code))}>
          {t('sessions.diagram.downloadSource', 'Mermaid source')}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

export const MarkdownMermaidBlock = memo(function MarkdownMermaidBlock({
  code,
  theme,
}: {
  code: string;
  theme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const svg = useMermaidSvg(code, theme);

  return (
    <div data-streamdown="mermaid-block">
      <div data-streamdown="mermaid-block-actions">
        <MermaidDownloadMenu code={code} svg={svg} />
        <CodeBlockCopyButton code={code} />
      </div>
      <div data-streamdown="mermaid">
        <div>
          {svg ? (
            <div
              data-streamdown="mermaid-svg"
              role="img"
              aria-label={t('sessions.diagramViewer.title', 'Diagram')}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});
