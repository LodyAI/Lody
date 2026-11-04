import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { downloadBytesAsFile } from '@/lib/download-file';
import { Menu } from '@/ui/armed-overlays';
import { CodeBlockCopyButton } from './markdown-code-block';
import {
  renderMarkdownMermaidSvg,
  resolveMermaidColors,
  withMermaidColors,
} from './markdown-mermaid';

const SVG_CACHE_MAX_ENTRIES = 32;
const PNG_EXPORT_SCALE = 5;

// Keyed by source so a remount (the streaming renderer handing over to the
// static one, a virtualized row scrolling back in) paints the diagram in the
// same frame instead of flashing the empty frame while it re-renders. Colors
// come from the block's theme variables, so a theme switch reuses the entry.
const svgCache = new Map<string, string>();

const writeSvgCache = (key: string, svg: string) => {
  svgCache.set(key, svg);
  while (svgCache.size > SVG_CACHE_MAX_ENTRIES) {
    const oldestKey = svgCache.keys().next().value;
    if (oldestKey === undefined) break;
    svgCache.delete(oldestKey);
  }
};

function useMermaidSvg(code: string): string | null {
  const [rendered, setRendered] = useState<string | null>(null);

  useEffect(() => {
    if (svgCache.has(code)) return undefined;
    let cancelled = false;
    void renderMarkdownMermaidSvg(code).then((svg) => {
      writeSvgCache(code, svg);
      if (!cancelled) setRendered(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  return svgCache.get(code) ?? rendered;
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

function MermaidDownloadMenu({
  code,
  svg,
  hostRef,
}: {
  code: string;
  svg: string | null;
  hostRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const label = t('sessions.diagram.download', 'Download diagram');
  // A file leaves the themed block, so it carries the colors in effect now.
  const exportSvg = () =>
    svg && hostRef.current ? withMermaidColors(svg, resolveMermaidColors(hostRef.current)) : svg;

  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} title={label}>
        <Download size={14} />
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Item
          disabled={!svg}
          onClick={() => {
            const file = exportSvg();
            if (file) downloadBytesAsFile('diagram.svg', encodeText(file));
          }}
        >
          {t('sessions.diagram.downloadSvg', 'SVG')}
        </Menu.Item>
        <Menu.Item
          disabled={!svg}
          onClick={() => {
            const file = exportSvg();
            if (!file) return;
            void svgToPngBytes(file)
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

export const MarkdownMermaidBlock = memo(function MarkdownMermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const svg = useMermaidSvg(code);
  const svgHostRef = useRef<HTMLDivElement>(null);

  return (
    <div data-streamdown="mermaid-block">
      <div data-streamdown="mermaid-block-actions">
        <MermaidDownloadMenu code={code} svg={svg} hostRef={svgHostRef} />
        <CodeBlockCopyButton code={code} />
      </div>
      <div data-streamdown="mermaid">
        <div>
          {svg ? (
            <div
              ref={svgHostRef}
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
