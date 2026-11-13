import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import type { AvatarCropArea } from '@/lib/avatar-crop';

const MIN_SIZE_PX = 64;
const KEY_STEP_PX = 8;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const styles = stylex.create({
  stage: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
  },
  frame: {
    position: 'relative',
    display: 'inline-block',
    lineHeight: 0,
    userSelect: 'none',
    touchAction: 'none',
  },
  image: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '60vh',
    pointerEvents: 'none',
  },
  dim: {
    position: 'absolute',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    // The huge spread shadow dims everything outside the selection.
    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
  },
  box: {
    position: 'absolute',
    boxSizing: 'border-box',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'white',
    // A faint dark halo keeps the dashed line readable over light images.
    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.3)',
    cursor: 'move',
    outlineOffset: 3,
  },
  roundGuide: {
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255, 255, 255, 0.6)',
    pointerEvents: 'none',
  },
  handle: {
    position: 'absolute',
    width: 10,
    height: 10,
    boxSizing: 'border-box',
    backgroundColor: 'white',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 2,
  },
  nw: { top: -6, left: -6, cursor: 'nwse-resize' },
  ne: { top: -6, right: -6, cursor: 'nesw-resize' },
  sw: { bottom: -6, left: -6, cursor: 'nesw-resize' },
  se: { bottom: -6, right: -6, cursor: 'nwse-resize' },
  clip: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
});

type Selection = { x: number; y: number; size: number };

interface SquareCropperProps {
  imageUrl: string;
  /** `round` only adds a circular guide; the reported area is always square. */
  shape: 'round' | 'rect';
  label: string;
  onAreaChange: (area: AvatarCropArea | null) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A fixed image with a square selection that is moved by dragging its body and
 * resized by dragging a corner. Selection state lives in source-image pixels so
 * layout changes never alter what will be exported.
 */
export function SquareCropper({ imageUrl, shape, label, onAreaChange }: SquareCropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const drag = useRef<
    | { kind: 'move'; startX: number; startY: number; origin: Selection }
    | { kind: 'resize'; corner: Corner; anchorX: number; anchorY: number }
    | null
  >(null);

  const minSize = natural ? Math.min(MIN_SIZE_PX / scale, natural.width, natural.height) : 0;

  const measure = useCallback(() => {
    const image = imageRef.current;
    if (!image || image.naturalWidth === 0) return;
    setScale(image.clientWidth / image.naturalWidth);
  }, []);

  useEffect(() => {
    setNatural(null);
    setSelection(null);
  }, [imageUrl]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    return () => observer.disconnect();
  }, [measure, imageUrl]);

  useEffect(() => {
    onAreaChange(
      selection
        ? {
            x: Math.round(selection.x),
            y: Math.round(selection.y),
            width: Math.round(selection.size),
            height: Math.round(selection.size),
          }
        : null
    );
  }, [selection, onAreaChange]);

  const handleLoad = () => {
    const image = imageRef.current;
    if (!image) return;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    setNatural({ width, height });
    setScale(image.clientWidth / width);
    const size = Math.min(width, height);
    setSelection({ x: (width - size) / 2, y: (height - size) / 2, size });
  };

  /** Pointer position in source-image pixels. */
  const toSource = (event: PointerEvent) => {
    const rect = imageRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const beginMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!selection || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toSource(event);
    drag.current = { kind: 'move', startX: point.x, startY: point.y, origin: selection };
  };

  const beginResize = (corner: Corner) => (event: PointerEvent<HTMLDivElement>) => {
    if (!selection || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      kind: 'resize',
      corner,
      anchorX: corner.endsWith('w') ? selection.x + selection.size : selection.x,
      anchorY: corner.startsWith('n') ? selection.y + selection.size : selection.y,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || !natural) return;
    const point = toSource(event);
    if (active.kind === 'move') {
      const { origin } = active;
      setSelection({
        size: origin.size,
        x: clamp(origin.x + point.x - active.startX, 0, natural.width - origin.size),
        y: clamp(origin.y + point.y - active.startY, 0, natural.height - origin.size),
      });
      return;
    }
    const sx = active.corner.endsWith('e') ? 1 : -1;
    const sy = active.corner.startsWith('s') ? 1 : -1;
    const room = Math.min(
      sx > 0 ? natural.width - active.anchorX : active.anchorX,
      sy > 0 ? natural.height - active.anchorY : active.anchorY
    );
    const raw = Math.max((point.x - active.anchorX) * sx, (point.y - active.anchorY) * sy);
    const size = clamp(raw, Math.min(minSize, room), room);
    setSelection({
      size,
      x: sx > 0 ? active.anchorX : active.anchorX - size,
      y: sy > 0 ? active.anchorY : active.anchorY - size,
    });
  };

  const endDrag = () => {
    drag.current = null;
  };

  // Keyboard: arrows move, +/- resize around the centre.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selection || !natural) return;
    const step = KEY_STEP_PX / scale;
    let { x, y, size } = selection;
    switch (event.key) {
      case 'ArrowLeft':
        x -= step;
        break;
      case 'ArrowRight':
        x += step;
        break;
      case 'ArrowUp':
        y -= step;
        break;
      case 'ArrowDown':
        y += step;
        break;
      case '+':
      case '=':
      case '-': {
        const next = clamp(
          size + (event.key === '-' ? -step * 2 : step * 2),
          minSize,
          Math.min(natural.width, natural.height)
        );
        x -= (next - size) / 2;
        y -= (next - size) / 2;
        size = next;
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    setSelection({
      size,
      x: clamp(x, 0, natural.width - size),
      y: clamp(y, 0, natural.height - size),
    });
  };

  const boxStyle = selection
    ? {
        left: selection.x * scale,
        top: selection.y * scale,
        width: selection.size * scale,
        height: selection.size * scale,
      }
    : null;

  return (
    <div {...stylex.props(styles.stage)}>
      <div {...stylex.props(styles.frame)}>
        <img
          ref={imageRef}
          src={imageUrl}
          alt=""
          draggable={false}
          onLoad={handleLoad}
          {...stylex.props(styles.image)}
        />
        {boxStyle ? (
          <>
            <div {...stylex.props(styles.clip)}>
              <div style={boxStyle} {...stylex.props(styles.dim)} />
            </div>
            <div
              role="group"
              tabIndex={0}
              aria-label={label}
              onPointerDown={beginMove}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={handleKeyDown}
              style={boxStyle}
              {...stylex.props(styles.box)}
            >
              {shape === 'round' ? <div {...stylex.props(styles.roundGuide)} /> : null}
              {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <div
                  key={corner}
                  onPointerDown={beginResize(corner)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  {...stylex.props(styles.handle, styles[corner])}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
