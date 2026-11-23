'use client';

/**
 * UnderwaterPointCloudBackground
 *
 * An abstract, restrained, "tech" underwater scene rendered as a point cloud:
 *   - a dotted seabed height-field (domain-warped ridged noise + a central
 *     trench) shaded by slope/curvature so ridges catch light and valleys fall
 *     into shadow, with faint topographic contour bands for a sonar feel,
 *   - drifting bioluminescent jellyfish built from points: a ring-sampled bell
 *     with a frilly margin, oral arms, and fine marginal tentacles, animated by
 *     a contraction pulse that travels apex -> rim with the tentacles trailing,
 *   - sparse particle-plankton rising slowly,
 *   - point-cloud coral silhouettes on the ridges,
 *   - a volumetric blue gradient backdrop with a top light shaft.
 *
 * Everything is additive-blended over a baked gradient so distant points fade
 * into "fog" and the whole thing reads as one quiet, breathing volume.
 *
 * Implemented in raw three.js (single dependency) so it stays light enough to
 * sit behind a marketing hero. Honors prefers-reduced-motion (renders a single
 * static frame), pauses when the tab is hidden / scrolled out of view, downgrades
 * on mobile, and falls back to the CSS gradient when WebGL is unavailable.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  computeTerrainAttributes,
  hash2,
  seabedHeight,
  type TerrainAttributes,
} from './underwater-terrain-math';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './underwater-terrain.worker';

type Quality = 'high' | 'medium' | 'low';

export type UnderwaterPointCloudBackgroundProps = {
  quality?: Quality;
  animated?: boolean;
  jellyfishCount?: number;
  particleCount?: number;
  /** Multiplier on the seabed point budget (1 = preset default). */
  terrainDensity?: number;
  className?: string;
  /**
   * Legacy scroll-dive amount (0..1). Landing keeps this at 0 — the camera no
   * longer tracks document scroll. Still read each frame for the ?tune path.
   */
  diveRef?: { readonly current: number };
};

/**
 * Portrait framing pan from viewport **width only**.
 *
 * Historically this was `clamp(1.4 - aspect, 0, 1) * 14`, which re-panned the
 * camera whenever Safari's URL bar showed/hid (height thrash → aspect thrash).
 * Width is stable across that chrome animation, so mid-scroll framing holds.
 * ≥960px → 0; ≤480px → full +14 (same ballpark as the old phone aspect pan).
 */
function framingPanX(width: number): number {
  return THREE.MathUtils.clamp((960 - width) / 480, 0, 1) * 14;
}

type QualityPreset = {
  terrainPoints: number;
  particles: number;
  jellyfish: number;
  jellyBellPoints: number;
  jellyTentacles: number;
  dpr: number;
  antialias: boolean;
};

const PRESETS: Record<Quality, QualityPreset> = {
  high: {
    terrainPoints: 36000,
    particles: 900,
    jellyfish: 4,
    jellyBellPoints: 320,
    jellyTentacles: 22,
    dpr: 2,
    antialias: true,
  },
  medium: {
    terrainPoints: 19000,
    particles: 460,
    jellyfish: 3,
    jellyBellPoints: 240,
    jellyTentacles: 18,
    dpr: 1.6,
    antialias: true,
  },
  low: {
    // Fewer points than medium, but rendered SHARP: phones are 3× displays, and
    // any buffer upscale smears the gaussian-sprite jellyfish into blur (dpr
    // 1.25 read as an outright smudge on iPhone; even 2 left a 1.5× resample).
    // So render at native DPR (capped at 3) and pay for the fill with the
    // smaller point budget; devices that can't keep up get stepped DPR drops
    // from the FPS watchdog instead (see downgrade()).
    terrainPoints: 6200,
    particles: 130,
    // At least two near jellies so portrait framing (camera pan right) still
    // shows a clear floating medusa — previously count=2 meant 1 near (off the
    // left edge) + 1 far/faint (barely visible).
    jellyfish: 3,
    // Portrait frames the near medusa MUCH closer + larger (scale ~2) than
    // desktop, so the same bell stretched over more pixels reads as sparse
    // fuzzy blobs. Give phones a denser bell/tentacle budget than the other
    // tiers — jelly geometry is a few thousand points, effectively free.
    jellyBellPoints: 340,
    jellyTentacles: 20,
    dpr: 3,
    antialias: false,
  },
};

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// ---- tunable parameters -----------------------------------------------------
// A live, mutable object the scene reads from. The ?tune panel mutates it and
// triggers either a cheap uniform update or a terrain rebuild. The defaults
// below ARE the shipped look.

export type TuneParams = {
  heightScale: number;
  baseY: number;
  wallAmp: number;
  wallRoundness: number;
  ridgeRound: number;
  channelWidth: number;
  channelOpen: number;
  heightVar: number;
  slopeVar: number;
  hillsWeight: number;
  crestsWeight: number;
  fineWeight: number;
  trenchDepth: number;
  density: number;
  coralDensity: number;
  lightDiffuse: number;
  lightAmbient: number;
  lightAO: number;
  pointSize: number;
  cameraHeight: number;
  cameraPitch: number;
  ptrReach: number;
  ptrTail: number;
  ptrAmp: number;
  ptrDiffuse: number;
  ptrRecover: number;
  ptrFollow: number;
};

export const DEFAULT_PARAMS: TuneParams = {
  heightScale: 1.3,
  baseY: -6,
  wallAmp: 2.22,
  wallRoundness: 1.31,
  ridgeRound: 0.71,
  channelWidth: 8,
  channelOpen: 1.01,
  heightVar: 0.55,
  slopeVar: 1,
  hillsWeight: 0.57,
  crestsWeight: 0.97,
  fineWeight: 0.12,
  trenchDepth: 0.39,
  density: 1.5,
  coralDensity: 1.45,
  lightDiffuse: 0.84,
  lightAmbient: 0.57,
  lightAO: 0.48,
  pointSize: 1.47,
  cameraHeight: 6.6,
  cameraPitch: -2.9,
  ptrReach: 3.6,
  ptrTail: 7.5,
  ptrAmp: 0.75,
  ptrDiffuse: 0.55,
  ptrRecover: 0.2,
  ptrFollow: 4,
};

const PARAMS: TuneParams = { ...DEFAULT_PARAMS };

// Cheap params apply via a uniform (pointSize) or are read live every frame
// (camera*); every other knob is baked into geometry and needs a rebuild.
const NON_STRUCTURAL = new Set<keyof TuneParams>([
  'pointSize',
  'cameraHeight',
  'cameraPitch',
  'ptrReach',
  'ptrTail',
  'ptrAmp',
  'ptrDiffuse',
  'ptrRecover',
  'ptrFollow',
]);

/** Keys whose change requires rebuilding terrain geometry (the rest are cheap). */
const STRUCTURAL_KEYS = (Object.keys(DEFAULT_PARAMS) as (keyof TuneParams)[]).filter(
  (k) => !NON_STRUCTURAL.has(k)
);

// ---- seabed geometry --------------------------------------------------------
// The noise stack, `seabedHeight`, and the heavy attribute generation live in
// underwater-terrain-math.ts so the terrain worker can run them off the main
// thread. Only the three.js object assembly stays here.

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function buildTerrain(attrs: TerrainAttributes, reveal: number): THREE.Points {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(attrs.positions, 3));
  geo.setAttribute('aHeight', new THREE.BufferAttribute(attrs.normH, 1));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(attrs.rnd, 1));
  geo.setAttribute('aLight', new THREE.BufferAttribute(attrs.light, 1));
  geo.setAttribute('aRidge', new THREE.BufferAttribute(attrs.ridge, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSize: { value: PARAMS.pointSize },
      uReveal: { value: reveal },
      uFogNear: { value: 30 },
      uFogFar: { value: 92 },
      uColorLow: { value: new THREE.Color('#1f5e9c') },
      uColorHigh: { value: new THREE.Color('#cdeaff') },
      uRidge: { value: new THREE.Color('#f3faff') },
      uTheme: { value: 0 },
      uPointer: { value: new THREE.Vector2(1e6, 1e6) },
      uPointerT: { value: 0 },
      uPointerDir: { value: new THREE.Vector2(1, 0) },
      uPointerSpeed: { value: 0 },
      uPointerReach: { value: DEFAULT_PARAMS.ptrReach },
      uPointerTail: { value: DEFAULT_PARAMS.ptrTail },
      uPointerAmp: { value: DEFAULT_PARAMS.ptrAmp },
    },
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 1;
  return points;
}

// ---- coral (point-cloud silhouettes on the ridges) --------------------------

function buildCoral(scale: number, density: number): THREE.Points {
  // Coral / seaweed clusters scattered along the dune sides (never the central
  // channel behind the hero copy). The number of clusters scales with density.
  const count = Math.max(0, Math.round(6 * density));
  const px: number[] = [];
  const sway: number[] = [];
  const hfac: number[] = [];

  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const ax = side * (8 + hash2(i * 1.7, 3.1) * 26); // |x| in [8, 34] — on the sides
    const az = 9 - hash2(i * 2.3, 8.7) * 48; // foreground to mid-field
    const baseY = seabedHeight(ax, az, PARAMS);
    const branches = 4 + Math.floor(hash2(ax, az) * 4);
    for (let b = 0; b < branches; b++) {
      const bAngle = hash2(ax + b, az) * Math.PI * 2;
      const bx = ax + Math.cos(bAngle) * (0.3 + hash2(b, ax) * 0.9);
      const bz = az + Math.sin(bAngle) * (0.3 + hash2(b, az) * 0.9);
      const height = (2.4 + hash2(ax * b, az) * 2.6) * scale;
      const steps = Math.round(24 * scale);
      const lean = (hash2(b, ax + az) - 0.5) * 0.7;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const jitter = (1 - t) * 0.25;
        const x = bx + lean * t + (hash2(s, b) - 0.5) * jitter;
        const z = bz + (hash2(b, s) - 0.5) * jitter;
        const y = baseY + t * height;
        px.push(x, y, z);
        sway.push(hash2(ax + b, s) * 6.283);
        hfac.push(t);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(px), 3));
  geo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(sway), 1));
  geo.setAttribute('aH', new THREE.BufferAttribute(new Float32Array(hfac), 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSize: { value: 2.1 },
      uFogNear: { value: 28 },
      uFogFar: { value: 86 },
      uColorLow: { value: new THREE.Color('#2c84b8') },
      uTheme: { value: 0 },
      uColorHigh: { value: new THREE.Color('#c4f2ff') },
    },
    vertexShader: CORAL_VERT,
    fragmentShader: CORAL_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  return points;
}

// ---- particles (rising plankton) --------------------------------------------

function buildParticles(count: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 64;
    positions[i * 3 + 1] = -5 + Math.random() * 20;
    positions[i * 3 + 2] = -44 + Math.random() * 60;
    speed[i] = 0.25 + Math.random() * 0.8;
    phase[i] = Math.random() * 6.283;
    size[i] = 0.5 + Math.random() * 1.4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uYMin: { value: -5 },
      uYRange: { value: 22 },
      uFogNear: { value: 22 },
      uFogFar: { value: 78 },
      uColor: { value: new THREE.Color('#dceeff') },
      uTheme: { value: 0 },
    },
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return points;
}

// ---- jellyfish (structured point-cloud geometry) ----------------------------

const ORAL_ARMS = 5;
const FRILL_LOBES = 11;
const FRILL_DEPTH = 0.07;

/** Bell profile: radius and height for v in [0,1] (apex -> rim). */
function bellRadius(v: number): number {
  return Math.pow(Math.sin(v * HALF_PI), 0.7) * (1 - 0.08 * smoothstep01(0.9, 1, v));
}
function bellHeight(v: number): number {
  return Math.cos(v * HALF_PI) * 0.72 - Math.max(0, v - 0.9) * 0.5;
}

function buildJellyfishGeometry(bellPoints: number, tentacles: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const part: number[] = []; // 0 bell, 1 marginal tentacle, 2 oral arm
  const param: number[] = []; // bell: v; tentacle/arm: t
  const angle: number[] = [];

  // Bell: points distributed on rings so the dots form coherent contours, with
  // a scalloped frilly margin near the rim.
  const rings = Math.max(6, Math.round(Math.sqrt(bellPoints / 2.2)));
  for (let ri = 0; ri < rings; ri++) {
    const v = ri / (rings - 1);
    const rv = bellRadius(v);
    const yv = bellHeight(v);
    const ringPts = Math.max(4, Math.round(6 + 36 * rv));
    const margin = smoothstep01(0.78, 1, v);
    for (let pi = 0; pi < ringPts; pi++) {
      const theta = (pi / ringPts) * TAU + ri * 0.55;
      const frill = 1 + FRILL_DEPTH * Math.sin(theta * FRILL_LOBES) * margin;
      const r = rv * frill;
      const y = yv + Math.cos(theta * FRILL_LOBES) * 0.03 * margin;
      pos.push(r * Math.cos(theta), y, r * Math.sin(theta));
      part.push(0);
      param.push(v);
      angle.push(theta);
    }
  }

  // Inner gut: a short faint central column under the apex.
  for (let k = 0; k < 14; k++) {
    const t = k / 14;
    const rr = 0.1 * (1 - t);
    const a = t * 9.0;
    pos.push(Math.cos(a) * rr, 0.46 - t * 0.42, Math.sin(a) * rr);
    part.push(0);
    param.push(0.25);
    angle.push(a);
  }

  // Oral arms: a few thick frilly ribbons hanging from the center.
  for (let arm = 0; arm < ORAL_ARMS; arm++) {
    const a0 = (arm / ORAL_ARMS) * TAU;
    const len = 1.5 + (hash2(arm, 3) - 0.5) * 0.4;
    const steps = 16;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const rad = 0.12 + 0.26 * Math.sin(t * HALF_PI);
      const w = 0.14 * (1 - t);
      for (let side = -1; side <= 1; side++) {
        const fr = side * w + Math.sin(t * 11 + arm) * 0.05 * (1 - t);
        const px = rad * Math.cos(a0) + fr * Math.cos(a0 + HALF_PI);
        const pz = rad * Math.sin(a0) + fr * Math.sin(a0 + HALF_PI);
        pos.push(px, 0.05 - t * len, pz);
        part.push(2);
        param.push(t);
        angle.push(a0);
      }
    }
  }

  // Marginal tentacles: many fine threads hanging from INSIDE the bell margin
  // (clearly narrower than the rim, so the bell overhangs them like a real
  // medusa), sparser toward the tip.
  for (let s = 0; s < tentacles; s++) {
    const ang = (s / tentacles) * TAU + (hash2(s, 7) - 0.5) * 0.2;
    const ringR = bellRadius(0.99) * (0.72 + hash2(s, 2) * 0.12);
    const bx = ringR * Math.cos(ang);
    const bz = ringR * Math.sin(ang);
    const len = 2.4 + hash2(s, 5) * 1.8;
    const steps = 24;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      if (t > 0.5 && hash2(s * 3.1, k) < t * 0.4) continue;
      pos.push(bx * (1 - 0.18 * t), -0.05 - t * len, bz * (1 - 0.18 * t));
      part.push(1);
      param.push(t);
      angle.push(ang);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(part), 1));
  geo.setAttribute('aParam', new THREE.BufferAttribute(new Float32Array(param), 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(new Float32Array(angle), 1));
  return geo;
}

type Jelly = {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  riseSpeed: number;
  driftAmp: number;
  driftSpeed: number;
  driftPhase: number;
  baseX: number;
  baseOpacity: number;
  yTop: number;
  yBottom: number;
};

function buildJellyfish(
  count: number,
  geo: THREE.BufferGeometry,
  /** Viewport aspect (w/h). Portrait pans the camera right; jellies must sit in that band. */
  aspect = 1.4
): Jelly[] {
  const jellies: Jelly[] = [];
  // renderFrame pans camera X via framingPanX(width) on narrow screens so the
  // framed centre is ~+8..+14. Desktop keeps panX = 0 and jellies can flank
  // both sides of the trench. (Pan is width-only — never live aspect — so
  // mobile browser chrome height thrash cannot re-frame the camera.)
  const portrait = aspect < 0.9;
  // Desktop: left/right of centre. Portrait: keep everything in the panned
  // band so at least one near/bright medusa is on-screen (was: near jelly at
  // x≈-24 sat entirely off the left edge of phone frames).
  const slots = portrait ? [11, 18, 7, 22, 14, 5] : [-24, 26, 16, -30, 22, -15];
  for (let i = 0; i < count; i++) {
    // Portrait: first ~⅔ are near/bright (the ones the eye actually reads as
    // the floating animation); the rest stay as deep accents.
    const far = portrait ? i >= Math.ceil(count * 0.65) : i % 2 === 1;
    const baseX = slots[i % slots.length] + (Math.random() - 0.5) * (portrait ? 2.2 : 4);
    // Portrait near jellies sit a bit deeper and smaller than the original
    // close-up framing: the same dot budget covers fewer screen pixels, which
    // is what makes the medusa read crisp on a phone.
    const z = far
      ? -34 - Math.random() * 14
      : portrait
        ? -11 - Math.random() * 8
        : -10 - Math.random() * 12;
    const size = (far ? 1.0 : portrait ? 1.8 : 1.7) + Math.random() * 0.45;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        // Portrait near jellies used oversized dots (2.7) to compensate for a
        // sparse bell; with the denser low-tier bell they use finer dots with
        // a tighter falloff instead, which is what actually reads as "sharp".
        uSize: { value: far ? 1.5 : 2.1 },
        uFocus: { value: portrait && !far ? 9.5 : 6.5 },
        uPhase: { value: Math.random() * 6.283 },
        uPulseSpeed: { value: far ? 0.9 : 1.15 },
        uWaveLen: { value: 2.6 },
        uOpacity: { value: 0 },
        uColorBell: { value: new THREE.Color(far ? '#9cc2ff' : '#c4e0ff') },
        uTheme: { value: 0 },
        uColorTent: { value: new THREE.Color(far ? '#5283cc' : '#82aeef') },
      },
      vertexShader: JELLY_VERT,
      fragmentShader: JELLY_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 4;
    points.scale.setScalar(size);
    const yBottom = far ? -2 : portrait ? 0 : -3;
    const yTop = far ? 13 : portrait ? 11 : 12;
    // Portrait: start mid-column so a jelly is visible immediately (not waiting
    // to rise from below the fold after a cold load).
    const y0 =
      portrait && !far ? 2 + Math.random() * 5 : yBottom + Math.random() * (yTop - yBottom);
    points.position.set(baseX, y0, z);
    jellies.push({
      points,
      material,
      riseSpeed: (far ? 0.18 : portrait ? 0.32 : 0.28) + Math.random() * 0.12,
      driftAmp: (portrait ? 0.55 : 0.8) + Math.random() * (portrait ? 0.7 : 1.2),
      driftSpeed: 0.12 + Math.random() * 0.12,
      driftPhase: Math.random() * 6.283,
      baseX,
      baseOpacity: far ? 0.5 : portrait ? 1.0 : 0.85,
      yTop,
      yBottom,
    });
  }
  return jellies;
}

// ---- shaders ----------------------------------------------------------------

const FOG_CHUNK = `
  float fogFade(float dist, float near, float far) {
    return 1.0 - smoothstep(near, far, dist);
  }
`;

const TERRAIN_VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec2 uPointer;
  uniform float uPointerT;
  uniform vec2 uPointerDir;
  uniform float uPointerSpeed;
  uniform float uPointerReach;
  uniform float uPointerTail;
  uniform float uPointerAmp;
  attribute float aHeight;
  attribute float aRnd;
  attribute float aLight;
  attribute float aRidge;
  varying float vFog;
  varying float vHeight;
  varying float vTwinkle;
  varying float vLight;
  varying float vRidge;
  varying float vCaustic;
  ${FOG_CHUNK}
  void main() {
    vec3 p = position;
    // Slow surface "breathing" — barely perceptible, like a passing current.
    float ripple = sin(p.x * 0.22 + uTime * 0.26) * cos(p.z * 0.19 - uTime * 0.2);
    p.y += ripple * 0.16;
    // Pointer disturbance shaped like a water drop: a rounded head toward the
    // travel direction and a long, tapering tail trailing behind (the wake),
    // rounding back to a circle when the cursor is slow. Points drift apart
    // across the surface (no rise).
    vec2 toPtr = p.xz - uPointer;
    float ptrDist = length(toPtr);
    float along = dot(toPtr, uPointerDir);              // + = ahead in travel dir
    float perp = length(toPtr - along * uPointerDir);
    float rAhead = mix(uPointerReach, uPointerReach * 1.25, uPointerSpeed);
    float rBack = mix(uPointerReach, uPointerTail, uPointerSpeed);   // trailing tail (wake)
    float rSide = mix(uPointerReach, uPointerReach * 0.8, uPointerSpeed);
    float axial = along > 0.0 ? along / rAhead : (-along) / rBack;
    // taper the tail's width toward its tip so it reads as a water-drop point
    float sideR = along < 0.0 ? rSide * mix(1.0, 0.38, clamp((-along) / rBack, 0.0, 1.0)) : rSide;
    float shaped = length(vec2(axial, perp / sideR));
    float pointerInfl = smoothstep(1.0, 0.0, shaped) * uPointerT;
    if (pointerInfl > 0.001) {
      vec2 dir = ptrDist > 1e-4 ? toPtr / ptrDist : vec2(1.0, 0.0);
      vec2 push = normalize(dir + uPointerDir * (0.4 * uPointerSpeed));
      p.xz += push * pointerInfl * uPointerAmp;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    vFog = fogFade(dist, uFogNear, uFogFar);
    vHeight = aHeight;
    vLight = aLight;
    vRidge = aRidge;
    vTwinkle = 0.86 + 0.14 * sin(uTime * 1.1 + aRnd * 6.283);
    // Drifting caustic field — sunlight refracted through the surface onto the
    // seabed. Sharpened into bright veins; read in the fragment shader.
    vec2 cp = position.xz * 0.5;
    float caus = sin(cp.x + uTime * 0.6) * sin(cp.y + uTime * 0.5)
               + sin(cp.x * 0.7 - cp.y * 0.9 + uTime * 0.4);
    vCaustic = pow(clamp(caus * 0.3 + 0.55, 0.0, 1.0), 2.0);
    float size = uSize * (0.7 + aHeight * 0.5 + aRidge * 0.55);
    gl_PointSize = clamp(size * uPixelRatio * (56.0 / dist), 0.5, 4.5 * uPixelRatio);
  }
`;

const TERRAIN_FRAG = `
  precision highp float;
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  uniform vec3 uRidge;
  uniform float uTheme;
  uniform float uReveal;
  varying float vFog;
  varying float vHeight;
  varying float vTwinkle;
  varying float vLight;
  varying float vRidge;
  varying float vCaustic;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = exp(-d * d * 6.5);
    vec3 col = mix(uColorLow, uColorHigh, smoothstep(0.05, 0.95, vHeight));
    col = mix(col, uRidge, vRidge * 0.85);         // whiten crests
    col *= (0.26 + 1.15 * vLight);                 // slope shading (high contrast)
    // Faint topographic contour bands for a sonar-scan read.
    float band = abs(fract(vHeight * 13.0) - 0.5);
    col += uRidge * smoothstep(0.46, 0.5, band) * 0.1;
    float alpha = a * vFog * (0.38 + 0.55 * vHeight) * vTwinkle * (0.5 + 0.72 * vLight);
    // Light mode (normal-blended over white): grayed blue with a real front->back
    // color shift like the dark theme — lighter/airier up close, deeper blue into
    // the distance. Keep alpha alive far away so the distant blue still reads
    // instead of fog-washing to white.
    // Far -> medium blue that dissolves into the pale bg; near -> deep rich blue
    // with presence. Wide alpha range (airy far, solid near) makes the depth read.
    vec3 blue = mix(vec3(0.09, 0.23, 0.52), vec3(0.012, 0.07, 0.32), vFog);
    blue = mix(blue, vec3(0.14, 0.36, 0.74), vRidge * 0.5);   // crest catch-light
    blue *= (0.8 + 0.34 * vLight);
    // Sunlight dappling: drifting caustic veins lift dots toward a luminous cyan
    // and add sparkle, like sun refracting onto the seabed.
    blue = mix(blue, vec3(0.42, 0.78, 0.96), vCaustic * 0.55);
    float alphaL = a * (0.25 + 0.75 * vFog) * (0.5 + 0.5 * vHeight) * vTwinkle * (1.0 + 0.5 * vCaustic);
    col = mix(col, blue, uTheme);
    alpha = mix(alpha, alphaL, uTheme);
    // Fade-in ramp for the worker-built terrain arriving after first paint.
    alpha *= uReveal;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

const CORAL_VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uFogNear;
  uniform float uFogFar;
  attribute float aSway;
  attribute float aH;
  varying float vFog;
  varying float vH;
  ${FOG_CHUNK}
  void main() {
    vec3 p = position;
    float sway = sin(uTime * 0.7 + aSway) * 0.22 * aH * aH;
    p.x += sway;
    p.z += cos(uTime * 0.6 + aSway) * 0.14 * aH * aH;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    vFog = fogFade(dist, uFogNear, uFogFar);
    vH = aH;
    gl_PointSize = clamp(uSize * uPixelRatio * (48.0 / dist), 0.5, 4.0 * uPixelRatio);
  }
`;

const CORAL_FRAG = `
  precision highp float;
  uniform vec3 uColorLow;
  uniform vec3 uColorHigh;
  uniform float uTheme;
  varying float vFog;
  varying float vH;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = exp(-d * d * 6.0);
    vec3 col = mix(uColorLow, uColorHigh, smoothstep(0.0, 1.0, vH));
    // Light mode: brighter rich blue up close -> lighter into the distance.
    vec3 blue = mix(vec3(0.12, 0.27, 0.58), vec3(0.016, 0.085, 0.37), vFog);
    col = mix(col, blue, uTheme);
    float alpha = a * vFog * (0.5 + 0.45 * vH);
    float alphaL = a * (0.3 + 0.7 * vFog) * (0.5 + 0.45 * vH);
    alpha = mix(alpha, alphaL, uTheme);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

const PARTICLE_VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uYMin;
  uniform float uYRange;
  uniform float uFogNear;
  uniform float uFogFar;
  attribute float aSpeed;
  attribute float aPhase;
  attribute float aSize;
  varying float vFog;
  varying float vTw;
  ${FOG_CHUNK}
  void main() {
    vec3 p = position;
    float y = p.y + uTime * aSpeed;
    y = mod(y - uYMin, uYRange) + uYMin;
    p.y = y;
    p.x += sin(uTime * 0.3 + aPhase) * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    vFog = fogFade(dist, uFogNear, uFogFar);
    vTw = 0.6 + 0.4 * sin(uTime * 1.7 + aPhase);
    gl_PointSize = clamp(aSize * uPixelRatio * (36.0 / dist), 0.5, 3.0 * uPixelRatio);
  }
`;

const PARTICLE_FRAG = `
  precision highp float;
  uniform vec3 uColor;
  uniform float uTheme;
  varying float vFog;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = exp(-d * d * 5.5);
    float alpha = a * vFog * 0.5 * vTw;
    float alphaL = a * (0.3 + 0.7 * vFog) * 0.5 * vTw;
    alpha = mix(alpha, alphaL, uTheme);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(mix(uColor, mix(vec3(0.18, 0.38, 0.70), vec3(0.05, 0.16, 0.46), vFog), uTheme), alpha);
  }
`;

const JELLY_VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform float uPhase;
  uniform float uPulseSpeed;
  uniform float uWaveLen;
  attribute float aPart;
  attribute float aParam;
  attribute float aAngle;
  varying float vGlow;
  varying float vPart;
  void main() {
    vec3 p = position;
    // A contraction pulse travels from the apex down to the rim and on into the
    // arms/tentacles, which therefore trail the bell.
    float along = (aPart < 0.5) ? aParam : 1.0 + aParam;
    float c = sin(uTime * uPulseSpeed - along * uWaveLen + uPhase);

    if (aPart < 0.5) {
      float k = smoothstep(0.1, 1.0, aParam); // rim flexes most
      p.xz *= 1.0 - 0.16 * c * k;             // squeeze
      p.y += 0.14 * c * k * aParam;           // elongate when contracted
      vGlow = mix(0.45, 1.0, aParam) + smoothstep(0.85, 1.0, aParam) * 0.3;
    } else if (aPart < 1.5) {
      // The base is fused to the bell rim (same pulse phase at along = 1), so it
      // must contract WITH the rim; the effect tapers toward the free, swaying
      // tip. This keeps the tentacle-to-bell junction attached as the bell
      // closes instead of leaving a gap.
      float attach = 1.0 - aParam; // 1 at the rim, 0 at the tip
      p.xz *= 1.0 - 0.16 * c * (0.4 + 0.6 * attach);
      p.y += 0.14 * c * (0.4 + 0.6 * attach);
      float sway = sin(uTime * 1.3 + aParam * 5.0 + aAngle * 1.4 + uPhase);
      p.x += sway * 0.22 * aParam;
      p.z += cos(uTime * 1.15 + aParam * 4.0 + aAngle) * 0.18 * aParam;
      vGlow = (1.0 - aParam) * 0.7;
    } else {
      float sway = sin(uTime * 1.0 + aParam * 6.0 + aAngle * 2.0 + uPhase);
      p.x += sway * 0.14 * aParam;
      p.z += cos(uTime * 0.9 + aParam * 5.0 + aAngle) * 0.12 * aParam;
      p.y += 0.05 * c * aParam;
      vGlow = (1.0 - aParam) * 0.5 + 0.25;
    }

    vPart = aPart;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    gl_PointSize = clamp(uSize * uPixelRatio * (42.0 / dist), 0.5, 5.0 * uPixelRatio);
  }
`;

const JELLY_FRAG = `
  precision highp float;
  uniform vec3 uColorBell;
  uniform vec3 uColorTent;
  uniform float uOpacity;
  uniform float uTheme;
  uniform float uFocus;
  varying float vGlow;
  varying float vPart;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    // uFocus sharpens the sprite edge for close-framed (portrait) jellies.
    float a = exp(-d * d * uFocus);
    vec3 col = vPart < 0.5 ? uColorBell : uColorTent;
    col += vGlow * 0.35;
    // Light mode: a soft, muted violet so the jellyfish reads as distinct from
    // the blue seabed without drawing the eye — quiet, not a vivid pop.
    vec3 jelly = (vPart < 0.5 ? vec3(0.22, 0.16, 0.42) : vec3(0.12, 0.08, 0.26)) + vGlow * vec3(0.16, 0.13, 0.22);
    col = mix(col, jelly, uTheme);
    float alpha = a * uOpacity * (0.3 + 0.7 * vGlow) * mix(1.0, 1.6, uTheme);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

// ---- background gradient ----------------------------------------------------

// A fullscreen shader backdrop: a vertical gradient where uTheme blends a deep
// abyss (0) and a sunlit shallow (1). Colors are authored in sRGB and output
// linear (pow 2.2) so they match the linear point-cloud colors.
const BG_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BG_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTheme;

  void main() {
    float y = vUv.y; // 1 = surface (top), 0 = seabed (bottom)

    vec3 dTop = vec3(0.020, 0.075, 0.141);
    vec3 dMid = vec3(0.043, 0.149, 0.251);
    vec3 dBot = vec3(0.016, 0.051, 0.114);
    vec3 dark = y > 0.5 ? mix(dMid, dTop, (y - 0.5) * 2.0) : mix(dBot, dMid, y * 2.0);

    // Light = luminous pale: only a small white cap at the very top; a gentle
    // pale "water" blue fills the rest and deepens slightly toward the seabed.
    // The gradient starts white exactly at the top edge and immediately eases
    // down into the pale "water" blue — no solid white block. Blue already fills
    // the lower half, so white stays a small fade at the very top.
    vec3 lWhite = vec3(0.992, 0.996, 1.0);
    vec3 lBlue  = vec3(0.77, 0.857, 0.957);
    vec3 light = mix(lBlue, lWhite, smoothstep(0.12, 1.0, y));

    vec3 col = mix(dark, light, uTheme);

    gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);
  }
`;

type Background = { mesh: THREE.Mesh; material: THREE.ShaderMaterial };

function buildBackground(): Background {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTheme: { value: 0 },
    },
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, material };
}

// ---- quality resolution -----------------------------------------------------

function detectQuality(): Quality {
  if (typeof window === 'undefined') return 'high';
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const narrow = window.innerWidth < 768;
  const lowMem =
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number' &&
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory! <= 4;
  // Touch devices (phones — often weaker GPUs + tight memory, where losing the
  // GL context under load is common) get the lightest tier; a small non-touch
  // window only steps to medium.
  if (coarse) return 'low';
  if (narrow) return lowMem ? 'low' : 'medium';
  if (lowMem) return 'medium';
  return 'high';
}

function supportsWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    );
  } catch {
    return false;
  }
}

// ---- tuner panel ------------------------------------------------------------

type SceneApi = {
  applyCheap: () => void;
  scheduleRebuild: () => void;
};

type SliderDef = { key: keyof TuneParams; label: string; min: number; max: number; step: number };

const TUNER_GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: '地形形状',
    sliders: [
      { key: 'wallAmp', label: '侧壁高度', min: 0, max: 3, step: 0.01 },
      { key: 'wallRoundness', label: '峰顶弧度', min: 0.3, max: 2.5, step: 0.01 },
      { key: 'ridgeRound', label: '脊线圆润', min: 0, max: 1, step: 0.01 },
      { key: 'channelWidth', label: '峡谷宽度', min: 1, max: 12, step: 0.1 },
      { key: 'channelOpen', label: '峡谷张开', min: 0, max: 1.2, step: 0.01 },
      { key: 'heightVar', label: '高度多样性', min: 0, max: 1, step: 0.01 },
      { key: 'slopeVar', label: '坡度多样性', min: 0, max: 1, step: 0.01 },
      { key: 'trenchDepth', label: '中央沟深', min: 0, max: 1.5, step: 0.01 },
      { key: 'heightScale', label: '整体起伏', min: 1, max: 6, step: 0.05 },
      { key: 'baseY', label: '整体下沉', min: -6, max: 0, step: 0.05 },
      { key: 'hillsWeight', label: '丘陵权重', min: 0, max: 1.2, step: 0.01 },
      { key: 'crestsWeight', label: '脊线权重', min: 0, max: 1.2, step: 0.01 },
      { key: 'density', label: '点密度', min: 0.3, max: 2.5, step: 0.05 },
      { key: 'coralDensity', label: '珊瑚水草', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    title: '光影',
    sliders: [
      { key: 'lightDiffuse', label: '受光强度', min: 0, max: 2, step: 0.01 },
      { key: 'lightAO', label: '谷底阴影', min: 0, max: 1.2, step: 0.01 },
      { key: 'lightAmbient', label: '环境光底', min: 0, max: 1, step: 0.01 },
      { key: 'pointSize', label: '点大小', min: 0.5, max: 4, step: 0.01 },
    ],
  },
  {
    title: '场景',
    sliders: [
      { key: 'cameraHeight', label: '相机高度', min: 2, max: 12, step: 0.1 },
      { key: 'cameraPitch', label: '相机俯仰', min: -6, max: 2, step: 0.1 },
    ],
  },
  {
    title: '指针水滴',
    sliders: [
      { key: 'ptrReach', label: '影响范围', min: 3, max: 16, step: 0.1 },
      { key: 'ptrTail', label: '尾巴长度', min: 4, max: 30, step: 0.5 },
      { key: 'ptrAmp', label: '散开幅度', min: 0, max: 3, step: 0.05 },
      { key: 'ptrDiffuse', label: '扩散速度', min: 0.3, max: 5, step: 0.05 },
      { key: 'ptrRecover', label: '复原速度', min: 0.2, max: 5, step: 0.05 },
      { key: 'ptrFollow', label: '跟随速度', min: 1, max: 10, step: 0.1 },
    ],
  },
];

function UnderwaterTuner({
  cfg,
  onChange,
  onReset,
}: {
  cfg: TuneParams;
  onChange: (next: TuneParams) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  const copyConfig = () => {
    void navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="uw-tuner">
      <button
        className="uw-tuner__toggle"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="背景调参"
      >
        {open ? '×' : '⚙'}
      </button>
      {open && (
        <div className="uw-tuner__panel">
          <div className="uw-tuner__head">
            <strong>背景调参</strong>
            <span className="uw-tuner__actions">
              <button type="button" onClick={copyConfig}>
                {copied ? '已复制' : '复制配置'}
              </button>
              <button type="button" onClick={onReset}>
                重置
              </button>
            </span>
          </div>
          {TUNER_GROUPS.map((group) => (
            <div className="uw-tuner__group" key={group.title}>
              <div className="uw-tuner__group-title">{group.title}</div>
              {group.sliders.map((s) => (
                <label className="uw-tuner__row" key={s.key}>
                  <span>{s.label}</span>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={cfg[s.key]}
                    onChange={(e) => onChange({ ...cfg, [s.key]: Number(e.target.value) })}
                  />
                  <em>{cfg[s.key].toFixed(2)}</em>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- component --------------------------------------------------------------

export function UnderwaterPointCloudBackground({
  quality,
  animated = true,
  jellyfishCount,
  particleCount,
  terrainDensity,
  className,
  diveRef,
}: UnderwaterPointCloudBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [reinitKey, setReinitKey] = useState(0);
  const apiRef = useRef<SceneApi | null>(null);
  // Throttle/cap context-loss-driven rebuilds. On mobile WebKit the GL context
  // can be lost repeatedly under memory pressure; without this guard each loss
  // would synchronously rebuild the whole scene and re-lose, saturating the main
  // thread (frozen canvas + dead taps).
  const ctxLostGuard = useRef({ last: 0, count: 0 });
  const [cfg, setCfg] = useState<TuneParams>(() => ({ ...DEFAULT_PARAMS }));
  const [showTuner, setShowTuner] = useState(false);
  const firstCfgApply = useRef(true);

  // Reveal the tuner only when the URL carries ?tune (kept out of normal visits).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShowTuner(/(?:[?&#])tune\b/.test(window.location.search + window.location.hash));
  }, []);

  // This is a static-export page; navigating away via an <a> link parks it in
  // the browser's bfcache. On Back the page is restored WITHOUT re-running
  // effects and with a dropped WebGL context, so the canvas comes back blank.
  // pageshow{persisted} signals a bfcache restore — bump reinitKey to remount
  // the canvas (fresh GL context) and re-run the scene effect.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setReinitKey((k) => k + 1);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    if (!supportsWebGL()) {
      setWebglFailed(true);
      return undefined;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resolved = quality ?? detectQuality();
    const TIER_ORDER: Quality[] = ['high', 'medium', 'low'];
    // The active tier can step DOWN at runtime when the FPS watchdog finds the
    // device can't keep up; it never steps back up (avoids oscillation). These
    // are `let` so a downgrade can rebuild with fewer points + a lower DPR.
    let tierIndex = Math.max(0, TIER_ORDER.indexOf(resolved));
    let activePreset = PRESETS[TIER_ORDER[tierIndex]];
    let numParticles = particleCount ?? activePreset.particles;
    let numJellies = jellyfishCount ?? activePreset.jellyfish;
    let coralScale = TIER_ORDER[tierIndex] === 'low' ? 0.85 : 1;
    let pixelRatio = Math.min(window.devicePixelRatio || 1, activePreset.dpr);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        // A 2x drawing buffer already supersamples the soft point sprites; 4x MSAA
        // on top multiplies every blended sample and the resolve for no visible
        // edge. The browser's default adapter keeps dual-GPU laptops off the
        // discrete GPU for a background; the FPS watchdog covers slow ones.
        antialias: activePreset.antialias && pixelRatio < 2,
        alpha: false,
      });
    } catch {
      setWebglFailed(true);
      return undefined;
    }

    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x050f24, 1);

    // A CPU rasteriser (no usable GPU) pegs every core at any tier, so it gets
    // the single still frame that reduced motion gets.
    const gl = renderer.getContext();
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const softwareRenderer = rendererInfo
      ? /swiftshader|llvmpipe|software/i.test(
          String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
        )
      : false;
    const isStatic = reduceMotion || !animated || softwareRenderer;

    // If the GL context is dropped (GPU reset, or a bfcache restore on browsers
    // that fire this instead of just blanking), preventDefault keeps the canvas
    // restorable. Halt the now-broken loop, then attempt ONE throttled rebuild;
    // after repeated losses give up to the (scene-matched) CSS fallback rather
    // than spin in a lose/rebuild loop that would freeze the page.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      const now = performance.now();
      const g = ctxLostGuard.current;
      if (now - g.last < 1500) return;
      g.last = now;
      g.count += 1;
      if (g.count > 4) {
        setWebglFailed(true);
        return;
      }
      setReinitKey((k) => k + 1);
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    const scene = new THREE.Scene();
    const background = buildBackground();
    scene.add(background.mesh);

    // Theme mix: 0 = dark abyss, 1 = sunlit shallow. Eased toward the target so a
    // toggle cross-fades the whole scene instead of hard-switching.
    const readThemeTarget = () => (document.documentElement.classList.contains('dark') ? 0 : 1);
    let themeTarget = readThemeTarget();
    let themeMix = themeTarget;
    background.material.uniforms.uTheme.value = themeMix;

    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 220);
    camera.position.set(0, PARAMS.cameraHeight, 21);
    const lookTarget = new THREE.Vector3();

    // ---- rebuildable content (driven by PARAMS) ----------------------------
    // The terrain is null until its attributes arrive: the initial build runs in
    // a Web Worker (the ~2×N-octave noise field is the dominant cold-start cost)
    // while the cheap layers render immediately. Tune/downgrade rebuilds stay
    // synchronous as before.
    let terrain: THREE.Points | null = null;
    let coral!: THREE.Points;
    let particles!: THREE.Points;
    let jellyGeo!: THREE.BufferGeometry;
    let jellies: Jelly[] = [];
    let timed: THREE.ShaderMaterial[] = [];
    let disposed = false;
    // Bumped whenever the current content generation is replaced/disposed so an
    // in-flight worker result for a stale build is dropped instead of adopted.
    let terrainGen = 0;
    let terrainWorker: Worker | null = null;
    // First-render gate: nothing renders until the initial shader programs have
    // compiled asynchronously (KHR_parallel_shader_compile), so first paint
    // never blocks the main thread on sync compilation.
    let ready = false;
    // Desired run state from the visibility/intersection handlers, so a start()
    // requested before `ready` is honored once compilation finishes.
    let wantRun = !isStatic;

    // Animation clock — declared before buildContent so rebuilds keep continuity.
    let rafId = 0;
    let running = false;
    let lastTime = 0;
    let elapsed = 0;
    const camDist = new THREE.Vector3();
    // Eased mirror of diveRef.current (0..1). Lerped in tick so scroll scrubbing
    // reads as a smooth forward push instead of snapping per scroll event.
    let camDive = 0;

    // Frame-rate cap: the scene breathes slowly, so rendering every display
    // refresh (120Hz especially) wastes GPU/battery. A time accumulator caps
    // rendering near FPS_CAP regardless of the refresh rate.
    const FPS_CAP = 40;
    const minFrameMs = 1000 / FPS_CAP;
    let lastRaf = 0;
    let frameAcc = 0;
    // FPS watchdog: counts rendered frames in a rolling window and steps the
    // quality tier down if the device can't sustain the cap.
    let warmupUntil = 0;
    let perfStart = 0;
    let perfFrames = 0;

    // Additive in dark (the glow), normal in light (so points can be a real,
    // contrasting color instead of only ever brightening the sky-blue water).
    const applyBlending = () => {
      const mode = themeTarget > 0.5 ? THREE.NormalBlending : THREE.AdditiveBlending;
      for (const m of timed) {
        if (m.blending !== mode) {
          m.blending = mode;
          m.needsUpdate = true;
        }
      }
    };

    // Attach a finished terrain to the current build (uniforms, timed list,
    // blending) and paint it if the loop isn't running.
    const adoptTerrain = (points: THREE.Points) => {
      terrain = points;
      const m = points.material as THREE.ShaderMaterial;
      m.uniforms.uPixelRatio.value = pixelRatio;
      m.uniforms.uTime.value = elapsed;
      m.uniforms.uTheme.value = themeMix;
      timed.push(m);
      applyBlending();
      scene.add(points);
      // Keep the adoption hitch (geometry upload + first draw) out of the FPS
      // watchdog's measurement window, like any other (re)build.
      warmupUntil = 0;
      perfStart = 0;
      perfFrames = 0;
      if (isStatic) {
        m.uniforms.uReveal.value = 1;
        renderStatic();
      } else if (!running) {
        m.uniforms.uReveal.value = 1;
        renderFrame();
      }
      // While running, tick ramps uReveal 0 → 1 so the seabed fades in.
    };

    // Compute the terrain attributes in a worker and adopt the result; falls
    // back to the synchronous path when workers are unavailable or error out.
    const spawnTerrainAsync = (terrainPoints: number) => {
      const gen = terrainGen;
      const buildSync = () =>
        adoptTerrain(buildTerrain(computeTerrainAttributes(terrainPoints, PARAMS), 1));
      let created: Worker | null = null;
      try {
        created = new Worker(new URL('./underwater-terrain.worker.ts', import.meta.url), {
          type: 'module',
        });
      } catch {
        created = null;
      }
      if (!created) {
        buildSync();
        return;
      }
      const worker = created;
      terrainWorker = worker;
      const settle = () => {
        worker.terminate();
        if (terrainWorker === worker) terrainWorker = null;
      };
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        settle();
        if (disposed || gen !== terrainGen) return;
        const points = buildTerrain(event.data, 0);
        // Pre-compile the terrain program off the visible frames, then fade in.
        void renderer
          .compileAsync(points, camera, scene)
          .catch(() => {})
          .then(() => {
            if (disposed || gen !== terrainGen) {
              points.geometry.dispose();
              (points.material as THREE.Material).dispose();
              return;
            }
            adoptTerrain(points);
          });
      };
      worker.onerror = () => {
        settle();
        if (disposed || gen !== terrainGen) return;
        buildSync();
      };
      const request: TerrainWorkerRequest = {
        gen,
        pointBudget: terrainPoints,
        params: { ...PARAMS },
      };
      worker.postMessage(request);
    };

    const buildContent = (deferTerrain = false) => {
      const terrainPoints = Math.round(
        activePreset.terrainPoints * (terrainDensity ?? 1) * PARAMS.density
      );
      if (deferTerrain) {
        terrain = null;
        spawnTerrainAsync(terrainPoints);
      } else {
        terrain = buildTerrain(computeTerrainAttributes(terrainPoints, PARAMS), 1);
      }
      coral = buildCoral(coralScale, PARAMS.coralDensity);
      particles = buildParticles(numParticles);
      jellyGeo = buildJellyfishGeometry(activePreset.jellyBellPoints, activePreset.jellyTentacles);
      // Use live aspect so portrait phones place jellies inside the panned
      // camera band (see buildJellyfish). Fall back to a landscape-ish value
      // before the first setSize if the container is still 0×0.
      const aw = container.clientWidth || window.innerWidth;
      const ah = container.clientHeight || window.innerHeight;
      jellies = buildJellyfish(numJellies, jellyGeo, aw / Math.max(1, ah));
      scene.add(coral, particles);
      if (terrain) scene.add(terrain);
      for (const j of jellies) scene.add(j.points);
      timed = [
        ...(terrain ? [terrain.material as THREE.ShaderMaterial] : []),
        coral.material as THREE.ShaderMaterial,
        particles.material as THREE.ShaderMaterial,
        ...jellies.map((j) => j.material),
      ];
      for (const m of timed) {
        m.uniforms.uPixelRatio.value = pixelRatio;
        m.uniforms.uTime.value = elapsed;
      }
      // Blending depends only on the theme (additive glow in dark, normal in
      // light) and so changes at most on a theme toggle — set it once per build
      // here and in onThemeChange, never every animation frame.
      applyBlending();
    };

    const disposeContent = () => {
      terrainGen++; // drop any in-flight worker terrain for this build
      if (terrain) {
        scene.remove(terrain);
        terrain.geometry.dispose();
        (terrain.material as THREE.Material).dispose();
        terrain = null;
      }
      scene.remove(coral, particles);
      for (const j of jellies) {
        scene.remove(j.points);
        j.material.dispose();
      }
      coral.geometry.dispose();
      (coral.material as THREE.Material).dispose();
      particles.geometry.dispose();
      (particles.material as THREE.Material).dispose();
      jellyGeo.dispose();
    };

    // ---- pointer parallax + point-cloud repulsion (skipped for reduced-motion
    // / touch) ---------------------------------------------------------------
    const allowPointer = !isStatic && !window.matchMedia('(pointer: coarse)').matches;
    // Raycast the cursor onto an approximate seabed plane to get the world XZ
    // under it; the terrain shader spreads nearby points into a water-drop wake
    // that trails the cursor and settles once it stops.
    const raycaster = new THREE.Raycaster();
    const seabedPlane = new THREE.Plane();
    seabedPlane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -3.5, 0)
    );
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const pointerRaw = new THREE.Vector2(1e6, 1e6);
    const pointerWorld = new THREE.Vector2(1e6, 1e6);
    let lastPointerMove = -1e6;
    let pointerT = 0;
    let dirX = 1;
    let dirZ = 0;
    let aniso = 0;
    const onPointerMove = (e: PointerEvent) => {
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(seabedPlane, hitPoint)) {
        pointerRaw.set(hitPoint.x, hitPoint.z);
      }
      lastPointerMove = performance.now();
    };
    if (allowPointer) window.addEventListener('pointermove', onPointerMove, { passive: true });

    const renderFrame = () => {
      // Nothing paints before the async shader compile finishes — an early
      // render (e.g. the ResizeObserver's immediate call) would compile the
      // programs synchronously on the main thread, which is what we're avoiding.
      if (!ready) return;
      // Narrow viewports pan right so the framed centre leaves the empty trench
      // for right-side terrain/creatures. Width-only (see framingPanX) — never
      // re-derive from live aspect, or Safari chrome height thrash "switches"
      // the lens mid-scroll.
      const panX = framingPanX(container.clientWidth || window.innerWidth);
      // Optional dive (landing keeps diveRef at 0): forward flight down the
      // trench. Smoothstep eases the push when a non-zero target is set.
      const d = camDive;
      const ease = d * d * (3 - 2 * d);
      camera.position.x = panX;
      camera.position.y = PARAMS.cameraHeight + ease * 1.8;
      camera.position.z = 21 - ease * 44;
      lookTarget.set(panX, PARAMS.cameraPitch - ease * 1.0, -34 - ease * 12);
      camera.lookAt(lookTarget);
      renderer.render(scene, camera);
    };

    const tick = (now: number) => {
      if (!running) return;
      rafId = requestAnimationFrame(tick);

      // Frame-rate cap (skip this refresh if we rendered recently enough).
      const frameMs = lastRaf ? now - lastRaf : minFrameMs;
      lastRaf = now;
      frameAcc += frameMs;
      if (frameAcc < minFrameMs) return;
      frameAcc = Math.min(frameAcc - minFrameMs, minFrameMs);

      // Adaptive downgrade if the device can't sustain the capped rate.
      maybeDowngrade(now);

      const dt = Math.min(0.05, lastTime ? (now - lastTime) / 1000 : 0.016);
      lastTime = now;
      elapsed += dt;

      // Ease the camera toward the scroll "dive" target (read live from the ref
      // so scroll never re-runs this effect).
      const diveTarget = diveRef ? Math.min(1, Math.max(0, diveRef.current)) : 0;
      camDive += (diveTarget - camDive) * Math.min(1, dt * 3.2);

      themeMix += (themeTarget - themeMix) * Math.min(1, dt * 3.5);
      background.material.uniforms.uTheme.value = themeMix;
      for (const m of timed) {
        m.uniforms.uTime.value = elapsed;
        m.uniforms.uTheme.value = themeMix;
      }

      // Ease the disturbance CENTRE toward the cursor (soft trail — follows the
      // pointer without snapping). The first sample jumps in so it doesn't sweep
      // from the far sentinel.
      if (pointerWorld.x > 1e5) {
        pointerWorld.copy(pointerRaw);
      } else {
        const follow = Math.min(1, dt * PARAMS.ptrFollow);
        pointerWorld.x += (pointerRaw.x - pointerWorld.x) * follow;
        pointerWorld.y += (pointerRaw.y - pointerWorld.y) * follow;
      }
      // The gap between the trailing centre and the live cursor gives the travel
      // direction + how far ahead the cursor is — this drives the water-drop
      // shape (elongated forward, round when the cursor is slow/still).
      if (pointerRaw.x < 1e5) {
        const gapX = pointerRaw.x - pointerWorld.x;
        const gapZ = pointerRaw.y - pointerWorld.y;
        const gap = Math.hypot(gapX, gapZ);
        if (gap > 0.05) {
          dirX = gapX / gap;
          dirZ = gapZ / gap;
        }
        aniso += (THREE.MathUtils.clamp(gap / 4.5, 0, 1) - aniso) * Math.min(1, dt * 2.5);
      }
      // Strength ramps UP (diffuse) and DOWN (recover) at separate speeds — a
      // slower recover makes the points take their time returning to rest. These
      // and the shape uniforms below are live-tunable via the ?tune panel.
      const ptrTarget = now - lastPointerMove < 400 ? 1 : 0;
      const ptrRamp = ptrTarget > pointerT ? PARAMS.ptrDiffuse : PARAMS.ptrRecover;
      pointerT += (ptrTarget - pointerT) * Math.min(1, dt * ptrRamp);
      if (terrain) {
        const terrainMat = terrain.material as THREE.ShaderMaterial;
        terrainMat.uniforms.uPointer.value.copy(pointerWorld);
        terrainMat.uniforms.uPointerT.value = pointerT;
        terrainMat.uniforms.uPointerDir.value.set(dirX, dirZ);
        terrainMat.uniforms.uPointerSpeed.value = aniso;
        terrainMat.uniforms.uPointerReach.value = PARAMS.ptrReach;
        terrainMat.uniforms.uPointerTail.value = PARAMS.ptrTail;
        terrainMat.uniforms.uPointerAmp.value = PARAMS.ptrAmp;
        // Fade the worker-built seabed in once it arrives mid-run.
        const reveal = terrainMat.uniforms.uReveal;
        if (reveal.value < 1) reveal.value = Math.min(1, reveal.value + dt * 1.25);
      }

      for (const j of jellies) {
        const p = j.points.position;
        p.y += j.riseSpeed * dt;
        if (p.y > j.yTop) {
          p.y = j.yBottom;
        }
        p.x = j.baseX + Math.sin(elapsed * j.driftSpeed + j.driftPhase) * j.driftAmp;
        // Distance + spawn/despawn fade so wrapping is never visible.
        camDist.copy(camera.position).sub(p);
        const dist = camDist.length();
        const distFade = 1 - THREE.MathUtils.smoothstep(dist, 34, 70);
        const lifeFade =
          THREE.MathUtils.smoothstep(p.y, j.yBottom, j.yBottom + 2.5) *
          (1 - THREE.MathUtils.smoothstep(p.y, j.yTop - 2.5, j.yTop));
        const breathe = 0.85 + 0.15 * Math.sin(elapsed * 1.05 + j.material.uniforms.uPhase.value);
        j.material.uniforms.uOpacity.value = j.baseOpacity * distFade * lifeFade * breathe;
      }

      renderFrame();
    };

    const start = () => {
      wantRun = true;
      if (running || isStatic || !ready) return;
      running = true;
      lastTime = 0;
      // Reset the cap + watchdog so a resume hitch isn't measured.
      lastRaf = 0;
      frameAcc = 0;
      warmupUntil = 0;
      perfStart = 0;
      perfFrames = 0;
      rafId = requestAnimationFrame(tick);
    };
    const stop = () => {
      wantRun = false;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    // Static render path (reduced motion or animated=false): one frame, set
    // jellyfish to a sensible static opacity.
    const renderStatic = () => {
      themeMix = themeTarget;
      background.material.uniforms.uTheme.value = themeMix;
      for (const m of timed) {
        m.uniforms.uTime.value = 0;
        m.uniforms.uTheme.value = themeMix;
      }
      for (const j of jellies) {
        camDist.copy(camera.position).sub(j.points.position);
        const distFade = 1 - THREE.MathUtils.smoothstep(camDist.length(), 34, 70);
        j.material.uniforms.uOpacity.value = j.baseOpacity * distFade;
      }
      renderFrame();
    };

    // Drawing-buffer size lock: mobile browser chrome toggles height during
    // scroll. Reallocating the buffer every tick is janky and (with aspect-based
    // pan historically) re-framed the camera. Keep the larger height once width
    // is fixed; re-baseline only on width change (rotate / split) or a large
    // height drop. CSS `100lvh` on `.underwater-bg` is the primary stabilizer.
    let lockW = -1;
    let lockH = 0;
    const setSize = () => {
      const w = Math.max(1, container.clientWidth || window.innerWidth);
      const h = Math.max(1, container.clientHeight || window.innerHeight);
      if (w !== lockW) {
        lockW = w;
        lockH = h;
      } else if (h > lockH) {
        lockH = h;
      } else if (h < lockH * 0.75) {
        lockH = h;
      }
      const useH = Math.max(1, lockH || h);
      renderer.setSize(w, useH, false);
      camera.aspect = w / useH;
      camera.updateProjectionMatrix();
    };

    // ---- live-tuning api ----------------------------------------------------
    const rebuildContent = () => {
      disposeContent();
      buildContent();
      if (isStatic || !running) renderFrame();
    };

    // Extra steps below the lowest tier: give up sharpness (render DPR) in
    // stages instead of staying stuck under the FPS floor. Cheap — no rebuild.
    const DPR_FLOOR_STEPS = [2, 1.4];
    let dprFloorIdx = 0;

    // Step the quality tier down one level: fewer points + a lower DPR, rebuilt
    // in place. One-way; stops at the lowest tier (+ the DPR floor).
    const downgrade = () => {
      if (tierIndex >= TIER_ORDER.length - 1) {
        while (dprFloorIdx < DPR_FLOOR_STEPS.length) {
          const next = Math.min(window.devicePixelRatio || 1, DPR_FLOOR_STEPS[dprFloorIdx++]);
          if (next < pixelRatio - 0.05) {
            pixelRatio = next;
            renderer.setPixelRatio(pixelRatio);
            setSize();
            for (const m of timed) m.uniforms.uPixelRatio.value = pixelRatio;
            return;
          }
        }
        return;
      }
      tierIndex++;
      const q = TIER_ORDER[tierIndex];
      activePreset = PRESETS[q];
      numParticles = particleCount ?? activePreset.particles;
      numJellies = jellyfishCount ?? activePreset.jellyfish;
      coralScale = q === 'low' ? 0.85 : 1;
      pixelRatio = Math.min(window.devicePixelRatio || 1, activePreset.dpr);
      renderer.setPixelRatio(pixelRatio);
      setSize();
      rebuildContent();
    };

    // Measure the achieved frame rate over a rolling window; if it stays well
    // under the cap the device is struggling, so drop a tier. A warm-up window
    // after each (re)build keeps the build hitch out of the measurement, and it
    // no-ops once already at the lowest tier.
    const maybeDowngrade = (now: number) => {
      if (tierIndex >= TIER_ORDER.length - 1 && dprFloorIdx >= DPR_FLOOR_STEPS.length) return;
      if (warmupUntil === 0) {
        warmupUntil = now + 1000;
        return;
      }
      if (now < warmupUntil) return;
      if (perfStart === 0) {
        perfStart = now;
        perfFrames = 1;
        return;
      }
      perfFrames++;
      const win = now - perfStart;
      if (win < 1300) return;
      const fps = (perfFrames * 1000) / win;
      if (fps < 33) {
        downgrade();
        warmupUntil = 0;
        perfStart = 0;
        perfFrames = 0;
      } else {
        perfStart = now;
        perfFrames = 0;
      }
    };

    let structSig = JSON.stringify(STRUCTURAL_KEYS.map((k) => PARAMS[k]));
    let rebuildTimer = 0;

    const applyCheap = () => {
      if (terrain)
        (terrain.material as THREE.ShaderMaterial).uniforms.uSize.value = PARAMS.pointSize;
      if (isStatic || !running) renderFrame();
    };

    const scheduleRebuild = () => {
      const sig = JSON.stringify(STRUCTURAL_KEYS.map((k) => PARAMS[k]));
      if (sig === structSig) return;
      structSig = sig;
      if (rebuildTimer) window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(rebuildContent, 70);
    };

    apiRef.current = { applyCheap, scheduleRebuild };

    // ---- boot ---------------------------------------------------------------
    // Terrain generation is deferred to the worker; the cheap layers (gradient,
    // particles, jellyfish, coral) are ready for the first frame immediately.
    buildContent(true);
    setSize();

    const resizeObserver = new ResizeObserver(() => {
      setSize();
      // Re-render immediately. Resizing the drawing buffer clears it, so waiting
      // for the next RAF tick leaves a blank frame — during a fast drag-resize
      // that reads as the background flickering off and on.
      renderFrame();
    });
    resizeObserver.observe(container);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility, { passive: true });

    // Pause when fully scrolled away from the hero.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !document.hidden) start();
          else stop();
        }
      },
      { threshold: 0 }
    );
    io.observe(container);

    // Follow the site light/dark toggle. While running, the tick eases the mix
    // for a smooth cross-fade; when paused/static, apply it instantly.
    const onThemeChange = () => {
      themeTarget = readThemeTarget();
      applyBlending();
      if (isStatic || !running) {
        themeMix = themeTarget;
        background.material.uniforms.uTheme.value = themeMix;
        for (const m of timed) m.uniforms.uTheme.value = themeMix;
        if (isStatic) renderStatic();
      }
    };
    const themeObserver = new MutationObserver(onThemeChange);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // Compile the initial programs in parallel (KHR_parallel_shader_compile)
    // before the first render; the container's CSS gradient covers until then,
    // so first paint never blocks on synchronous shader compilation.
    void renderer
      .compileAsync(scene, camera)
      .catch(() => {})
      .then(() => {
        if (disposed) return;
        ready = true;
        if (isStatic) renderStatic();
        else if (wantRun && !document.hidden) start();
      });

    return () => {
      disposed = true;
      stop();
      if (terrainWorker) {
        terrainWorker.terminate();
        terrainWorker = null;
      }
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (rebuildTimer) window.clearTimeout(rebuildTimer);
      resizeObserver.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (allowPointer) window.removeEventListener('pointermove', onPointerMove);
      disposeContent();
      themeObserver.disconnect();
      scene.remove(background.mesh);
      background.mesh.geometry.dispose();
      background.material.dispose();
      renderer.dispose();
      apiRef.current = null;
    };
    // diveRef is a stable ref (read live in tick); listing it here never rebuilds
    // the scene but keeps the dependency lint honest.
  }, [quality, animated, jellyfishCount, particleCount, terrainDensity, reinitKey, diveRef]);

  // Apply tuning changes: cheap uniforms immediately, geometry on a debounce.
  useEffect(() => {
    if (firstCfgApply.current) {
      firstCfgApply.current = false;
      return;
    }
    Object.assign(PARAMS, cfg);
    const api = apiRef.current;
    if (!api) return;
    api.applyCheap();
    api.scheduleRebuild();
  }, [cfg]);

  return (
    <>
      <div
        ref={containerRef}
        className={['underwater-bg', className].filter(Boolean).join(' ')}
        aria-hidden="true"
      >
        {!webglFailed && (
          <canvas key={reinitKey} ref={canvasRef} className="underwater-bg__canvas" />
        )}
        <div className="underwater-bg__overlay" />
      </div>
      {showTuner && (
        <UnderwaterTuner
          cfg={cfg}
          onChange={setCfg}
          onReset={() => setCfg({ ...DEFAULT_PARAMS })}
        />
      )}
    </>
  );
}

export default UnderwaterPointCloudBackground;
