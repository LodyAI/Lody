/**
 * GLSL for `marketing-atmosphere.tsx`.
 *
 * The field is one function of the pixel: the domain-warped value `n`, a second
 * warped value `n2`, and the two forward differences of `n` that draw the ridge
 * filigree. Two programs evaluate it:
 *
 * - `FIELD_FRAG` computes everything in one pass (direct renderer and static
 *   frames). It calls `warped()` four times per pixel.
 * - `FIELD_SAMPLE_FRAG` + `FIELD_SHADE_FRAG` split it for temporal samples. The
 *   first pass stores `n` and `n2` at 16-bit precision in an RGBA8 target that
 *   extends `ridgeTapPixels(height)` past the right and top edges; the second
 *   reads the two ridge taps as neighbouring texels. The finite difference and
 *   the full warp are unchanged — the taps are the same `warped()` values the
 *   neighbour pixel already paid for — so each sample runs `warped()` about twice
 *   per pixel instead of four times.
 */

export const VERT = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const PRESENT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;

void main() {
  if (uMix <= 0.0) {
    gl_FragColor = texture2D(uFrom, vUv);
  } else if (uMix >= 1.0) {
    gl_FragColor = texture2D(uTo, vUv);
  } else {
    gl_FragColor = mix(texture2D(uFrom, vUv), texture2D(uTo, vUv), uMix);
  }
}
`;

/** Ridge tap distance in `pField` units (the forward-difference step). */
const RIDGE_TAP = 0.016;
/** `pField = p * PFIELD_SCALE + …`; `p` spans one unit per canvas height. */
const PFIELD_SCALE = 0.95;

/**
 * The ridge tap expressed in whole drawing-buffer pixels, so the split sampler
 * reads exact neighbour texels. Rounding moves the tap by under half a pixel
 * (<2% of the step on any desktop-sized canvas).
 */
export function ridgeTapPixels(height: number): number {
  return Math.max(1, Math.round((RIDGE_TAP * height) / PFIELD_SCALE));
}

const FIELD_HEADER = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uMotion;
uniform float uTheme;
`;

// uTheme: 0 = dark abyss, 1 = light shallow (landing BG_FRAG palette).
const FIELD_FUNCTIONS = /* glsl */ `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

// NOTE: the ridge highlights need a finite difference of this whole function.
// Holding the warp fixed and stepping inside warped space is ~5x cheaper per tap
// but destroys the filigree — the warp's own gradient over the step is larger
// than the step itself, so it carries most of the line structure. Do not
// "optimise" that away; the split sampler reuses neighbour pixels instead.
float warped(vec2 p, float t) {
  vec2 q = vec2(
    fbm(p + vec2(1.4, 0.6) + vec2(0.0, t * 0.12)),
    fbm(p + vec2(4.1, 2.8) - vec2(t * 0.09, 0.0))
  );
  vec2 r = vec2(
    fbm(p + 3.4 * q + vec2(2.4, 7.1) + t * 0.055),
    fbm(p + 3.4 * q + vec2(6.8, 1.9) - t * 0.04)
  );
  return fbm(p + 3.0 * r);
}

float causticNet(vec2 p, float t) {
  vec2 w = p + 0.35 * vec2(
    fbm(p * 0.9 + vec2(t * 0.05, 0.0)),
    fbm(p * 0.9 + vec2(3.1, t * 0.04))
  );
  float c = 0.0;
  c += sin(w.x * 7.5 + t * 0.35) * sin(w.y * 6.2 - t * 0.28);
  c += 0.65 * sin((w.x + w.y) * 5.4 - t * 0.22);
  c += 0.4 * sin((w.x - w.y) * 8.1 + t * 0.18);
  return c * 0.5 + 0.5;
}

vec2 fieldPos(vec2 fragCoord) {
  vec2 uv = fragCoord / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  return p * ${PFIELD_SCALE.toFixed(2)} + vec2(0.18, -0.12);
}

float fieldN(vec2 pField, float t) {
  return warped(pField + vec2(0.0, -t * 0.024), t * 0.075);
}

float fieldN2(vec2 pField, float t) {
  return warped(pField * 1.7 + vec2(t * 0.016, 0.08), t * 0.05 + 1.9);
}
`;

// nx / ny are the forward differences of fieldN over the ridge tap.
const FIELD_SHADE = /* glsl */ `
vec3 shadeField(vec2 fragCoord, float n, float n2, float nx, float ny) {
  vec2 uv = fragCoord / uRes;
  vec2 pField = fieldPos(fragCoord);
  float y = uv.y;
  float t = uTime;
  float light = clamp(uTheme, 0.0, 1.0);

  // --- Dark base (landing abyss) ------------------------------------------
  vec3 dTop = vec3(0.028, 0.095, 0.168);
  vec3 dMid = vec3(0.055, 0.175, 0.285);
  vec3 dBot = vec3(0.022, 0.068, 0.138);
  vec3 darkBase = y > 0.5
    ? mix(dMid, dTop, (y - 0.5) * 2.0)
    : mix(dBot, dMid, y * 2.0);

  // --- Light base (shallow water — richer mid blue so structure has room) ---
  // Not pure white: more saturation/depth so caustics don't wash out.
  vec3 lTop  = vec3(0.88, 0.93, 0.98);
  vec3 lMid  = vec3(0.62, 0.78, 0.92);
  vec3 lBot  = vec3(0.48, 0.66, 0.84);
  vec3 lightBase = y > 0.5
    ? mix(lMid, lTop, (y - 0.5) * 2.0)
    : mix(lBot, lMid, y * 2.0);

  vec3 base = mix(darkBase, lightBase, light);

  // Accents: bright caustics on dark; deeper teal veins on light (higher contrast).
  vec3 dAqua = vec3(0.14, 0.66, 0.82);
  vec3 dIce  = vec3(0.58, 0.80, 0.93);
  vec3 lAqua = vec3(0.12, 0.42, 0.62);
  vec3 lInk  = vec3(0.06, 0.22, 0.38);
  vec3 aqua = mix(dAqua, lAqua, light);
  vec3 ice  = mix(dIce, vec3(0.95, 0.98, 1.0), light);
  vec3 deep = mix(vec3(0.03, 0.10, 0.19), lBot, light);

  float body = smoothstep(0.35, 0.72, n);
  // Light: stronger body modulation so the field isn't a flat wash.
  vec3 col = mix(base, deep, mix(0.22, 0.28, light) * (1.0 - body));
  col = mix(col, mix(dMid * 1.15, lMid * 0.92, light), body * mix(0.28, 0.38, light));
  col = mix(col, aqua * mix(0.14, 0.16, light) + base, body * mix(0.18, 0.22, light));

  float ridge = 1.0 - smoothstep(0.0, 0.065, abs(nx) + abs(ny));
  ridge *= smoothstep(0.2, 0.58, n) * (0.4 + 0.6 * n2);
  float heightMask = smoothstep(0.0, 0.72, y) * 0.75 + 0.25;

  // Dark: additive aqua light. Light: ink veins — boosted so they read clearly.
  float ridgeAmt = mix(0.2, 0.28, light);
  col += mix(aqua, lInk, light) * ridge * ridgeAmt * heightMask;
  col += ice * ridge * ridge * mix(0.07, 0.09, light) * heightMask;

  float net = causticNet(pField * 1.15 + vec2(0.0, -t * 0.03), t);
  // Light: wider/soft threshold + higher weight so the net isn't lost.
  net = smoothstep(mix(0.42, 0.32, light), mix(0.78, 0.72, light), net);
  net *= heightMask * (0.55 + 0.45 * n);
  col += mix(aqua, lInk, light) * net * mix(0.11, 0.2, light);
  col += ice * net * net * mix(0.035, 0.06, light);

  float veins = smoothstep(0.46, 0.58, n2) - smoothstep(0.58, 0.72, n2);
  veins = max(veins, 0.0);
  col += mix(aqua, lInk, light) * veins * mix(0.07, 0.12, light) * heightMask;

  float shaft = pow(max(0.0, 1.0 - length((uv - vec2(0.42, 1.1)) * vec2(1.15, 1.65))), 2.0);
  // Light: cooler top wash that still leaves mid-field free for structure.
  col += mix(mix(aqua, ice, 0.35) * 0.11, ice * 0.12, light) * shaft;

  float bands = sin((n * 3.8 + y * 2.0 - t * 0.05) * 3.14159);
  bands = bands * bands;
  col += mix(aqua, lInk, light) * bands * mix(0.015, 0.028, light) * heightMask;

  // Vignette: darken edges on dark; cool rim on light (helps structure pop).
  float vigAmt = mix(0.24, 0.2, light);
  float vig = 1.0 - vigAmt * smoothstep(0.25, 1.15, length((uv - 0.5) * vec2(1.12, 1.0)));
  col *= vig;
  // Light only: slight blue push in the rim so edges aren't flat grey.
  col = mix(col, col * vec3(0.92, 0.96, 1.02), light * (1.0 - vig) * 0.85);

  col = pow(max(col, 0.0), vec3(mix(0.9, 0.94, light)));
  col *= mix(1.05, 1.02, light);
  return col;
}
`;

/** Single-pass field: four `warped()` calls per pixel. */
export const FIELD_FRAG = /* glsl */ `${FIELD_HEADER}${FIELD_FUNCTIONS}${FIELD_SHADE}
void main() {
  vec2 pField = fieldPos(gl_FragCoord.xy);
  float n = fieldN(pField, uTime);
  float n2 = fieldN2(pField, uTime);
  float e = ${RIDGE_TAP.toFixed(3)};
  float nx = fieldN(pField + vec2(e, 0.0), uTime) - n;
  float ny = fieldN(pField + vec2(0.0, e), uTime) - n;
  gl_FragColor = vec4(shadeField(gl_FragCoord.xy, n, n2, nx, ny), 1.0);
}
`;

// 16-bit fixed point in two RGBA8 channels. n and n2 are fbm sums in [0, 1).
const PACK16 = /* glsl */ `
vec2 pack16(float v) {
  float x = clamp(v, 0.0, 1.0) * 255.0;
  float hi = min(floor(x), 254.0);
  return vec2(hi / 255.0, x - hi);
}
float unpack16(vec2 c) {
  return (floor(c.x * 255.0 + 0.5) + c.y) / 255.0;
}
`;

/**
 * Pass 1: `n` (RG) and `n2` (BA). Rendered into a target `ridgeTapPixels`
 * larger than the canvas on the right and top; `uRes` stays the canvas size so
 * the extra texels are the field just past the edge.
 */
export const FIELD_SAMPLE_FRAG = /* glsl */ `${FIELD_HEADER}${FIELD_FUNCTIONS}${PACK16}
void main() {
  vec2 pField = fieldPos(gl_FragCoord.xy);
  gl_FragColor = vec4(pack16(fieldN(pField, uTime)), pack16(fieldN2(pField, uTime)));
}
`;

/** Pass 2: ridge taps are exact neighbour texels of pass 1. */
export const FIELD_SHADE_FRAG = /* glsl */ `${FIELD_HEADER}${FIELD_FUNCTIONS}${PACK16}${FIELD_SHADE}
uniform sampler2D uField;
uniform vec2 uFieldSize;
uniform float uTap;
void main() {
  vec2 inv = 1.0 / uFieldSize;
  vec4 c = texture2D(uField, gl_FragCoord.xy * inv);
  float n = unpack16(c.rg);
  float n2 = unpack16(c.ba);
  float nx = unpack16(texture2D(uField, (gl_FragCoord.xy + vec2(uTap, 0.0)) * inv).rg) - n;
  float ny = unpack16(texture2D(uField, (gl_FragCoord.xy + vec2(0.0, uTap)) * inv).rg) - n;
  gl_FragColor = vec4(shadeField(gl_FragCoord.xy, n, n2, nx, ny), 1.0);
}
`;
