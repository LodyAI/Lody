import { useEffect, useRef } from 'react';

import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';

import { deriveFabricUniforms, type FabricRecipe } from './fabric-recipe';

const styles = stylex.create({
  /** The canvas fills whatever box its owner gives it. */
  canvas: { height: '100%', width: '100%' },
});

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/**
 * Multi-scale woven-cloth shader.
 *
 * Per fragment (near LOD): locate the warp/weft yarns from the binary weave
 * matrix, rebuild each yarn's analytic centerline height + elliptical
 * cross-section (normal, fibre tangent incl. twist helix), pick the visible
 * yarn, then shade warp and weft with separate microcylinder lobes
 * (Sadeghi-style surface + coloured body scattering) plus a Charlie fuzz
 * layer. Mid/far LOD fades yarn geometry into pre-integrated coverage,
 * average colours and widened direction distributions to avoid moiré.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

out vec4 outColor;

uniform vec2 uResolution;
uniform float uThreadPx;
uniform float uSeed;
uniform float uMode; // 0 plane, 1 cylinder

uniform sampler2D uWeaveTex;   // r: warp-on-top bit, g: twist-flip bit
uniform vec2 uWeaveSize;
uniform sampler2D uYarnColorTex; // row 0 warp, row 1 weft (linear RGB)
uniform vec2 uColorCounts;

uniform float uCrimp;
uniform float uRadiusWarp;
uniform float uRadiusWeft;
uniform float uFlatten;
uniform float uSlub;
uniform float uYarnVar;
uniform float uPatternBlur;

uniform float uTwist;
uniform float uSigmaS;
uniform float uSigmaV;
uniform float uKd;
uniform vec3 uMelA;
uniform vec3 uMelB;
uniform float uMelange;
uniform float uFuzz;
uniform float uFuzzRough;
uniform vec3 uFuzzColor;

uniform float uAvgWarpCover;
uniform vec3 uAvgWarpColor;
uniform vec3 uAvgWeftColor;

uniform vec3 uLightPos;
uniform float uLightIntensity;
uniform float uLightSize;
uniform float uAmbient;

const float PI = 3.14159265;
const float F0 = 0.045;

float hash11(float p) {
  p = fract(p * 0.1031 + uSeed * 0.0913);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0713);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), u);
}

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

vec4 weaveTexel(float i, float j) {
  float x = mod(i, uWeaveSize.x);
  float y = mod(j, uWeaveSize.y);
  return texelFetch(uWeaveTex, ivec2(int(x), int(y)), 0);
}

float weaveBit(float i, float j) {
  return weaveTexel(i, j).r;
}

vec3 yarnColor(int row, float idx, float count) {
  float m = mod(idx, count);
  vec3 srgb = texelFetch(uYarnColorTex, ivec2(int(m), row), 0).rgb;
  return pow(srgb, vec3(2.2));
}

// Microcylinder lobe: anisotropic surface reflection cone around the fibre
// tangent + coloured body scattering. sigS = surface highlight width,
// sigV = fibre direction spread, uKd = isotropic internal scattering.
vec3 cylLobe(vec3 T, vec3 N, vec3 L, vec3 V, vec3 bodyColor, float sigS, float sigV, float ao) {
  float TL = clamp(dot(T, L), -1.0, 1.0);
  float TV = clamp(dot(T, V), -1.0, 1.0);
  float thI = asin(TL);
  float thO = asin(TV);
  float thH = (thI + thO) * 0.5;
  float thD = (thI - thO) * 0.5;
  vec3 Lp = L - TL * T;
  vec3 Vp = V - TV * T;
  float lpl = length(Lp);
  float vpl = length(Vp);
  float cosPhiD = (lpl > 1e-4 && vpl > 1e-4)
    ? clamp(dot(Lp, Vp) / (lpl * vpl), -1.0, 1.0)
    : 1.0;
  float cosHalfPhiD = sqrt(max(0.5 + 0.5 * cosPhiD, 0.0));
  float F = F0 + (1.0 - F0) * pow(1.0 - clamp(cos(thD) * cosHalfPhiD, 0.0, 1.0), 5.0);
  float gS = exp(-thH * thH / (2.0 * sigS * sigS));
  float gV = exp(-thH * thH / (2.0 * sigV * sigV));
  float NL = dot(N, L);
  float mS = clamp((NL + 0.1) / 1.1, 0.0, 1.0);   // masking, near-opaque for spec
  float mB = clamp((NL + 0.5) / 1.5, 0.0, 1.0);   // soft wrap for scattering
  float spec = F * cosHalfPhiD * gS / max(cos(thD) * cos(thD), 0.35);
  vec3 body = (1.0 - F) * bodyColor * ((1.0 - uKd) * gV + uKd * 0.8);
  return spec * 0.35 * mS * mix(0.6, 1.0, ao) * vec3(1.0) + body * mB * ao;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;

  // Macro surface frame + thread-space coordinates.
  vec3 Ngeo;
  vec3 Tgeo;
  vec3 Bgeo;
  vec3 pWorld;
  vec2 st;
  float edgeMask = 1.0;
  if (uMode > 0.5) {
    float xn = uv.x * 2.0 - 1.0;
    edgeMask = 1.0 - smoothstep(0.985, 0.9995, abs(xn));
    float th = asin(clamp(xn, -0.9995, 0.9995));
    Ngeo = vec3(sin(th), 0.0, cos(th));
    Tgeo = vec3(cos(th), 0.0, -sin(th));
    Bgeo = vec3(0.0, 1.0, 0.0);
    st = vec2(th * uResolution.x * 0.5, gl_FragCoord.y) / uThreadPx;
    float R = 0.45 * aspect;
    pWorld = vec3(xn * R, uv.y - 0.5, cos(th) * R);
  } else {
    Ngeo = vec3(0.0, 0.0, 1.0);
    Tgeo = vec3(1.0, 0.0, 0.0);
    Bgeo = vec3(0.0, 1.0, 0.0);
    st = gl_FragCoord.xy / uThreadPx;
    pWorld = vec3((uv.x - 0.5) * aspect, uv.y - 0.5, 0.0);
  }
  st += uSeed * 7.0;

  // LOD from the pixel footprint in thread units.
  float tpp = max(
    length(vec2(dFdx(st.x), dFdy(st.x))),
    length(vec2(dFdx(st.y), dFdy(st.y)))
  );
  float lodMid = smoothstep(0.35, 1.0, tpp);
  float lodFar = smoothstep(1.2, 3.5, tpp);

  // Yarns wander slightly off-grid.
  vec2 wob = vec2(vnoise2(st * 0.13 + 3.7), vnoise2(st * 0.13 + 17.1)) - 0.5;
  st += wob * 0.25 * (1.0 - lodFar);

  float ampX = (1.0 - uPatternBlur) * (1.0 - 0.9 * lodMid);          // cross-section detail
  float ampY = (1.0 - 0.8 * uPatternBlur) * (1.0 - 0.6 * lodMid);    // crimp / twill trend

  // ── Warp yarn (vertical columns) ─────────────────────────────
  float wi = floor(st.x);
  float flipW = weaveTexel(wi, 0.0).g > 0.5 ? -1.0 : 1.0;
  float slubW = 1.0 + uSlub * 0.8 * (vnoise1(st.y * 0.33 + hash11(wi) * 97.0) - 0.5);
  float rW = min(uRadiusWarp * slubW, 0.499);
  float dxW = st.x - wi - 0.5;
  float insideW = step(abs(dxW), rW);
  float ycW = st.y - 0.5;
  float jW = floor(ycW);
  float fWv = ycW - jW;
  float ssW = fWv * fWv * (3.0 - 2.0 * fWv);
  float s0 = weaveBit(wi, jW);
  float s1 = weaveBit(wi, jW + 1.0);
  float stateW = mix(s0, s1, ssW);
  float zcW = uCrimp * (stateW * 2.0 - 1.0);
  float qW = max(1.0 - dxW * dxW / (rW * rW), 0.0);
  float eW = rW * (1.0 - 0.7 * uFlatten);
  float zW = zcW + eW * sqrt(qW);
  float dzWdx = qW > 1e-4 ? clamp(-eW * dxW / (rW * rW) / sqrt(qW), -3.0, 3.0) : 0.0;
  float dzWdy = uCrimp * 2.0 * (s1 - s0) * 6.0 * fWv * (1.0 - fWv);
  vec3 nW = normalize(vec3(-dzWdx * ampX, -dzWdy * ampY, 1.0));
  vec3 axW = normalize(vec3(0.0, 1.0, dzWdy * ampY));
  float betaW = uTwist * flipW;
  vec3 tW = normalize(cos(betaW) * axW + sin(betaW) * normalize(cross(nW, axW)));

  // ── Weft yarn (horizontal rows) ──────────────────────────────
  float fj = floor(st.y);
  float slubF = 1.0 + uSlub * 0.8 * (vnoise1(st.x * 0.33 + hash11(fj * 1.7 + 31.0) * 91.0) - 0.5);
  float rF = min(uRadiusWeft * slubF, 0.499);
  float dyF = st.y - fj - 0.5;
  float insideF = step(abs(dyF), rF);
  float xcF = st.x - 0.5;
  float iF = floor(xcF);
  float gFv = xcF - iF;
  float ssF = gFv * gFv * (3.0 - 2.0 * gFv);
  float u0 = 1.0 - weaveBit(iF, fj);
  float u1 = 1.0 - weaveBit(iF + 1.0, fj);
  float stateF = mix(u0, u1, ssF);
  float zcF = uCrimp * (stateF * 2.0 - 1.0);
  float qF = max(1.0 - dyF * dyF / (rF * rF), 0.0);
  float eF = rF * (1.0 - 0.7 * uFlatten);
  float zF = zcF + eF * sqrt(qF);
  float dzFdy = qF > 1e-4 ? clamp(-eF * dyF / (rF * rF) / sqrt(qF), -3.0, 3.0) : 0.0;
  float dzFdx = uCrimp * 2.0 * (u1 - u0) * 6.0 * gFv * (1.0 - gFv);
  vec3 nF = normalize(vec3(-dzFdx * ampY, -dzFdy * ampX, 1.0));
  vec3 axF = normalize(vec3(1.0, 0.0, dzFdx * ampY));
  float betaF = uTwist * flipW;
  vec3 tF = normalize(cos(betaF) * axF + sin(betaF) * normalize(cross(nF, axF)));

  // ── Visibility: which yarn is on top, where are the pores ────
  float zWv = mix(-1e3, zW, insideW);
  float zFv = mix(-1e3, zF, insideF);
  float topW = smoothstep(-0.05, 0.05, zWv - zFv);
  float hole = (1.0 - insideW) * (1.0 - insideF);
  float wWarp = mix(topW, uAvgWarpCover, lodFar);

  // Inter-yarn shadowing from surface height.
  float hRangeW = uCrimp + eW + 1e-3;
  float hRangeF = uCrimp + eF + 1e-3;
  float aoW = mix(0.35, 1.0, clamp((zW + hRangeW) / (2.0 * hRangeW), 0.0, 1.0));
  float aoF = mix(0.35, 1.0, clamp((zF + hRangeF) / (2.0 * hRangeF), 0.0, 1.0));
  float aoBlend = mix(aoF, aoW, wWarp);
  float aoLod = mix(aoBlend, 0.85, lodFar);

  // ── Yarn colour: dyed sequence + mélange fibres + striations ─
  vec3 colW = yarnColor(0, wi, uColorCounts.x);
  vec3 colF = yarnColor(1, fj, uColorCounts.y);
  vec3 mel = mix(uMelA, uMelB, vnoise2(st * 5.3 + 11.3));
  colW = mix(colW, mel, uMelange);
  colF = mix(colF, mel, uMelange);
  float fibW = vnoise2(vec2(st.x * 8.0, st.y * 0.7));
  float fibF = vnoise2(vec2(st.x * 0.7, st.y * 8.0));
  float detail = 1.0 - lodFar;
  colW *= 1.0 + detail * (uYarnVar * (hash11(wi * 5.1) - 0.5) + 0.36 * (fibW - 0.5));
  colF *= 1.0 + detail * (uYarnVar * (hash11(fj * 6.3 + 9.0) - 0.5) + 0.36 * (fibF - 0.5));
  colW = mix(colW, uAvgWarpColor, lodFar);
  colF = mix(colF, uAvgWeftColor, lodFar);

  // ── Lighting ─────────────────────────────────────────────────
  mat3 TBN = mat3(Tgeo, Bgeo, Ngeo);
  vec3 Ldir = uLightPos - pWorld;
  float d2 = dot(Ldir, Ldir);
  vec3 L = Ldir * inversesqrt(max(d2, 1e-6));
  float atten = uLightIntensity / (1.0 + 2.0 * d2);
  vec3 V = vec3(0.0, 0.0, 1.0);
  float sigS = uSigmaS + uLightSize * 0.12 + lodFar * 0.15;
  float sigV = uSigmaV + uLightSize * 0.1 + lodFar * 0.2;

  vec3 shW = cylLobe(normalize(TBN * tW), normalize(TBN * nW), L, V, colW, sigS, sigV, aoW);
  vec3 shF = cylLobe(normalize(TBN * tF), normalize(TBN * nF), L, V, colF, sigS, sigV, aoF);
  vec3 direct = atten * mix(shF, shW, wWarp);

  vec3 nTop = normalize(TBN * mix(nF, nW, wWarp));
  vec3 baseCol = mix(colF, colW, wWarp);
  vec3 ambient = uAmbient * baseCol * (0.55 + 0.45 * dot(nTop, Ngeo)) * aoLod;

  vec3 col = direct + ambient;

  // Pores between open-set yarns.
  vec3 holeCol = uAmbient * baseCol * 0.15;
  col = mix(col, holeCol, hole * (1.0 - lodFar));

  // ── Fuzz: raised stray fibres (Charlie-style sheen) ──────────
  vec3 H = normalize(L + V);
  float NoH = clamp(dot(nTop, H), 0.0, 1.0);
  float ia = 1.0 / max(uFuzzRough, 0.05);
  float Dch = (2.0 + ia) * pow(max(1.0 - NoH * NoH, 0.0), ia * 0.5) / (2.0 * PI);
  float NoV = clamp(dot(Ngeo, V), 0.0, 1.0);
  float rim = 0.3 + 0.7 * pow(1.0 - NoV, 2.0);
  float NLw = clamp((dot(nTop, L) + 0.4) / 1.4, 0.0, 1.0);
  float hairNoise = 0.7 + 0.6 * vnoise2(st * vec2(2.3, 2.9) + 51.0);
  col += atten * uFuzz * 0.5 * uFuzzColor * Dch * rim * NLw * hairNoise * (1.0 - hole * 0.5);

  // Tonemap (soft shoulder) + gamma + dither.
  col = col / (1.0 + 0.6 * col);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.006;
  outColor = vec4(mix(vec3(0.05), col, edgeMask), 1.0);
}
`;

export interface FabricLight {
  /** Scene units: x right, y up, z toward viewer; the cloth sits near z=0. */
  x: number;
  y: number;
  z: number;
  intensity?: number;
  /** Area-light radius approximation; widens the specular lobes. */
  size?: number;
  ambient?: number;
}

export interface FabricSimulatorProps {
  recipe: FabricRecipe;
  /** 'plane' shows the flat swatch; 'cylinder' wraps it for a continuous view-angle sweep. */
  mode?: 'plane' | 'cylinder';
  light?: FabricLight;
  /** Move the light with the pointer (x/y follow, z kept from `light`). */
  followPointer?: boolean;
  seed?: number;
  className?: string;
}

const DEFAULT_LIGHT: FabricLight = { x: 0.25, y: 0.3, z: 0.9 };

/** Shader-based woven fabric simulator driven by a FabricRecipe. */
export function FabricSimulator({
  recipe,
  mode = 'plane',
  light = DEFAULT_LIGHT,
  followPointer = false,
  seed = 0,
  className,
}: FabricSimulatorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // getContext returns the same context object across effect re-runs
    // (every Storybook control change re-runs this effect), so the context
    // must never be released in cleanup — only the resources created here.
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl || gl.isContextLost()) return undefined;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        // eslint-disable-next-line no-console
        console.warn('FabricSimulator shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      // Free whatever compiled/allocated before bailing on an unsupported GPU.
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (program) gl.deleteProgram(program);
      return undefined;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      // eslint-disable-next-line no-console
      console.warn('FabricSimulator link error:', gl.getProgramInfoLog(program));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      return undefined;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const u = deriveFabricUniforms(recipe);

    // Weave matrix texture (unit 0).
    const weaveTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, weaveTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      u.weave.cols,
      u.weave.rows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      u.weave.data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Yarn-dye colour sequences (unit 1): row 0 warp, row 1 weft (sRGB bytes).
    const colorCount = Math.max(u.warpColors.length, u.weftColors.length);
    const colorData = new Uint8Array(colorCount * 2 * 4);
    const putColor = (row: number, i: number, c: [number, number, number]) => {
      const o = (row * colorCount + i) * 4;
      colorData[o] = Math.round(c[0] ** (1 / 2.2) * 255);
      colorData[o + 1] = Math.round(c[1] ** (1 / 2.2) * 255);
      colorData[o + 2] = Math.round(c[2] ** (1 / 2.2) * 255);
      colorData[o + 3] = 255;
    };
    for (let i = 0; i < colorCount; i++) {
      putColor(0, i, u.warpColors[i % u.warpColors.length]);
      putColor(1, i, u.weftColors[i % u.weftColors.length]);
    }
    const colorTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      colorCount,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      colorData
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const loc = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform1i(loc('uWeaveTex'), 0);
    gl.uniform1i(loc('uYarnColorTex'), 1);
    gl.uniform2f(loc('uWeaveSize'), u.weave.cols, u.weave.rows);
    gl.uniform2f(loc('uColorCounts'), u.warpColors.length, u.weftColors.length);
    gl.uniform1f(loc('uSeed'), seed);
    gl.uniform1f(loc('uMode'), mode === 'cylinder' ? 1 : 0);
    gl.uniform1f(loc('uCrimp'), u.crimp);
    gl.uniform1f(loc('uRadiusWarp'), u.radiusWarp);
    gl.uniform1f(loc('uRadiusWeft'), u.radiusWeft);
    gl.uniform1f(loc('uFlatten'), u.flatten);
    gl.uniform1f(loc('uSlub'), u.slub);
    gl.uniform1f(loc('uYarnVar'), u.yarnVar);
    gl.uniform1f(loc('uPatternBlur'), u.patternBlur);
    gl.uniform1f(loc('uTwist'), u.twistAngle);
    gl.uniform1f(loc('uSigmaS'), u.sigmaS);
    gl.uniform1f(loc('uSigmaV'), u.sigmaV);
    gl.uniform1f(loc('uKd'), u.kd);
    gl.uniform3f(loc('uMelA'), ...u.melA);
    gl.uniform3f(loc('uMelB'), ...u.melB);
    gl.uniform1f(loc('uMelange'), u.melange);
    gl.uniform1f(loc('uFuzz'), u.fuzz);
    gl.uniform1f(loc('uFuzzRough'), u.fuzzRough);
    gl.uniform3f(loc('uFuzzColor'), ...u.fuzzColor);
    gl.uniform1f(loc('uAvgWarpCover'), u.weave.warpCover);
    gl.uniform3f(loc('uAvgWarpColor'), ...u.avgWarpColor);
    gl.uniform3f(loc('uAvgWeftColor'), ...u.avgWeftColor);
    gl.uniform1f(loc('uLightIntensity'), light.intensity ?? 1.6);
    gl.uniform1f(loc('uLightSize'), light.size ?? 0.3);
    gl.uniform1f(loc('uAmbient'), light.ambient ?? 0.5);

    const uResolution = loc('uResolution');
    const uThreadPx = loc('uThreadPx');
    const uLightPos = loc('uLightPos');
    const lightPos = { x: light.x, y: light.y, z: light.z };

    const render = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uResolution, w, h);
      gl.uniform1f(uThreadPx, u.threadPx * dpr);
      gl.uniform3f(uLightPos, lightPos.x, lightPos.y, lightPos.z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    render();

    let raf = 0;
    const onPointer = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const aspect = rect.width / rect.height;
      lightPos.x = ((ev.clientX - rect.left) / rect.width - 0.5) * aspect;
      lightPos.y = 0.5 - (ev.clientY - rect.top) / rect.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };
    const onPointerLeave = () => {
      lightPos.x = light.x;
      lightPos.y = light.y;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };
    // The canvas is often pointer-events-none (decorative backdrop), so the
    // pointer is tracked on an opt-in ancestor scope when one exists.
    const pointerTarget: HTMLElement =
      canvas.closest<HTMLElement>('[data-fabric-pointer-scope]') ?? canvas.parentElement ?? canvas;
    if (followPointer) {
      pointerTarget.addEventListener('pointermove', onPointer);
      pointerTarget.addEventListener('pointerleave', onPointerLeave);
    }

    return () => {
      if (followPointer) {
        pointerTarget.removeEventListener('pointermove', onPointer);
        pointerTarget.removeEventListener('pointerleave', onPointerLeave);
      }
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.deleteTexture(weaveTex);
      gl.deleteTexture(colorTex);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [recipe, mode, light, followPointer, seed]);

  const canvasProps = stylex.props(styles.canvas);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      {...canvasProps}
      className={clsx(canvasProps.className, className)}
    />
  );
}
