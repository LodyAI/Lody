'use client';

/**
 * MarketingAtmosphere
 *
 * Fixed full-viewport fragment shader for price / download / changelog.
 * Math-driven “ordered chaos”: domain-warped FBM, caustic ridges, soft depth
 * bands. Follows site light/dark (`html.dark`) with the same deep/shallow water
 * split as the landing WebGL backdrop (no three.js).
 *
 * Cost: one full-screen triangle, dpr ≤ 1.5, low-power preference; pauses when
 * the tab is hidden; reduced-motion freezes time. CSS gradient fallback if
 * WebGL is unavailable.
 */

import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  FIELD_FRAG,
  FIELD_SAMPLE_FRAG,
  FIELD_SHADE_FRAG,
  PRESENT_FRAG,
  ridgeTapPixels,
  VERT,
} from './marketing-atmosphere-shaders';

/** Curated phase so first paint is mid-cycle (not the harsh t=0 warp). */
const TIME_ORIGIN = 23.6;

/**
 * The field drifts slowly (its fastest time term is 0.12/s), so expensive samples
 * can be sparse. Two full-resolution samples are blended on display frames: the
 * field stays smooth without reducing the drawing-buffer resolution or shader.
 */
const SAMPLE_FPS = 15;
const SAMPLE_INTERVAL_MS = 1000 / SAMPLE_FPS;
/**
 * Blends of a 15Hz signal gain nothing above 60fps, while every presented frame
 * also makes the compositor re-blur each frosted panel over the canvas.
 */
const PRESENT_FPS = 60;
const PRESENT_INTERVAL_MS = 1000 / PRESENT_FPS;
const SLOW_PRESENT_FPS = 30;
const SLOW_PRESENT_INTERVAL_MS = 1000 / SLOW_PRESENT_FPS;
/**
 * Drop blends to 30fps only for a GPU the field genuinely saturates. Once timer
 * queries worked, a 12ms floor fired on an M2 Max at dpr 2 (samples just over
 * 12ms) and halved its blend rate although sample pacing already held the field
 * near its GPU share.
 */
const SLOW_FIELD_GPU_MS = 25;
const TARGET_FIELD_GPU_SHARE = 0.2;
const DIRECT_FALLBACK_FPS = 30;
const DIRECT_FALLBACK_FRAME_MS = 1000 / DIRECT_FALLBACK_FPS;
const MIN_BLEND_MS = 1000 / 30;

type TimerQuery = object;

type DisjointTimerQueryExtension = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
  QUERY_RESULT_AVAILABLE_EXT: number;
  QUERY_RESULT_EXT: number;
  createQueryEXT(): TimerQuery | null;
  deleteQueryEXT(query: TimerQuery): void;
  beginQueryEXT(target: number, query: TimerQuery): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(query: TimerQuery, pname: number): unknown;
};

type DisjointTimerQueryWebGL2Extension = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

/**
 * Completion probe for one field sample. `exact` results come from a GPU timer
 * query; fence results only say the sample finished, so the caller estimates
 * its cost from the wall-clock latency.
 */
type ProbeResult =
  | { done: false }
  | { done: true; exact: true; gpuMs: number | null }
  | { done: true; exact: false };

type GpuProbe = {
  poll(): ProbeResult;
  dispose(): void;
};

type RenderTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
};

type FieldTarget = RenderTarget & {
  width: number;
  height: number;
  tap: number;
};

type PendingSample = {
  index: number;
  submittedAt: number;
  assumeReadyAt: number;
  probe: GpuProbe | null;
  seed: boolean;
  gpuDurationMs: number | null;
};

type TemporalTransition = {
  fromIndex: number;
  toIndex: number;
  startedAt: number;
  durationMs: number;
};

type FieldUniforms = {
  aPos: number;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uMotion: WebGLUniformLocation | null;
  uTheme: WebGLUniformLocation | null;
};

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[marketing-atmosphere] shader compile', gl.getShaderInfoLog(shader));
    }
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(
  gl: WebGLRenderingContext,
  vert: WebGLShader,
  frag: WebGLShader
): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[marketing-atmosphere] program link', gl.getProgramInfoLog(program));
    }
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function buildProgram(
  gl: WebGLRenderingContext,
  vert: WebGLShader,
  fragSource: string
): WebGLProgram | null {
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSource);
  if (!frag) return null;
  const program = link(gl, vert, frag);
  gl.deleteShader(frag);
  return program;
}

function fieldUniforms(gl: WebGLRenderingContext, program: WebGLProgram): FieldUniforms {
  return {
    aPos: gl.getAttribLocation(program, 'aPos'),
    uRes: gl.getUniformLocation(program, 'uRes'),
    uTime: gl.getUniformLocation(program, 'uTime'),
    uMotion: gl.getUniformLocation(program, 'uMotion'),
    uTheme: gl.getUniformLocation(program, 'uTheme'),
  };
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  powerPreference: 'low-power',
  preserveDrawingBuffer: false,
};

/**
 * Marketing routes that share this atmosphere. Hosted once at the app root so
 * price ↔ download ↔ changelog navigation never recompiles WebGL.
 */
export function isMarketingAtmospherePath(pathname: string): boolean {
  const path = pathname.replace(/\/$/u, '') || '/';
  const bare = path.startsWith('/zh/') ? path.slice(3) : path === '/zh' ? '/' : path;
  return (
    bare === '/price' ||
    bare === '/download' ||
    bare === '/download/nightly' ||
    bare === '/changelog' ||
    bare.startsWith('/changelog/')
  );
}

export function MarketingAtmosphere({
  className,
  /** When false, hide + pause the loop but keep the GL context warm. */
  active = true,
}: {
  className?: string;
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    // WebGL2 adds fences and the timer-query extension browsers still expose, so
    // sample pacing can see the GPU. The shaders are GLSL ES 1.00 either way.
    const gl2 = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    const gl: WebGLRenderingContext | null =
      gl2 ||
      canvas.getContext('webgl', CONTEXT_ATTRIBUTES) ||
      (canvas.getContext('experimental-webgl', {
        ...CONTEXT_ATTRIBUTES,
        powerPreference: undefined,
        preserveDrawingBuffer: undefined,
      }) as WebGLRenderingContext | null);

    if (!gl) {
      canvas.dataset.fallback = 'true';
      return undefined;
    }

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const fieldProgram = vert ? buildProgram(gl, vert, FIELD_FRAG) : null;
    if (!vert || !fieldProgram) {
      if (vert) gl.deleteShader(vert);
      canvas.dataset.fallback = 'true';
      return undefined;
    }

    // Temporal presentation and the split field are optional. Failure here
    // retains the previous direct full-resolution renderer rather than losing
    // the atmosphere.
    const presentProgram = buildProgram(gl, vert, PRESENT_FRAG);
    let sampleProgram = buildProgram(gl, vert, FIELD_SAMPLE_FRAG);
    let shadeProgram = sampleProgram ? buildProgram(gl, vert, FIELD_SHADE_FRAG) : null;
    if (!shadeProgram && sampleProgram) {
      gl.deleteProgram(sampleProgram);
      sampleProgram = null;
    }
    gl.deleteShader(vert);

    const deletePrograms = () => {
      gl.deleteProgram(fieldProgram);
      if (presentProgram) gl.deleteProgram(presentProgram);
      if (sampleProgram) gl.deleteProgram(sampleProgram);
      if (shadeProgram) gl.deleteProgram(shadeProgram);
    };

    const buf = gl.createBuffer();
    if (!buf) {
      deletePrograms();
      canvas.dataset.fallback = 'true';
      return undefined;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const directUniforms = fieldUniforms(gl, fieldProgram);
    const sampleUniforms = sampleProgram ? fieldUniforms(gl, sampleProgram) : null;
    const shadeUniforms = shadeProgram ? fieldUniforms(gl, shadeProgram) : null;
    const uField = shadeProgram ? gl.getUniformLocation(shadeProgram, 'uField') : null;
    const uFieldSize = shadeProgram ? gl.getUniformLocation(shadeProgram, 'uFieldSize') : null;
    const uTap = shadeProgram ? gl.getUniformLocation(shadeProgram, 'uTap') : null;
    const presentAPos = presentProgram ? gl.getAttribLocation(presentProgram, 'aPos') : -1;
    const uFrom = presentProgram ? gl.getUniformLocation(presentProgram, 'uFrom') : null;
    const uTo = presentProgram ? gl.getUniformLocation(presentProgram, 'uTo') : null;
    const uMix = presentProgram ? gl.getUniformLocation(presentProgram, 'uMix') : null;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    let timerExt = gl2
      ? null
      : (gl.getExtension('EXT_disjoint_timer_query') as DisjointTimerQueryExtension | null);
    let timerExt2 = gl2
      ? (gl2.getExtension(
          'EXT_disjoint_timer_query_webgl2'
        ) as DisjointTimerQueryWebGL2Extension | null)
      : null;
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = rendererInfo
      ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)).toLowerCase()
      : '';
    // A CPU rasteriser spends seconds of every core per full-screen sample, so
    // it gets the still frame that reduced motion gets.
    const softwareRenderer = /swiftshader|llvmpipe|software/.test(renderer);

    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const readMotion = () => (motionMq.matches || softwareRenderer ? 0 : 1);
    let motion = readMotion();
    let theme = isDarkTheme() ? 0 : 1; // 0 dark, 1 light
    let themeTarget = theme;
    let tabVisible = document.visibilityState === 'visible';
    let raf = 0;
    let running = true;
    // Presentation follows display frames up to PRESENT_FPS on capable GPUs.
    // Heavy field samples are separately paced and never overlap on the GPU.
    let lastPaintAt = -1;
    let lastDirectPaintAt = -1;
    const start = performance.now();
    const maxDpr = 1.5;
    let temporalTargets: RenderTarget[] = [];
    let fieldTarget: FieldTarget | null = null;
    let temporalUnavailable = !presentProgram;
    let splitUnavailable = !sampleProgram;
    let temporalResetNeeded = true;
    let endpointIndex: number | null = null;
    let pendingSample: PendingSample | null = null;
    let transition: TemporalTransition | null = null;
    let nextSampleAt = 0;
    let sampleIntervalMs = SAMPLE_INTERVAL_MS;
    let presentIntervalMs = PRESENT_INTERVAL_MS;
    let lastPresentAt = -1;
    // What the canvas currently shows, so an unchanged frame is not redrawn.
    let shownKey = '';
    let presentedThisFrame = false;
    // Without a GPU timer, a fence after a cheap present frame measures the
    // browser's own readback delay; a sample fence beyond that is field work.
    let referenceFence: { probe: GpuProbe; submittedAt: number } | null = null;
    let referenceLatencyMs: number | null = null;

    const pageActive = () => activeRef.current;

    const syncThemeClass = () => {
      document.documentElement.classList.toggle('marketing-atmosphere-light', themeTarget > 0.5);
    };

    const syncActiveClass = () => {
      const on = pageActive();
      document.documentElement.classList.toggle('marketing-atmosphere-active', on);
      canvas.dataset.pageActive = on ? 'true' : 'false';
    };

    const timerProbe2 = (ctx: WebGL2RenderingContext, ext: DisjointTimerQueryWebGL2Extension) => {
      const query = ctx.createQuery();
      if (!query) return null;
      ctx.beginQuery(ext.TIME_ELAPSED_EXT, query);
      return (): GpuProbe => {
        ctx.endQuery(ext.TIME_ELAPSED_EXT);
        return {
          poll: () => {
            if (!ctx.getQueryParameter(query, ctx.QUERY_RESULT_AVAILABLE)) return { done: false };
            if (ctx.getParameter(ext.GPU_DISJOINT_EXT))
              return { done: true, exact: true, gpuMs: null };
            const elapsedNs = Number(ctx.getQueryParameter(query, ctx.QUERY_RESULT));
            return {
              done: true,
              exact: true,
              gpuMs: Number.isFinite(elapsedNs) && elapsedNs > 0 ? elapsedNs / 1_000_000 : null,
            };
          },
          dispose: () => ctx.deleteQuery(query),
        };
      };
    };

    const timerProbe1 = (ext: DisjointTimerQueryExtension) => {
      const query = ext.createQueryEXT();
      if (!query) return null;
      ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, query);
      return (): GpuProbe => {
        ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
        return {
          poll: () => {
            if (!ext.getQueryObjectEXT(query, ext.QUERY_RESULT_AVAILABLE_EXT))
              return { done: false };
            // Read the result before deleting it. It controls both field duty
            // cycle and presentation pacing when the GPU cannot keep up cheaply.
            if (gl.getParameter(ext.GPU_DISJOINT_EXT))
              return { done: true, exact: true, gpuMs: null };
            const elapsedNs = Number(ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT));
            return {
              done: true,
              exact: true,
              gpuMs: Number.isFinite(elapsedNs) && elapsedNs > 0 ? elapsedNs / 1_000_000 : null,
            };
          },
          dispose: () => ext.deleteQueryEXT(query),
        };
      };
    };

    const fenceProbe = (ctx: WebGL2RenderingContext): GpuProbe | null => {
      const sync = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) return null;
      return {
        poll: () =>
          ctx.getSyncParameter(sync, ctx.SYNC_STATUS) === ctx.SIGNALED
            ? { done: true, exact: false }
            : { done: false },
        dispose: () => ctx.deleteSync(sync),
      };
    };

    /** Starts timing a sample; the returned function closes it after the draws. */
    const openProbe = (): (() => GpuProbe | null) => {
      try {
        if (gl2 && timerExt2) {
          const close = timerProbe2(gl2, timerExt2);
          if (close) return close;
        }
        if (timerExt) {
          const close = timerProbe1(timerExt);
          if (close) return close;
        }
      } catch {
        timerExt = null;
        timerExt2 = null;
      }
      return () => (gl2 ? fenceProbe(gl2) : null);
    };

    const disposeProbe = (sample: PendingSample) => {
      if (!sample.probe) return;
      try {
        sample.probe.dispose();
      } catch {
        // The context may already be lost; nothing left to free.
      }
      sample.probe = null;
    };

    const deletePendingSample = () => {
      if (pendingSample) disposeProbe(pendingSample);
      pendingSample = null;
    };

    const deleteReferenceFence = () => {
      if (!referenceFence) return;
      try {
        referenceFence.probe.dispose();
      } catch {
        // The context may already be lost; nothing left to free.
      }
      referenceFence = null;
    };

    // Only while no sample is queued, so the reference never waits on one.
    const trackReferenceFence = (now: number, presented: boolean) => {
      if (referenceFence) {
        let done = false;
        try {
          done = referenceFence.probe.poll().done;
        } catch {
          deleteReferenceFence();
          return;
        }
        if (!done) return;
        const latency = now - referenceFence.submittedAt;
        referenceLatencyMs =
          referenceLatencyMs === null
            ? latency
            : referenceLatencyMs + (latency - referenceLatencyMs) * 0.25;
        deleteReferenceFence();
        return;
      }
      if (!presented || pendingSample || !gl2 || timerExt2) return;
      const probe = fenceProbe(gl2);
      if (probe) referenceFence = { probe, submittedAt: now };
    };

    const deleteTarget = (target: RenderTarget) => {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    };

    const deleteTemporalTargets = () => {
      for (const target of temporalTargets) deleteTarget(target);
      temporalTargets = [];
    };

    const deleteFieldTarget = () => {
      if (fieldTarget) deleteTarget(fieldTarget);
      fieldTarget = null;
    };

    const resetTemporalState = () => {
      deletePendingSample();
      deleteReferenceFence();
      endpointIndex = null;
      transition = null;
      nextSampleAt = 0;
      lastPresentAt = -1;
      shownKey = '';
      temporalResetNeeded = true;
    };

    const createTarget = (width: number, height: number, filter: number): RenderTarget | null => {
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) {
        if (texture) gl.deleteTexture(texture);
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (!complete) {
        deleteTarget({ texture, framebuffer });
        return null;
      }
      return { texture, framebuffer };
    };

    const allocateTemporalTargets = (width: number, height: number) => {
      if (temporalUnavailable || !presentProgram) return false;
      deletePendingSample();
      deleteTemporalTargets();

      const allocated: RenderTarget[] = [];
      for (let index = 0; index < 2; index++) {
        const target = createTarget(width, height, gl.LINEAR);
        if (!target) {
          for (const done of allocated) deleteTarget(done);
          temporalUnavailable = true;
          canvas.dataset.temporal = 'false';
          return false;
        }
        allocated.push(target);
      }

      temporalTargets = allocated;
      temporalResetNeeded = true;
      endpointIndex = null;
      transition = null;
      shownKey = '';
      canvas.dataset.temporal = 'true';
      return true;
    };

    // n / n2 at the canvas size plus the ridge tap on the right and top edges,
    // read back texel-exact (NEAREST) by the shade pass.
    const allocateFieldTarget = (width: number, height: number) => {
      deleteFieldTarget();
      if (splitUnavailable) return;
      const tap = ridgeTapPixels(height);
      const target = createTarget(width + tap, height + tap, gl.NEAREST);
      if (!target) {
        splitUnavailable = true;
        canvas.dataset.split = 'false';
        return;
      }
      fieldTarget = { ...target, width: width + tap, height: height + tap, tap };
      canvas.dataset.split = 'true';
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const w = Math.max(1, Math.floor(window.innerWidth * dpr));
      const h = Math.max(1, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        allocateFieldTarget(w, h);
        if (!temporalUnavailable) allocateTemporalTargets(w, h);
        else resetTemporalState();
        return true;
      }
      return false;
    };

    const bindTriangle = (program: WebGLProgram, aPos: number) => {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    };

    const updateTheme = (now: number) => {
      const frames = lastPaintAt < 0 ? 1 : Math.min(8, (now - lastPaintAt) / (1000 / 60));
      theme += (themeTarget - theme) * (1 - Math.pow(1 - 0.12, frames));
      if (Math.abs(themeTarget - theme) < 0.002) theme = themeTarget;
      lastPaintAt = now;
    };

    const runField = (program: WebGLProgram, uniforms: FieldUniforms, fieldTime: number) => {
      bindTriangle(program, uniforms.aPos);
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime, TIME_ORIGIN + fieldTime);
      gl.uniform1f(uniforms.uMotion, motion);
      gl.uniform1f(uniforms.uTheme, theme);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const drawField = (framebuffer: WebGLFramebuffer | null, fieldTime: number) => {
      if (fieldTarget && sampleProgram && shadeProgram && sampleUniforms && shadeUniforms) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fieldTarget.framebuffer);
        gl.viewport(0, 0, fieldTarget.width, fieldTarget.height);
        runField(sampleProgram, sampleUniforms, fieldTime);

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(shadeProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fieldTarget.texture);
        gl.uniform1i(uField, 0);
        gl.uniform2f(uFieldSize, fieldTarget.width, fieldTarget.height);
        gl.uniform1f(uTap, fieldTarget.tap);
        runField(shadeProgram, shadeUniforms, fieldTime);
        return;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      runField(fieldProgram, directUniforms, fieldTime);
    };

    const beginTimedSample = (
      index: number,
      fieldTime: number,
      now: number,
      seed: boolean
    ): PendingSample => {
      const closeProbe = openProbe();
      drawField(temporalTargets[index].framebuffer, fieldTime);
      let probe: GpuProbe | null = null;
      try {
        probe = closeProbe();
      } catch {
        timerExt = null;
        timerExt2 = null;
      }
      gl.flush();
      return {
        index,
        submittedAt: now,
        assumeReadyAt: now + sampleIntervalMs,
        probe,
        seed,
        gpuDurationMs: null,
      };
    };

    const sampleReady = (pending: PendingSample, now: number) => {
      if (!pending.probe) return now >= pending.assumeReadyAt;
      let result: ProbeResult;
      try {
        result = pending.probe.poll();
      } catch {
        timerExt = null;
        timerExt2 = null;
        disposeProbe(pending);
        return now >= pending.assumeReadyAt;
      }
      if (!result.done) return false;
      disposeProbe(pending);
      if (result.exact) {
        pending.gpuDurationMs = result.gpuMs;
      } else if (referenceLatencyMs !== null) {
        // Fence status reaches script frames after the GPU finishes, and that
        // delay varies by browser; only latency beyond a cheap frame's counts.
        pending.gpuDurationMs = Math.max(0, now - pending.submittedAt - referenceLatencyMs);
      }
      return true;
    };

    const present = (fromIndex: number, toIndex: number, mix: number, now: number) => {
      if (!presentProgram) return false;
      const key =
        mix <= 0 ? `${fromIndex}` : mix >= 1 ? `${toIndex}` : `${fromIndex}>${toIndex}@${mix}`;
      if (key === shownKey) return true;
      // Tolerate rAF jitter: a 60Hz display keeps every frame at a 60fps cap.
      if (lastPresentAt >= 0 && now - lastPresentAt < presentIntervalMs * 0.75) {
        return false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      bindTriangle(presentProgram, presentAPos);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, temporalTargets[fromIndex].texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, temporalTargets[toIndex].texture);
      gl.uniform1i(uFrom, 0);
      gl.uniform1i(uTo, 1);
      gl.uniform1f(uMix, mix);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      lastPresentAt = now;
      shownKey = key;
      presentedThisFrame = true;
      return true;
    };

    const paintTemporalFrame = (now: number, fieldTime: number) => {
      if (temporalResetNeeded || endpointIndex === null) {
        deletePendingSample();
        transition = null;
        endpointIndex = 0;
        pendingSample = beginTimedSample(0, fieldTime, now, true);
        nextSampleAt = now + sampleIntervalMs;
        temporalResetNeeded = false;
        shownKey = '';
        lastPresentAt = -1;
        present(0, 0, 0, now);
        return;
      }

      if (pendingSample && sampleReady(pendingSample, now)) {
        const completed = pendingSample;
        pendingSample = null;
        if (completed.gpuDurationMs !== null) {
          sampleIntervalMs = Math.max(
            SAMPLE_INTERVAL_MS,
            completed.gpuDurationMs / TARGET_FIELD_GPU_SHARE
          );
          if (completed.gpuDurationMs >= SLOW_FIELD_GPU_MS) {
            presentIntervalMs = SLOW_PRESENT_INTERVAL_MS;
          }
          nextSampleAt = Math.max(nextSampleAt, completed.submittedAt + sampleIntervalMs);
        }
        if (!completed.seed) {
          const renderWaitMs = Math.max(0, now - completed.submittedAt);
          transition = {
            fromIndex: endpointIndex,
            toIndex: completed.index,
            startedAt: now,
            durationMs: Math.max(MIN_BLEND_MS, sampleIntervalMs - renderWaitMs),
          };
          endpointIndex = completed.index;
        }
      }

      if (transition) {
        const mix = Math.min(1, Math.max(0, (now - transition.startedAt) / transition.durationMs));
        present(transition.fromIndex, transition.toIndex, mix, now);
        if (mix >= 1) {
          transition = null;
        }
        return;
      }

      const shown = present(endpointIndex, endpointIndex, 0, now);

      // Present the completed endpoint before queuing the next heavy pass. This
      // gives the compositor a cheap frame ahead of the field work and keeps at
      // most one sample in flight on slow GPUs.
      if (shown && !pendingSample && now >= nextSampleAt) {
        const freeIndex = endpointIndex === 0 ? 1 : 0;
        pendingSample = beginTimedSample(freeIndex, fieldTime, now, false);
        nextSampleAt = now + sampleIntervalMs;
      }
    };

    const paintTemporal = (now: number, fieldTime: number) => {
      presentedThisFrame = false;
      paintTemporalFrame(now, fieldTime);
      trackReferenceFence(now, presentedThisFrame);
    };

    const paint = (now: number) => {
      if (!pageActive()) return;
      resize();
      updateTheme(now);
      const fieldTime = motion > 0 ? (now - start) * 0.001 : 0;

      if (motion > 0 && !temporalUnavailable && temporalTargets.length === 2) {
        paintTemporal(now, fieldTime);
        return;
      }

      if (now - lastDirectPaintAt >= DIRECT_FALLBACK_FRAME_MS - 1 || lastDirectPaintAt < 0) {
        drawField(null, fieldTime);
        lastDirectPaintAt = now;
        // The canvas no longer shows a temporal endpoint.
        shownKey = '';
      }
    };

    const shouldLoop = () => {
      if (!pageActive() || !tabVisible) return false;
      const themeSettling = Math.abs(themeTarget - theme) > 0.002;
      return motion > 0 || themeSettling;
    };

    const loop = (now: number) => {
      if (!running) return;
      paint(now);
      if (shouldLoop()) {
        raf = window.requestAnimationFrame(loop);
      } else {
        raf = 0;
      }
    };

    const kick = () => {
      if (!running) return;
      if (raf) window.cancelAnimationFrame(raf);
      syncActiveClass();
      if (!pageActive()) {
        raf = 0;
        return;
      }
      if (shouldLoop()) {
        raf = window.requestAnimationFrame(loop);
      } else {
        paint(performance.now());
        raf = 0;
      }
    };

    const onMotion = () => {
      motion = readMotion();
      resetTemporalState();
      lastDirectPaintAt = -1;
      kick();
    };
    const onVisibility = () => {
      tabVisible = document.visibilityState === 'visible';
      if (tabVisible) resetTemporalState();
      kick();
    };
    const onResize = () => {
      if (pageActive() && !raf) paint(performance.now());
    };
    const onTheme = () => {
      themeTarget = isDarkTheme() ? 0 : 1;
      syncThemeClass();
      resetTemporalState();
      kick();
    };

    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // Poll activeRef via rAF-friendly custom event from the host (or effect below).
    const onActiveChange = () => {
      resetTemporalState();
      kick();
    };
    window.addEventListener('marketing-atmosphere-active', onActiveChange);

    motionMq.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize, { passive: true });

    syncThemeClass();
    syncActiveClass();
    canvas.dataset.ready = 'true';
    kick();

    return () => {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
      themeObserver.disconnect();
      window.removeEventListener('marketing-atmosphere-active', onActiveChange);
      motionMq.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      document.documentElement.classList.remove('marketing-atmosphere-active');
      document.documentElement.classList.remove('marketing-atmosphere-light');
      deletePendingSample();
      deleteReferenceFence();
      deleteTemporalTargets();
      deleteFieldTarget();
      gl.deleteBuffer(buf);
      deletePrograms();
      // Deliberately NOT calling WEBGL_lose_context.loseContext() here. A canvas
      // hands the same context object back to every getContext() call, and a lost
      // one is never revived implicitly (restoreContext() is async). React
      // re-invokes effects in dev, so losing the context on cleanup left the
      // remount holding a dead context: every compile failed with a null info log
      // and the field silently fell back to the CSS gradient for the whole dev
      // session. The GL objects above are freed explicitly; the context itself
      // goes with the canvas. This host is designed to keep one context warm for
      // the session anyway, so there is nothing to reclaim early.
    };
  }, []);

  // Notify the GL effect when the host toggles `active` without remounting.
  useEffect(() => {
    window.dispatchEvent(new Event('marketing-atmosphere-active'));
  }, [active]);

  return (
    <div
      className={['marketing-atmosphere', className].filter(Boolean).join(' ')}
      data-page-active={active ? 'true' : 'false'}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="marketing-atmosphere__canvas" />
    </div>
  );
}

/**
 * Single app-root host: first marketing visit compiles WebGL once; subsequent
 * marketing routes reuse the same instance. Leaving marketing pauses the loop
 * and hides the canvas without tearing down GL (warm resume).
 */
export function MarketingAtmosphereHost() {
  const { pathname } = useLocation();
  const onMarketing = isMarketingAtmospherePath(pathname);
  const [warm, setWarm] = useState(false);

  useEffect(() => {
    if (onMarketing) setWarm(true);
  }, [onMarketing]);

  if (!warm) return null;

  return (
    <MarketingAtmosphere
      active={onMarketing}
      className={
        pathname.replace(/\/$/u, '').endsWith('/download/nightly')
          ? 'marketing-atmosphere--nightly'
          : undefined
      }
    />
  );
}

export default MarketingAtmosphere;
