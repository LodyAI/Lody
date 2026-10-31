import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, FileText, Pencil, Square, Type, Undo2, X } from 'lucide-react';
import { DocumentSelectionTooltip as Tooltip } from './document-selection-tooltip';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
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
  markupPreview: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '1 1 auto',
    minHeight: 0,
    width: '100%',
    overflow: 'hidden',
    padding: '64px 32px 112px',
  },
  markupRoot: { position: 'relative', width: '100%', height: '100%', minHeight: 0 },
  canvasWrap: {
    position: 'relative',
    width: 'fit-content',
    maxWidth: '100%',
    marginInline: 'auto',
  },
  noteEditor: {
    position: 'absolute',
    zIndex: 1,
    width: 220,
    maxWidth: '80%',
    backgroundColor: colors.elevatedBackground,
    borderRadius: radius.medium,
    boxShadow: shadow.card,
  },
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
  markupCanvas: { maxHeight: 'calc(100dvh - 176px)', width: 'auto', objectFit: 'contain' },
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
    position: 'absolute',
    bottom: 'max(24px, env(safe-area-inset-bottom))',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'max-content',
    maxWidth: 'calc(100% - 32px)',
    padding: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    justifyContent: 'center',
  },
  markList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[1],
    justifyContent: 'center',
    position: 'absolute',
    bottom: 'max(72px, calc(env(safe-area-inset-bottom) + 48px))',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: '90%',
    maxHeight: 80,
    overflow: 'auto',
  },
  markupFooter: {
    position: 'absolute',
    right: 'max(24px, env(safe-area-inset-right))',
    bottom: {
      default: 'max(24px, env(safe-area-inset-bottom))',
      '@media (max-width: 850px)': 'max(76px, calc(env(safe-area-inset-bottom) + 52px))',
    },
    paddingInline: space[1],
    paddingTop: space[1],
    paddingBottom: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
  },
  swatch: { width: 14, height: 14, borderRadius: '50%', display: 'block' },
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
  const [tool, setTool] = useState<ImageMarkup['tool']>('rectangle');
  const [marks, setMarks] = useState<ImageMarkup[]>([]);
  const [color, setColor] = useState('#e77958');
  const [editingMark, setEditingMark] = useState<number | null>(null);
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
    (pending?: ImageMarkup, includeEditing = false) => {
      const canvas = canvasRef.current,
        context = canvas?.getContext('2d');
      if (!canvas || !context || !image) return;
      canvas.width = image.width;
      canvas.height = image.height;
      context.drawImage(image, 0, 0);
      const logicalWidth = allowMarkup
        ? canvas.getBoundingClientRect().width || image.width
        : Number.parseFloat(image.style.width) || image.width;
      if (allowMarkup) {
        const visibleMarks = marks.map((mark, index) =>
          !includeEditing && index === editingMark ? { ...mark, note: undefined } : mark
        );
        drawImageMarkup(
          context,
          pending ? [...visibleMarks, pending] : visibleMarks,
          image.width / logicalWidth
        );
      }
    },
    [image, marks, allowMarkup, editingMark]
  );
  useEffect(() => {
    paint();
  }, [paint]);
  useEffect(() => {
    if (!allowMarkup || !canvasRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [allowMarkup, paint]);
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
      if (allowMarkup) paint(undefined, true);
      const file = canvasRef.current
        ? await encodeSelectionImage(canvasRef.current, selection.path)
        : undefined;
      if (!alive.current) return;
      const annotationNotes = marks.flatMap((mark) =>
        mark.note?.trim() ? [mark.note.trim()] : []
      );
      if (
        !onAdd({
          ...selection,
          comment: allowMarkup ? annotationNotes.join('\n') : comment,
          ...(file ? { image: file } : {}),
        })
      )
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
          if (editingMark !== null) setEditingMark(null);
          else onCancel();
        }
      }}
      {...stylex.props(styles.root, allowMarkup && styles.markupRoot)}
      aria-label={t('sessions.fileViewer.selection.editor', 'Selection annotation')}
    >
      {!allowMarkup && (
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
      )}
      <div {...stylex.props(allowMarkup ? styles.markupPreview : styles.preview)}>
        {image ? (
          <div {...stylex.props(styles.canvasWrap)}>
            <canvas
              ref={canvasRef}
              style={allowMarkup ? undefined : { width: image.style.width || image.width }}
              {...stylex.props(
                styles.canvas,
                allowMarkup ? styles.markupCanvas : styles.canvasPreview
              )}
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
                setEditingMark(null);
                drawing.current = { tool, color, points: [point(event)] };
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
                if (mark.points.length > 1 || mark.tool === 'text') {
                  setMarks((items) => [...items, mark]);
                  if (mark.tool === 'rectangle' || mark.tool === 'text')
                    setEditingMark(marks.length);
                }
              }}
              onPointerCancel={() => {
                drawing.current = null;
                paint();
              }}
            />
            {allowMarkup &&
              editingMark !== null &&
              marks[editingMark]?.points[0] &&
              (() => {
                const mark = marks[editingMark];
                const start = mark.points[0];
                const end = mark.points.at(-1) ?? start;
                return (
                  <div
                    {...stylex.props(styles.noteEditor)}
                    style={{
                      left: `${Math.min(70, (Math.min(start.x, end.x) / image.width) * 100)}%`,
                      top: `${Math.min(85, (Math.max(start.y, end.y) / image.height) * 100)}%`,
                    }}
                  >
                    <Textarea
                      autoFocus
                      rows={2}
                      resize="none"
                      value={mark.note ?? ''}
                      maxLength={140}
                      aria-label={t('sessions.fileViewer.selection.markNote', 'Annotation note')}
                      placeholder={t(
                        'sessions.fileViewer.selection.markNotePlaceholder',
                        'Add a note…'
                      )}
                      onChange={(event) =>
                        setMarks((items) =>
                          items.map((item, index) =>
                            index === editingMark ? { ...item, note: event.target.value } : item
                          )
                        )
                      }
                      onBlur={() => setEditingMark(null)}
                    />
                  </div>
                );
              })()}
          </div>
        ) : null}
        {(selection.text?.length ?? 0) > 0 ? (
          <pre {...stylex.props(styles.excerpt)}>{selection.text}</pre>
        ) : null}
      </div>
      {image && allowMarkup ? (
        <div {...stylex.props(styles.markList)}>
          {marks.map((mark, index) =>
            mark.tool === 'rectangle' || mark.tool === 'text' ? (
              <Button key={index} size="mini" variant="ghost" onClick={() => setEditingMark(index)}>
                {t('sessions.fileViewer.selection.editMark', 'Annotation {{number}}', {
                  number: index + 1,
                })}
              </Button>
            ) : null
          )}
        </div>
      ) : null}
      {image && allowMarkup ? (
        <div
          {...stylex.props(styles.tools)}
          role="group"
          aria-label={t('sessions.fileViewer.selection.tools', 'Markup tools')}
        >
          {(['text', 'pen', 'rectangle', 'arrow'] as const).map((value) => {
            const label =
              value === 'text'
                ? t('sessions.fileViewer.selection.textTool', 'Text')
                : value === 'pen'
                  ? t('sessions.fileViewer.selection.pen', 'Pen')
                  : value === 'rectangle'
                    ? t('sessions.fileViewer.selection.rectangle', 'Rectangle')
                    : t('sessions.fileViewer.selection.arrow', 'Arrow');
            const Icon =
              value === 'text'
                ? Type
                : value === 'pen'
                  ? Pencil
                  : value === 'rectangle'
                    ? Square
                    : ArrowUpRight;
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
                </Button>
              </Tooltip>
            );
          })}
          {[
            [t('sessions.fileViewer.selection.colorCoral', 'Coral'), '#e77958'],
            [t('sessions.fileViewer.selection.colorRed', 'Red'), '#e25b5b'],
            [t('sessions.fileViewer.selection.colorYellow', 'Yellow'), '#e9bf62'],
            [t('sessions.fileViewer.selection.colorWhite', 'White'), '#ffffff'],
            [t('sessions.fileViewer.selection.colorBlue', 'Blue'), '#6a9eeb'],
            [t('sessions.fileViewer.selection.colorGreen', 'Green'), '#5ecb91'],
          ].map(([name, value]) => (
            <Button
              key={value}
              size="mini"
              variant={color === value ? 'secondary' : 'ghost'}
              icon
              aria-label={name}
              aria-pressed={color === value}
              disabled={busy}
              onClick={() => setColor(value)}
            >
              <span {...stylex.props(styles.swatch)} style={{ backgroundColor: value }} />
            </Button>
          ))}
          <Tooltip content={t('common.undo', 'Undo')}>
            <Button
              size="mini"
              variant="ghost"
              icon
              aria-label={t('common.undo', 'Undo')}
              disabled={busy || !marks.length}
              onClick={() => {
                setEditingMark(null);
                setMarks((items) => items.slice(0, -1));
              }}
            >
              <Undo2 size={15} aria-hidden />
            </Button>
          </Tooltip>
        </div>
      ) : null}
      {!allowMarkup && (
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
      )}
      <div {...stylex.props(styles.footer, allowMarkup && styles.markupFooter)}>
        <span {...stylex.props(styles.spacer)} />
        {allowMarkup && (
          <Button size="mini" variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
        )}
        <Button size="mini" onClick={() => void add()} disabled={busy}>
          {allowMarkup
            ? t('common.done', 'Done')
            : t('sessions.fileViewer.selection.add', 'Add to chat')}
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
