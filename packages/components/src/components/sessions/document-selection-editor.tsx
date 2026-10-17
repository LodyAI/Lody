import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, FileText, Pencil, Square, Undo2, X } from 'lucide-react';
import { DocumentSelectionTooltip as Tooltip } from './document-selection-tooltip';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import {
  drawImageMarkup,
  encodeSelectionImage,
  type DocumentSelection,
  type ImageMarkup,
  type SelectionPoint,
} from '@/lib/document-selection';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', minHeight: 0, color: colors.label },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    paddingBottom: space[2],
    minWidth: 0,
  },
  source: {
    display: 'flex',
    flex: '1 1 auto',
    gap: space[1],
    minWidth: 0,
    alignItems: 'center',
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  location: { flexShrink: 0 },
  preview: { paddingInline: space[3], maxHeight: 'min(32dvh, 280px)', overflow: 'auto' },
  canvas: {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    touchAction: 'none',
    cursor: 'crosshair',
    marginInline: 'auto',
    borderRadius: radius.mini,
  },
  canvasPreview: { cursor: 'default' },
  excerpt: {
    margin: 0,
    paddingLeft: space[2],
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.accent,
    fontFamily: 'inherit',
    fontSize: '0.75rem',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.secondaryLabel,
    maxHeight: '4.5em',
    overflow: 'auto',
  },
  comment: { padding: space[3] },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[3],
    paddingBottom: space[3],
  },
  tools: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[3],
    paddingTop: space[2],
  },
  drawHint: {
    paddingInline: space[3],
    paddingTop: space[1],
    color: colors.secondaryLabel,
    fontSize: '0.75rem',
  },
  spacer: { flex: '1 1 auto' },
  error: {
    paddingInline: space[3],
    paddingBottom: space[3],
    fontSize: '0.75rem',
    color: colors.destructive,
  },
});

export function DocumentSelectionEditor({
  selection,
  image,
  onCancel,
  onAdd,
  autoFocus = true,
  allowMarkup = false,
  onDirtyChange,
}: {
  readonly selection: DocumentSelection;
  readonly image?: HTMLCanvasElement;
  readonly autoFocus?: boolean;
  readonly allowMarkup?: boolean;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onCancel: () => void;
  readonly onAdd: (selection: DocumentSelection) => boolean;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState('');
  const [tool, setTool] = useState<ImageMarkup['tool']>('pen');
  const [marks, setMarks] = useState<ImageMarkup[]>([]);
  const drawing = useRef<ImageMarkup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (autoFocus) commentRef.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
    };
  }, [autoFocus]);
  const dirtyRef = useRef(onDirtyChange);
  dirtyRef.current = onDirtyChange;
  useEffect(() => {
    dirtyRef.current?.(comment.length > 0 || (allowMarkup && marks.length > 0));
  }, [comment, marks, allowMarkup]);
  const paint = useCallback(
    (pending?: ImageMarkup) => {
      const canvas = canvasRef.current,
        context = canvas?.getContext('2d');
      if (!canvas || !context || !image) return;
      canvas.width = image.width;
      canvas.height = image.height;
      context.drawImage(image, 0, 0);
      const logicalWidth = Number.parseFloat(image.style.width) || image.width;
      if (allowMarkup)
        drawImageMarkup(context, pending ? [...marks, pending] : marks, image.width / logicalWidth);
    },
    [image, marks, allowMarkup]
  );
  useEffect(() => {
    paint();
  }, [paint]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>): SelectionPoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(image!.width, ((event.clientX - box.left) * image!.width) / box.width)
      ),
      y: Math.max(
        0,
        Math.min(image!.height, ((event.clientY - box.top) * image!.height) / box.height)
      ),
    };
  };
  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const file = canvasRef.current
        ? await encodeSelectionImage(canvasRef.current, selection.path)
        : undefined;
      if (!alive.current) return;
      if (!onAdd({ ...selection, comment, ...(file ? { image: file } : {}) }))
        throw new Error('Composer unavailable');
    } catch {
      if (alive.current)
        setError(
          t(
            'sessions.fileViewer.selection.addFailed',
            'Could not add the selection. Check the open chat and attachment limits, then retry.'
          )
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === 'Enter' &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          void add();
        }
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
        }
      }}
      {...stylex.props(styles.root)}
      aria-label={t('sessions.fileViewer.selection.editor', 'Selection annotation')}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.source)} title={selection.path}>
          <FileText size={14} aria-hidden />
          <span {...stylex.props(styles.name)}>{selection.path.split(/[\\/]/).pop()}</span>
          <span {...stylex.props(styles.location)}>· {selection.location}</span>
        </div>
        <Tooltip content={t('common.cancel', 'Cancel')}>
          <Button
            size="mini"
            variant="ghost"
            icon
            aria-label={t('common.cancel', 'Cancel')}
            onClick={onCancel}
            disabled={busy}
          >
            <X size={14} aria-hidden />
          </Button>
        </Tooltip>
      </div>
      <div {...stylex.props(styles.preview)}>
        {image ? (
          <canvas
            ref={canvasRef}
            style={{ width: image.style.width || image.width }}
            {...stylex.props(styles.canvas, !allowMarkup && styles.canvasPreview)}
            role={allowMarkup ? undefined : 'img'}
            aria-label={
              allowMarkup
                ? t('sessions.fileViewer.selection.markupCanvas', 'Draw on selected screenshot')
                : t('sessions.fileViewer.selection.screenshotPreview', 'Selected screenshot')
            }
            onPointerDown={(event) => {
              if (!allowMarkup || busy || event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drawing.current = { tool, points: [point(event)] };
            }}
            onPointerMove={(event) => {
              const mark = drawing.current;
              if (!mark) return;
              drawing.current = {
                ...mark,
                points:
                  mark.tool === 'pen'
                    ? [...mark.points, point(event)]
                    : [mark.points[0], point(event)],
              };
              paint(drawing.current);
            }}
            onPointerUp={(event) => {
              const mark = drawing.current;
              if (!mark) return;
              drawing.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              setMarks((items) => [...items, mark]);
            }}
            onPointerCancel={() => {
              drawing.current = null;
              paint();
            }}
          />
        ) : null}
        {(selection.text?.length ?? 0) > 0 ? (
          <pre {...stylex.props(styles.excerpt)}>{selection.text}</pre>
        ) : null}
      </div>
      {image && allowMarkup ? (
        <div
          {...stylex.props(styles.tools)}
          role="group"
          aria-label={t('sessions.fileViewer.selection.tools', 'Markup tools')}
        >
          {(['pen', 'rectangle', 'arrow'] as const).map((value) => {
            const label =
              value === 'pen'
                ? t('sessions.fileViewer.selection.pen', 'Pen')
                : value === 'rectangle'
                  ? t('sessions.fileViewer.selection.rectangle', 'Rectangle')
                  : t('sessions.fileViewer.selection.arrow', 'Arrow');
            const Icon = value === 'pen' ? Pencil : value === 'rectangle' ? Square : ArrowUpRight;
            return (
              <Tooltip key={value} content={label}>
                <Button
                  size="mini"
                  variant={tool === value ? 'secondary' : 'ghost'}
                  aria-label={label}
                  aria-pressed={tool === value}
                  disabled={busy}
                  onClick={() => setTool(value)}
                >
                  <Icon size={15} aria-hidden />
                  {label}
                </Button>
              </Tooltip>
            );
          })}
          <Tooltip content={t('common.undo', 'Undo')}>
            <Button
              size="mini"
              variant="ghost"
              icon
              aria-label={t('common.undo', 'Undo')}
              disabled={busy || !marks.length}
              onClick={() => setMarks((items) => items.slice(0, -1))}
            >
              <Undo2 size={15} aria-hidden />
            </Button>
          </Tooltip>
        </div>
      ) : null}
      {image && allowMarkup ? (
        <div {...stylex.props(styles.drawHint)}>
          {t('sessions.fileViewer.selection.drawHint', 'Drag on the screenshot to draw.')}
        </div>
      ) : null}
      <div {...stylex.props(styles.comment)}>
        <Textarea
          appearance="bare"
          resize="none"
          rows={2}
          ref={commentRef}
          aria-label={t('sessions.fileViewer.selection.comment', 'Selection comment')}
          placeholder={t(
            'sessions.fileViewer.selection.commentPlaceholder',
            'Add an optional comment…'
          )}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={10_000}
          disabled={busy}
        />
      </div>
      <div {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.spacer)} />
        <Button size="mini" onClick={() => void add()} disabled={busy}>
          {t('sessions.fileViewer.selection.add', 'Add to chat')}
        </Button>
      </div>
      {error ? (
        <div role="alert" {...stylex.props(styles.error)}>
          {error}
        </div>
      ) : null}
    </section>
  );
}
