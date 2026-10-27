import { withClassName } from '@/lib/stylex';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import jellyfishSheet from '@/assets/onboarding/lody-jellyfish-animation-8f.png';
import pearlSheet from '@/assets/onboarding/session-pearl-animation-8f.png';
import fishSheet from '@/assets/onboarding/agent-companion-fish-animation-8f.png';
import distantFishSchool from '@/assets/onboarding/distant-fish-school-8f.png';
import distantFishSchoolBright from '@/assets/onboarding/distant-fish-school-bright-8f.png';
import shellSheet from '@/assets/onboarding/issue-shell-animation-8f.png';
import coralSheet from '@/assets/onboarding/project-coral-reef-animation-8f.png';
import underwaterBasePlate from '@/assets/onboarding/underwater-base-plate.png';
import rockPileDecoration from '@/assets/onboarding/decorations/rock-pile-static.png';
import rockPileDecoration00 from '@/assets/onboarding/decorations/rock-pile-static-00.png';
import rockPileDecoration04 from '@/assets/onboarding/decorations/rock-pile-static-04.png';
import rockPileDecoration06 from '@/assets/onboarding/decorations/rock-pile-static-06.png';
import rockPileDecoration07 from '@/assets/onboarding/decorations/rock-pile-static-07.png';
import kelpRockDecoration00 from '@/assets/onboarding/decorations/kelp-rock-static-00.png';
import kelpRockDecoration04 from '@/assets/onboarding/decorations/kelp-rock-static-04.png';
import kelpRockDecoration07 from '@/assets/onboarding/decorations/kelp-rock-static-07.png';
import seaweedDecoration from '@/assets/onboarding/decorations/seaweed-static.png';
import seaweedDecoration01 from '@/assets/onboarding/decorations/seaweed-static-01.png';
import seaweedDecoration06 from '@/assets/onboarding/decorations/seaweed-static-06.png';
import starfishDecoration from '@/assets/onboarding/decorations/starfish-static.png';
import starfishDecoration00 from '@/assets/onboarding/decorations/starfish-static-00.png';
import starfishDecoration03 from '@/assets/onboarding/decorations/starfish-static-03.png';
import starfishDecoration06 from '@/assets/onboarding/decorations/starfish-static-06.png';
import starfishDecoration07 from '@/assets/onboarding/decorations/starfish-static-07.png';
import { underwaterSurface } from './underwater-surface';

const sceneStyles = stylex.create({ distantWeed: { opacity: 0.2 } });

// The underwater world that lives at the bottom of the intro. It is a pure
// overlay: it mounts nothing inside the shot system, intercepts no pointer
// events, and the intro above it is untouched.
//
// Every animated sprite is a 4x2 spritesheet (8 frames) whose FRAME carries
// generous transparent padding. If the frame were placed directly, the visible
// prop would hover above wherever it was meant to sit — so each sprite is
// trimmed to its measured content box (alpha-bbox across all 8 frames) and the
// layout below positions CONTENT, not frames. `bottom: 0` means "resting on
// the seabed", and the placement numbers stay true at any viewport. The source
// cell aspect ratio must stay intact, otherwise the browser stretches the art.

/** Content bounding box of a sheet, as fractions of one frame. */
type Trim = { x: number; y: number; w: number; h: number };

type SheetSpec = {
  src: string;
  /** Width / height of ONE frame (sheet w/4, sheet h/2). */
  frameAspect: number;
  trim: Trim;
};

// Sheets are normalized by tmp/imagegen/normalize-sprites.mjs. That script
// preserves the source sheet dimensions, keeps every frame inside its fixed
// grid cell, and aligns content without changing the cell aspect ratio. Re-run
// it and update these measured trims if a sheet is regenerated.
const SHEETS = {
  jellyfish: {
    src: jellyfishSheet,
    frameAspect: 362 / 543,
    trim: {
      x: 0.06077348066298342,
      y: 0.26151012891344383,
      w: 0.8397790055248618,
      h: 0.49355432780847147,
    },
  },
  pearl: {
    src: pearlSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.025677603423680456,
      y: 0.11942959001782531,
      w: 0.8445078459343794,
      h: 0.7165775401069518,
    },
  },
  fish: {
    src: fishSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.0456490727532097,
      y: 0.23351158645276293,
      w: 0.7703281027104137,
      h: 0.5080213903743316,
    },
  },
  shell: {
    src: shellSheet,
    frameAspect: 384 / 512,
    trim: {
      x: 0.018229166666666668,
      y: 0.12109375,
      w: 0.8828125,
      h: 0.779296875,
    },
  },
  coral: {
    src: coralSheet,
    frameAspect: 350.5 / 561,
    trim: {
      x: 0.04850213980028531,
      y: 0.2014260249554367,
      w: 0.9243937232524965,
      h: 0.5347593582887701,
    },
  },
} satisfies Record<string, SheetSpec>;

// The base plate is a 1672 × 941 world, not a decorative wallpaper. Everything
// in the scene is positioned inside a single cover-scaled world layer so its
// reef line, floor perspective and props always receive the same crop.
const UNDERWATER_WORLD = {
  width: 1672,
  height: 941,
  // Reference bands measured from the base plate. Keep new ground props in
  // these bands instead of choosing positions from the viewport height.
  rearReef: { top: 600, bottom: 735 },
  vanishingLine: 748,
  middleFloor: { top: 748, bottom: 830 },
  foregroundFloor: { top: 830, bottom: 941 },
} as const;

// This is the camera-space coordinate system for objects that belong to the
// seabed. X is lateral position, Z runs from foreground (0) to the vanishing
// line (1), and Y is elevation above the ground in source-world pixels.
const UNDERWATER_CAMERA = {
  centreX: UNDERWATER_WORLD.width / 2,
  vanishingY: UNDERWATER_WORLD.vanishingLine,
  foregroundY: 910,
  nearHalfWidth: 760,
  farHalfWidth: 360,
  nearScale: 1,
  farScale: 0.38,
} as const;

type WorldPoint = {
  /** Lateral coordinate on the ground plane. -1 / 1 are the near floor edges. */
  x: number;
  /** Elevation above the floor in source-world pixels. */
  y?: number;
  /** 0 = foreground floor, 1 = vanishing line. */
  z: number;
};

function interpolate(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function projectWorldPoint({ x, y = 0, z }: WorldPoint): { x: number; y: number; scale: number } {
  const depth = Math.min(1, Math.max(0, z));
  const groundY = interpolate(UNDERWATER_CAMERA.foregroundY, UNDERWATER_CAMERA.vanishingY, depth);
  const halfWidth = interpolate(
    UNDERWATER_CAMERA.nearHalfWidth,
    UNDERWATER_CAMERA.farHalfWidth,
    depth
  );
  const scale = interpolate(UNDERWATER_CAMERA.nearScale, UNDERWATER_CAMERA.farScale, depth);
  return {
    x: UNDERWATER_CAMERA.centreX + x * halfWidth,
    y: groundY - y * scale,
    scale,
  };
}

// Painted into the environment plate. These are source-plate pixel anchors,
// deliberately separate from projected scene objects until the terrain height
// field is calibrated from the base artwork.
const BASE_CORAL_MARKS = [
  { label: 'base coral L-rear', x: 58, y: 752 },
  { label: 'base coral L-near', x: 228, y: 808 },
  { label: 'base coral R-near', x: 1508, y: 762 },
  { label: 'base coral R-rear', x: 1614, y: 732 },
] as const;

// Source-pixel control lines traced from the visible junction between each
// painted side bank and the central sand channel. They are deliberately not a
// height function: approving these asymmetric ridges comes before deriving a
// triangulated terrain surface from them.
const BASE_TERRAIN_RIDGES = {
  left: [
    [0, 566],
    [72, 596],
    [158, 640],
    [276, 690],
    [414, 724],
    [548, 744],
    [654, 750],
  ],
  right: [
    [1672, 554],
    [1580, 566],
    [1482, 600],
    [1372, 648],
    [1256, 698],
    [1130, 738],
    [1018, 750],
  ],
} as const;

type SpriteProps = {
  sheet: SheetSpec;
  /** Seconds for a full 8-frame loop. */
  duration: number;
  /** Negative delays desynchronise loops that share a duration. */
  delay?: number;
  /** The caller's own placement of the sprite, in the world's coordinates. */
  styles?: stylex.StyleXStyles;
  style?: React.CSSProperties;
};

/**
 * A spritesheet animation whose element box IS the sprite's content box: the
 * wrapper takes the content size, and the full frame overflows it by exactly
 * the trimmed padding. Positioning classes on the wrapper therefore place the
 * visible prop itself.
 */
function Sprite({ sheet, duration, delay = 0, styles, style }: SpriteProps): React.JSX.Element {
  const { src, frameAspect, trim } = sheet;
  return (
    <div
      aria-hidden
      {...stylex.props(styles)}
      style={{ aspectRatio: `${(trim.w * frameAspect) / trim.h}`, ...style }}
    >
      <div {...stylex.props(underwaterSurface.spriteFrame)}>
        <div
          {...withClassName(stylex.props(underwaterSurface.spriteSheet), 'lody-sprite-8f')}

          style={{
            width: `${100 / trim.w}%`,
            height: `${100 / trim.h}%`,
            left: `${-(trim.x / trim.w) * 100}%`,
            top: `${-(trim.y / trim.h) * 100}%`,
            backgroundImage: `url(${src})`,
            animationDuration: `${duration}s`,
            animationDelay: `${delay}s`,
          }}
        />
      </div>
    </div>
  );
}

/** A horizontal sprite seated on the central floor plane. Keep flat-bottomed
 * assets (the project coral reef and shell) here; side banks use only painted
 * background detail until we have slope-shaped source art. */
function FloorSprite({
  point,
  size,
  sheet,
  duration,
  delay,
  styles,
}: SpriteProps & {
  point: WorldPoint;
  size: number;
}): React.JSX.Element {
  const projected = projectWorldPoint(point);
  const aspect = (sheet.trim.w * sheet.frameAspect) / sheet.trim.h;
  const width = size * projected.scale;
  const height = width / aspect;

  return (
    <Sprite
      sheet={sheet}
      duration={duration}
      delay={delay}
      styles={[underwaterSurface.floorProp, styles]}
      style={{
        left: `${((projected.x - width / 2) / UNDERWATER_WORLD.width) * 100}%`,
        top: `${((projected.y - height) / UNDERWATER_WORLD.height) * 100}%`,
        width: `${(width / UNDERWATER_WORLD.width) * 100}%`,
      }}
    />
  );
}

/** A static object seated on the central floor projection. Unlike `bottom`
 * percentage placement, every floor prop now shares the base plate's X/Y/Z
 * camera and therefore keeps its scale and footing when the window changes. */
function GroundDecoration({
  src,
  point,
  size,
  styles,
}: {
  src: string;
  point: WorldPoint;
  /** Visible width at z=0, in source-world pixels. */ size: number;
  styles?: stylex.StyleXStyles;
}): React.JSX.Element {
  const projected = projectWorldPoint(point);
  const width = size * projected.scale;
  return (
    <img
      aria-hidden
      src={src}
      alt=""
      draggable={false}
      {...withClassName(
        stylex.props(underwaterSurface.staticDecoration, styles),
        'lody-static-decoration'
      )}

      style={{
        left: `${(projected.x / UNDERWATER_WORLD.width) * 100}%`,
        top: `${(projected.y / UNDERWATER_WORLD.height) * 100}%`,
        width: `${(width / UNDERWATER_WORLD.width) * 100}%`,
        transform: 'translate(-50%, -100%)',
      }}
    />
  );
}

/** A full-cell sheet for background life, where generous transparent padding
    is desirable because scale itself communicates depth. */
function AmbientSheet({
  src,
  frames,
  duration,
  delay = 0,
  styles,
  style,
}: {
  src: string;
  frames: 8 | 9;
  duration: number;
  delay?: number;
  styles?: stylex.StyleXStyles;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const props = stylex.props(styles);
  return (
    <div
      aria-hidden
      {...props}
      className={clsx(props.className, frames === 8 ? 'lody-sprite-8f' : 'lody-sprite-9f')}
      style={{
        backgroundImage: `url(${src})`,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
        ...style,
      }}
    />
  );
}

function StaticDecoration({
  src,
  styles,
}: {
  src: string;
  styles: stylex.StyleXStyles;
}): React.JSX.Element {
  return (
    <img
      aria-hidden
      src={src}
      alt=""
      draggable={false}
      {...withClassName(
        stylex.props(underwaterSurface.staticDecoration, styles),
        'lody-static-decoration'
      )}
    />
  );
}

/**
 * A stream of rising bubbles. Bubbles are plain CSS radial-gradients rising on
 * a keyframe, staggered by delay so the column never moves in lockstep.
 */
function BubbleStream({
  left,
  count,
  height,
  seed = 0,
}: {
  left: string;
  count: number;
  /** Pixel height the bubbles climb before resetting. */
  height: number;
  /** Offsets the pseudo-random stagger between streams. */
  seed?: number;
}): React.JSX.Element {
  return (
    <div {...stylex.props(underwaterSurface.bubbleColumn)} style={{ left }}>
      {Array.from({ length: count }, (_, i) => {
        const size = 4 + ((i * 7 + seed * 13) % 9);
        const drift = ((i * 11 + seed * 5) % 17) - 8;
        const duration = 6 + ((i * 3 + seed) % 5);
        const delay = -(((i * 2.3 + seed * 1.7) % duration) + 0.1);
        return (
          <span
            key={i}
            className="lody-bubble"
            style={
              {
                width: size,
                height: size,
                marginLeft: drift,
                animationDuration: `${duration}s`,
                animationDelay: `${delay}s`,
                '--lody-bubble-rise': `${height}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/** Slow-drifting plankton specks that give the water column some depth. */
function DriftSpecks(): React.JSX.Element {
  return (
    <>
      {Array.from({ length: 10 }, (_, i) => {
        const size = 2 + (i % 3);
        return (
          <span
            key={i}
            className="lody-speck"
            style={{
              width: size,
              height: size,
              left: `${(i * 37) % 100}%`,
              bottom: `${8 + ((i * 19) % 30)}%`,
              animationDuration: `${9 + (i % 4) * 3}s`,
              animationDelay: `${-(i * 1.3)}s`,
            }}
          />
        );
      })}
    </>
  );
}

/** Storybook-only inspection aid for the camera-space floor projection. */
function WorldCoordinateDebug(): React.JSX.Element {
  const zLines = [0, 0.25, 0.5, 0.75, 1];
  const xLines = [-1, -0.5, 0, 0.5, 1];
  const farLeft = projectWorldPoint({ x: -1, z: 1 });
  const farRight = projectWorldPoint({ x: 1, z: 1 });
  const nearLeft = projectWorldPoint({ x: -1, z: 0 });
  const nearRight = projectWorldPoint({ x: 1, z: 0 });
  const origin = projectWorldPoint({ x: 0, z: 1 });

  return (
    <svg
      aria-hidden
      {...withClassName(stylex.props(underwaterSurface.debugSpace), 'lody-underwater-debug-space')}

      viewBox={`0 0 ${UNDERWATER_WORLD.width} ${UNDERWATER_WORLD.height}`}
      preserveAspectRatio="none"
    >
      <g className="lody-underwater-debug-floor">
        <path
          d={`M ${nearLeft.x} ${nearLeft.y} L ${farLeft.x} ${farLeft.y} L ${farRight.x} ${farRight.y} L ${nearRight.x} ${nearRight.y} Z`}
        />
        {zLines.map((z) => {
          const left = projectWorldPoint({ x: -1, z });
          const right = projectWorldPoint({ x: 1, z });
          return <line key={`z-${z}`} x1={left.x} y1={left.y} x2={right.x} y2={right.y} />;
        })}
        {xLines.map((x) => {
          const near = projectWorldPoint({ x, z: 0 });
          const far = projectWorldPoint({ x, z: 1 });
          return <line key={`x-${x}`} x1={near.x} y1={near.y} x2={far.x} y2={far.y} />;
        })}
      </g>
      <g className="lody-underwater-debug-ridge">
        {Object.entries(BASE_TERRAIN_RIDGES).map(([side, points]) => (
          <g key={side}>
            <polyline points={points.map(([x, y]) => `${x},${y}`).join(' ')} />
            {points.map(([x, y], index) => (
              <circle key={`${side}-${index}`} cx={x} cy={y} r="6" />
            ))}
          </g>
        ))}
      </g>
      <g className="lody-underwater-debug-axis">
        <line x1={nearLeft.x} y1={nearLeft.y} x2={nearRight.x} y2={nearRight.y} />
        <line x1={nearLeft.x} y1={nearLeft.y} x2={origin.x} y2={origin.y} />
        <line x1={origin.x} y1={origin.y} x2={origin.x} y2={origin.y - 230} />
      </g>
      <g className="lody-underwater-debug-copy">
        <text x={nearRight.x - 8} y={nearRight.y - 10}>
          X · lateral
        </text>
        <text x={origin.x + 10} y={origin.y + 22}>
          Z · depth → 1
        </text>
        <text x={origin.x + 10} y={origin.y - 218}>
          Y · elevation
        </text>
        <text x="22" y="34">
          CAMERA SPACE · X lateral · Y elevation · Z depth
        </text>
        <text x="22" y="54">
          world 1672 × 941 · floor projection, not viewport grid
        </text>
        <text x="22" y="74">
          orange · painted bank ridge controls (mesh intentionally not built yet)
        </text>
      </g>
      <g className="lody-underwater-debug-base-mark">
        {BASE_CORAL_MARKS.map((mark) => (
          <g key={mark.label}>
            <circle cx={mark.x} cy={mark.y} r="9" />
            <line x1={mark.x} y1={mark.y} x2={mark.x + 34} y2={mark.y - 30} />
            <text x={mark.x + 40} y={mark.y - 34}>
              {mark.label} · {mark.x},{mark.y}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function UnderwaterScene({
  visible,
  playing,
  debug = false,
  showTextures = false,
}: {
  /** Fades the whole scene in/out. It stays mounted either way. */
  visible: boolean;
  playing: boolean;
  /** Coordinate guide for visual calibration; Storybook only. */
  debug?: boolean;
  /** Temporary scene-asset gate. Debug geometry remains available when false. */
  showTextures?: boolean;
}): React.JSX.Element {
  const scene = stylex.props(underwaterSurface.scene);
  return (
    <div
      aria-hidden
      {...scene}
      className={clsx(scene.className, playing ? undefined : 'lody-scene-paused')}
      style={{
        opacity: visible ? 1 : 0,
        transition: 'opacity 1600ms ease',
      }}
    >
      <div
        className="lody-underwater-world"
        style={{
          aspectRatio: `${UNDERWATER_WORLD.width} / ${UNDERWATER_WORLD.height}`,
        }}
      >
        {/* The environment plate and water light remain visible while scene
          sprites are temporarily hidden. */}
        <img
          aria-hidden
          src={underwaterBasePlate}
          alt=""
          draggable={false}
          {...withClassName(stylex.props(underwaterSurface.base), 'lody-underwater-base')}
        />
        <div
          aria-hidden
          {...withClassName(stylex.props(underwaterSurface.depth), 'lody-underwater-depth')}
        />
        <div {...withClassName(stylex.props(underwaterSurface.seabed), 'lody-seabed')} />
        <div {...withClassName(stylex.props(underwaterSurface.seaglowLeft), 'lody-seaglow')} />
        <div
          {...withClassName(stylex.props(underwaterSurface.seaglowRight), 'lody-seaglow')}

          style={{ opacity: 0.7 }}
        />

        {showTextures && (
          <>
            {/* Stage coordinates: x moves left-to-right across the 0–100% world;
          the seabed is y=0. Foreground lives below 30%, midwater below 55%,
          and distant life below 68%, leaving the upper centre clear for copy. */}
            <DriftSpecks />

            {/* Distant layer — low contrast and small scale establishes the vanishing
          line instead of filling the screen with repeated foreground fish. */}
            <div
              {...withClassName(
                stylex.props(underwaterSurface.distantSchoolDrift),
                'lody-distant-school-drift'
              )}
            >
              <AmbientSheet
                src={distantFishSchool}
                frames={8}
                duration={1.55}
                delay={-0.8}
                styles={underwaterSurface.fill}
              />
            </div>
            <div
              {...withClassName(stylex.props(underwaterSurface.jellyHigh), 'lody-jelly-bob')}

              style={{ animationDuration: '13s', animationDelay: '-6s' }}
            >
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.65}
                delay={-1.2}
                styles={underwaterSurface.jellyWidthSmall}
              />
            </div>
            <div
              {...withClassName(
                stylex.props(underwaterSurface.distantSchoolGlide),
                'lody-distant-school-glide'
              )}

              style={{ animationDuration: '68s', animationDelay: '-31s' }}
            >
              <AmbientSheet
                src={distantFishSchoolBright}
                frames={8}
                duration={1.8}
                delay={-0.9}
                styles={underwaterSurface.fill}
              />
            </div>

            {/* Midwater life: the two schools are distinct assets, while a few single
          fish read as nearer passers-by rather than repeated wallpaper. */}
            <div
              {...withClassName(stylex.props(underwaterSurface.jellyMid), 'lody-jelly-bob')}

              style={{ animationDuration: '9s', animationDelay: '-4s' }}
            >
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.35}
                delay={-0.4}
                styles={underwaterSurface.jellyWidthMid}
              />
            </div>
            <div {...withClassName(stylex.props(underwaterSurface.fishSwayLeft), 'lody-fish-sway')}>
              <Sprite
                sheet={SHEETS.fish}
                duration={1.05}
                delay={-0.4}
                styles={underwaterSurface.fishWidthLarge}
              />
            </div>
            <div
              {...withClassName(stylex.props(underwaterSurface.fishSwimLeft), 'lody-fish-swim')}

              style={{ animationDuration: '42s', animationDelay: '-19s' }}
            >
              <Sprite
                sheet={SHEETS.fish}
                duration={1.25}
                delay={-0.9}
                styles={underwaterSurface.fishWidthMedium}
              />
            </div>
            <div
              {...withClassName(stylex.props(underwaterSurface.fishSwayRight), 'lody-fish-sway')}
            >
              <Sprite
                sheet={SHEETS.fish}
                duration={1.4}
                delay={-0.7}
                styles={underwaterSurface.fishWidthSmall}
              />
            </div>
            <div
              {...withClassName(stylex.props(underwaterSurface.fishSwayMiddle), 'lody-fish-sway')}
            >
              <Sprite
                sheet={SHEETS.fish}
                duration={1.2}
                delay={-0.2}
                styles={underwaterSurface.fishWidthMiddle}
              />
            </div>

            {/* Background floor accents are deliberately static. They start at the
          horizon and step forward in depth, leaving the near floor to the
          larger shell, Lody, and animated seaweed below. */}
            <GroundDecoration
              src={rockPileDecoration07}
              point={{ x: -0.18, z: 0.94 }}
              size={88}
              styles={underwaterSurface.reefFar}
            />
            <GroundDecoration
              src={seaweedDecoration06}
              point={{ x: 0.58, z: 0.88 }}
              size={106}
              styles={underwaterSurface.reefFar}
            />
            <FloorSprite
              point={{ x: -0.48, z: 0.96 }}
              size={154}
              sheet={SHEETS.coral}
              duration={2.1}
              delay={-1.1}
              styles={underwaterSurface.reefMid}
            />
            <FloorSprite
              point={{ x: 0.46, z: 0.91 }}
              size={132}
              sheet={SHEETS.coral}
              duration={2.45}
              delay={-0.3}
              styles={underwaterSurface.reefNear}
            />
            <GroundDecoration
              src={rockPileDecoration07}
              point={{ x: 0.08, z: 0.97 }}
              size={70}
              styles={underwaterSurface.reefFar}
            />
            <GroundDecoration
              src={kelpRockDecoration00}
              point={{ x: 0.3, z: 0.85 }}
              size={126}
              styles={underwaterSurface.reefNear}
            />
            <GroundDecoration
              src={seaweedDecoration01}
              point={{ x: -0.62, z: 0.86 }}
              size={92}
              styles={underwaterSurface.reefFar}
            />
            <GroundDecoration
              src={kelpRockDecoration07}
              point={{ x: -0.82, z: 0.78 }}
              size={136}
              styles={underwaterSurface.reefNear}
            />
            <GroundDecoration
              src={seaweedDecoration}
              point={{ x: 0.8, z: 0.84 }}
              size={94}
              styles={[underwaterSurface.reefFar, sceneStyles.distantWeed]}
            />

            {/* Flat-bottomed semantic props get their own middle plane. This is
          deliberately larger than the horizon detail, while still behind the
          hero and the foreground shell. */}
            <FloorSprite
              point={{ x: -0.48, z: 0.44 }}
              size={232}
              sheet={SHEETS.coral}
              duration={2.25}
              delay={-0.7}
              styles={underwaterSurface.coralMid}
            />
            <FloorSprite
              point={{ x: 0.42, z: 0.65 }}
              size={196}
              sheet={SHEETS.coral}
              duration={2.55}
              delay={-1.4}
              styles={underwaterSurface.coralFar}
            />
            <FloorSprite
              point={{ x: -0.03, z: 0.55 }}
              size={146}
              sheet={SHEETS.shell}
              duration={2.75}
              delay={-0.9}
              styles={underwaterSurface.shellMid}
            />
            <FloorSprite
              point={{ x: -0.03, y: 56, z: 0.55 }}
              size={54}
              sheet={SHEETS.pearl}
              duration={1.95}
              delay={-1.2}
              styles={underwaterSurface.pearlMid}
            />

            {/* Foreground seabed uses different static variants from the supplied
          prop library. Fish, jellyfish, bubbles and semantic props carry the
          motion; the environment itself does not pulse in lockstep. */}
            <StaticDecoration src={kelpRockDecoration00} styles={underwaterSurface.propNearLeft} />
            <StaticDecoration src={seaweedDecoration01} styles={underwaterSurface.weedNearLeft} />
            <StaticDecoration src={kelpRockDecoration04} styles={underwaterSurface.rockNearLeft} />

            <StaticDecoration
              src={rockPileDecoration00}
              styles={underwaterSurface.rockNearMiddle}
            />
            <StaticDecoration src={rockPileDecoration} styles={underwaterSurface.rockNearRight} />
            <StaticDecoration
              src={rockPileDecoration04}
              styles={underwaterSurface.shellNearRight}
            />
            <StaticDecoration src={rockPileDecoration06} styles={underwaterSurface.rockFarRight} />
            <StaticDecoration
              src={rockPileDecoration07}
              styles={underwaterSurface.weedNearMiddle}
            />

            <StaticDecoration src={starfishDecoration00} styles={underwaterSurface.starfishOne} />
            <StaticDecoration src={starfishDecoration} styles={underwaterSurface.starfishTwo} />
            <StaticDecoration src={starfishDecoration03} styles={underwaterSurface.starfishThree} />
            <StaticDecoration src={starfishDecoration06} styles={underwaterSurface.starfishFour} />
            <StaticDecoration src={starfishDecoration07} styles={underwaterSurface.starfishFive} />

            {/* Foreground anchors — the shell and low seabed props frame the near
          floor. Coral belongs in the middle-to-far reef layer above. */}
            <div {...stylex.props(underwaterSurface.anchorShell)}>
              <Sprite sheet={SHEETS.shell} duration={2.6} delay={-0.4} />
              <div {...stylex.props(underwaterSurface.pearlInShell)}>
                <div
                  {...withClassName(stylex.props(underwaterSurface.pearlGlow), 'lody-pearl-glow')}
                />
                <Sprite sheet={SHEETS.pearl} duration={1.85} delay={-1.1} />
              </div>
            </div>
            <Sprite
              sheet={SHEETS.pearl}
              duration={2.35}
              delay={-0.5}
              styles={underwaterSurface.pearlLoose}
            />

            {/* Lody is the hero in the nearest moving plane: large enough to lead,
          but lifted above the floor so the coral and shell keep their depth. */}
            <div {...withClassName(stylex.props(underwaterSurface.jellyNear), 'lody-jelly-bob')}>
              <Sprite
                sheet={SHEETS.jellyfish}
                duration={1.15}
                styles={underwaterSurface.jellyWidthHero}
              />
            </div>
          </>
        )}
        {/* Bubbles belong to the water layer, rather than the toggled props. */}
        <BubbleStream left="8%" count={4} height={260} seed={1} />
        <BubbleStream left="24%" count={3} height={190} seed={5} />
        <BubbleStream left="47%" count={3} height={170} seed={2} />
        <BubbleStream left="88%" count={4} height={240} seed={4} />
        {debug && <WorldCoordinateDebug />}
      </div>
    </div>
  );
}
