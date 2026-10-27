import * as stylex from '@stylexjs/stylex';

/**
 * The underwater world's layout.
 *
 * The scene is a painted plate with sprites seated on it, so almost every rule
 * here is a position: where a prop sits in the 1672×941 world, and how far
 * back it is. The sizes and offsets are the world measurements the artwork was
 * drawn against, so they are written as the same values the scene used before.
 */
export const underwaterSurface = stylex.create({
  /** The scene's own plane: the viewport, clipped. */
  scene: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  /** The environment plate, covering the world. */
  base: { position: 'absolute', inset: 0, zIndex: 0, width: '100%', height: '100%' },
  /** The water light over the plate. */
  depth: { position: 'absolute', inset: 0, zIndex: 0 },
  /** The seabed the props stand on. */
  seabed: {
    position: 'absolute',
    insetInline: 0,
    bottom: 0,
    zIndex: 10,
    height: '34%',
  },
  /** The near glow of the seabed, on the left. */
  seaglowLeft: {
    position: 'absolute',
    bottom: '-12%',
    left: '8%',
    zIndex: 10,
    height: '38%',
    width: '48%',
  },
  /** The near glow of the seabed, on the right. */
  seaglowRight: {
    position: 'absolute',
    bottom: '-14%',
    right: '2%',
    zIndex: 10,
    height: '35%',
    width: '38%',
  },

  /** The frame a sprite is painted in: its own content box. */
  spriteFrame: { position: 'relative', width: '100%', height: '100%' },
  /** The sheet the sprite's frame is cut from. */
  spriteSheet: { position: 'absolute' },
  /** A static prop seated on the floor. */
  staticDecoration: { position: 'absolute' },
  /** A prop seated on the floor, in front of the plate. */
  floorProp: { position: 'absolute' },

  /** The column of bubbles rising from the seabed. */
  bubbleColumn: { position: 'absolute', bottom: 0, zIndex: 20 },

  /** The distant school, drifting at the horizon. */
  distantSchoolDrift: {
    position: 'absolute',
    bottom: '46%',
    left: '-12%',
    zIndex: 10,
    aspectRatio: '1 / 1',
    width: 'clamp(56px,6vw,94px)',
    opacity: 0.4,
  },
  /** The distant school, gliding across the horizon. */
  distantSchoolGlide: {
    position: 'absolute',
    bottom: '38%',
    left: '-16%',
    zIndex: 10,
    aspectRatio: '0.625',
    width: 'clamp(104px,11vw,168px)',
    opacity: 0.35,
  },
  /** A jellyfish bobbing high in the water. */
  jellyHigh: {
    position: 'absolute',
    bottom: '55%',
    left: '58%',
    zIndex: 10,
    opacity: 0.24,
  },
  /** A jellyfish bobbing in the midwater. */
  jellyMid: {
    position: 'absolute',
    bottom: '38%',
    right: '27%',
    zIndex: 20,
    opacity: 0.58,
  },
  /** A jellyfish bobbing in the foreground. */
  jellyNear: {
    position: 'absolute',
    bottom: '25%',
    left: '18%',
    zIndex: 30,
  },
  /** A fish swaying in the midwater. */
  fishSwayLeft: {
    position: 'absolute',
    bottom: '22%',
    left: '58%',
    zIndex: 20,
  },
  /** A fish swimming across the left of the frame. */
  fishSwimLeft: {
    position: 'absolute',
    bottom: '31%',
    left: 0,
    zIndex: 20,
    opacity: 0.65,
  },
  /** A fish swaying on the right of the frame. */
  fishSwayRight: {
    position: 'absolute',
    bottom: '43%',
    right: '11%',
    zIndex: 20,
    opacity: 0.52,
  },
  /** A fish swaying in the middle of the frame. */
  fishSwayMiddle: {
    position: 'absolute',
    bottom: '34%',
    left: '43%',
    zIndex: 20,
    opacity: 0.66,
  },

  /** The background reef detail, faint against the plate. */
  reefFar: { zIndex: 10, opacity: 0.22 },
  /** The mid reef detail. */
  reefMid: { zIndex: 10, opacity: 0.28 },
  /** The near reef detail. */
  reefNear: { zIndex: 10, opacity: 0.24 },
  /** A mid-plane coral, at the horizon's edge. */
  coralMid: { zIndex: 15, opacity: 0.54 },
  /** A coral further back. */
  coralFar: { zIndex: 15, opacity: 0.44 },
  /** A shell on the mid plane. */
  shellMid: { zIndex: 15, opacity: 0.7 },
  /** The pearl on the mid plane. */
  pearlMid: { zIndex: 16, opacity: 0.78 },

  /** A foreground prop on the near floor. */
  propNearLeft: {
    position: 'absolute',
    bottom: '-3%',
    left: '10%',
    zIndex: 20,
    width: 'clamp(58px,6.4vw,98px)',
    opacity: 0.58,
  },
  /** A foreground weed on the near floor. */
  weedNearLeft: {
    position: 'absolute',
    bottom: '-2%',
    left: '34%',
    zIndex: 20,
    width: 'clamp(42px,4.8vw,72px)',
    opacity: 0.68,
  },
  /** A foreground rock on the near floor. */
  rockNearLeft: {
    position: 'absolute',
    bottom: '-3%',
    right: '27%',
    zIndex: 20,
    width: 'clamp(64px,7.2vw,110px)',
    opacity: 0.56,
  },
  /** A foreground rock in the middle of the floor. */
  rockNearMiddle: {
    position: 'absolute',
    bottom: '1%',
    left: '39%',
    zIndex: 30,
    width: 'clamp(56px,6vw,90px)',
    opacity: 0.74,
  },
  /** A foreground rock on the right of the floor. */
  rockNearRight: {
    position: 'absolute',
    bottom: '1%',
    right: '23%',
    zIndex: 30,
    width: 'clamp(48px,5.2vw,80px)',
    opacity: 0.78,
  },
  /** A foreground shell on the right of the floor. */
  shellNearRight: {
    position: 'absolute',
    bottom: '1%',
    left: '64%',
    zIndex: 30,
    width: 'clamp(42px,4.8vw,72px)',
    opacity: 0.72,
  },
  /** A foreground rock at the right edge of the floor. */
  rockFarRight: {
    position: 'absolute',
    bottom: 0,
    right: '31%',
    zIndex: 30,
    width: 'clamp(48px,5.4vw,82px)',
    opacity: 0.7,
  },
  /** A foreground weed in the middle of the floor. */
  weedNearMiddle: {
    position: 'absolute',
    bottom: '1%',
    left: '54%',
    zIndex: 30,
    width: 'clamp(34px,3.8vw,58px)',
    opacity: 0.74,
  },
  /** A foreground starfish. */
  starfishOne: {
    position: 'absolute',
    bottom: '2%',
    left: '47%',
    zIndex: 30,
    width: 'clamp(24px,2.7vw,40px)',
    opacity: 0.86,
  },
  /** A foreground starfish, slightly larger. */
  starfishTwo: {
    position: 'absolute',
    bottom: '2%',
    left: '57%',
    zIndex: 30,
    width: 'clamp(25px,3vw,44px)',
    opacity: 0.9,
  },
  /** A foreground starfish, further right. */
  starfishThree: {
    position: 'absolute',
    bottom: '2%',
    left: '73%',
    zIndex: 30,
    width: 'clamp(24px,2.8vw,42px)',
    opacity: 0.86,
  },
  /** A foreground starfish on the right of the floor. */
  starfishFour: {
    position: 'absolute',
    bottom: '9%',
    right: '18%',
    zIndex: 30,
    width: 'clamp(20px,2.3vw,34px)',
    opacity: 0.74,
  },
  /** A foreground starfish at the right edge of the floor. */
  starfishFive: {
    position: 'absolute',
    bottom: '1%',
    right: '41%',
    zIndex: 30,
    width: 'clamp(21px,2.5vw,37px)',
    opacity: 0.82,
  },

  /** The big shell that anchors the near floor. */
  anchorShell: {
    position: 'absolute',
    bottom: '-1%',
    right: '4%',
    zIndex: 30,
    width: 'clamp(138px,14vw,220px)',
  },
  /** The pearl's glow inside the anchor shell. */
  pearlGlow: { position: 'absolute', inset: '-45%' },
  /** The pearl's own place in the anchor shell. */
  pearlInShell: { position: 'absolute', bottom: '24%', left: '30%', width: '38%' },
  /** A pearl swimming free in the near water. */
  pearlLoose: {
    position: 'absolute',
    bottom: '1%',
    left: '32%',
    zIndex: 30,
    width: 'clamp(18px,1.8vw,28px)',
    opacity: 0.72,
  },

  /** The calibration guide's own plane. */
  debugSpace: {
    position: 'absolute',
    inset: 0,
    zIndex: 50,
    width: '100%',
    height: '100%',
    overflow: 'visible',
    pointerEvents: 'none',
  },

  /** A sheet that fills the box it is given. */
  fill: { width: '100%', height: '100%' },
  /** A small jellyfish. */
  jellyWidthSmall: { width: 'clamp(22px,2.1vw,34px)' },
  /** A jellyfish in the midwater. */
  jellyWidthMid: { width: 'clamp(42px,4.2vw,64px)' },
  /** The hero jellyfish. */
  jellyWidthHero: { width: 'clamp(92px,8.4vw,132px)' },
  /** A large fish. */
  fishWidthLarge: { width: 'clamp(48px,4.6vw,72px)' },
  /** A mid-sized fish. */
  fishWidthMedium: { width: 'clamp(32px,3.2vw,50px)' },
  /** A small fish. */
  fishWidthSmall: { width: 'clamp(28px,2.8vw,42px)' },
  /** A fish in the middle of the frame. */
  fishWidthMiddle: { width: 'clamp(34px,3.5vw,52px)' },
  /** A pearl swimming free in the near water. */
  pearlWidth: { width: 'clamp(18px,1.8vw,28px)' },
});
