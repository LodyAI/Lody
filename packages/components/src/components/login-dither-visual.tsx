import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, type RefObject } from 'react';

// The login page's inset visual: a ray-marched jellyfish (the Lody mark) drawn
// as 1-bit ordered dither in the surface's own ink and paper. It reads both
// colours from its container, so it follows the theme without its own palette,
// and it is decoration only: no WebGL, or reduced motion, simply means the
// plain surface or one still frame.

/** CSS pixels per dither cell. */
const DITHER_CELL_PX = 3;
/** How often the theme colours are re-read, in frames. */
const THEME_POLL_FRAMES = 30;
/** The entrance: the dither develops outward from the centre over this long. */
const REVEAL_MS = 1600;

const VERTEX_SHADER = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

const FRAGMENT_SHADER = `
precision highp float;
uniform float t;
uniform vec2 r;
uniform vec2 m;
uniform vec3 paper;
uniform vec3 ink;
uniform float reveal;
uniform vec2 clearTo;
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float b2(vec2 a){a=floor(a);return fract(a.x*.5+a.y*a.y*.75);}
float b4(vec2 a){return b2(.5*a)*.25+b2(a);}
float b8(vec2 a){return b4(.5*a)*.25+b2(a);}
float bell(vec3 p){
  float pu=1.+.08*sin(t*2.2);vec3 q=p;q.xz/=pu;q.y*=pu;
  vec3 e=q*vec3(1.,1.3,1.);
  float d=max((length(e)-1.)/1.3,-(q.y+.05));
  d=max(d,-((length(e-vec3(0.,-.16,0.))-.84)/1.3));
  d+=.025*sin(atan(q.z,q.x)*12.+t*3.)*smoothstep(.25,-.05,q.y);
  return d;
}
float tent(vec3 p){
  float d=1e5;
  for(int i=0;i<8;i++){
    float fi=float(i);float a=fi*.785+.3;float y=clamp(-p.y,0.,2.8);
    vec2 o=vec2(cos(a),sin(a))*(.62-y*.08)+vec2(sin(y*2.3-t*2.+fi),cos(y*2.-t*1.6+fi*1.3))*.13*y;
    d=min(d,length(p-vec3(o.x,-y,o.y))-.05*(1.-y/3.1));
  }
  float y=clamp(-p.y,0.,1.8);
  d=min(d,length(p-vec3(sin(y*3.-t*1.5)*.12*y,-y,cos(y*2.5-t*1.3)*.1*y))-.15*(1.-y/2.));
  return d;
}
float map(vec3 p){
  p.y-=.14*sin(t*.7);
  p.xz=rot((m.x-.5)*1.4+t*.15)*p.xz;
  p.yz=rot(.38+(m.y-.5)*.6)*p.yz;
  return min(bell(p),tent(p));
}
void main(){
  vec2 sp=gl_FragCoord.xy/r;
  vec2 uv=(gl_FragCoord.xy-.5*r)/r.y;
  // Wide surfaces set the jellyfish off to the right; square and tall ones
  // centre it.
  float aspect=r.x/r.y;
  vec3 ro=vec3(-.75*clamp((aspect-1.)/.6,0.,1.),-.95,7.4),rd=normalize(vec3(uv,-1.7));
  float d=0.,hit=0.;
  for(int i=0;i<80;i++){float h=map(ro+rd*d);if(h<.002){hit=1.;break;}d+=h*.8;if(d>13.)break;}
  float L=.02+.1*(1.-sp.y)+.04*sin(sp.x*9.+t*.4+sin(sp.y*7.-t*.3)*2.);
  if(hit>.5){
    vec3 p=ro+rd*d;vec2 e=vec2(.003,0.);
    vec3 n=normalize(vec3(map(p+e.xyy)-map(p-e.xyy),map(p+e.yxy)-map(p-e.yxy),map(p+e.yyx)-map(p-e.yyx)));
    float dif=max(dot(n,normalize(vec3(-.5,.8,.6))),0.);
    float rim=pow(1.-max(dot(n,-rd),0.),2.);
    L=.12+.6*dif+.55*rim;
  }
  // Keep the copy's corner clear so it stays legible: clearTo is its far
  // corner, measured from the bottom-left, as a fraction of the surface.
  float clear=(1.-smoothstep(clearTo.x,clearTo.x+.15,sp.x))*(1.-smoothstep(clearTo.y,clearTo.y+.12,sp.y));
  L*=1.-clear;
  // Entrance: density grows outward from the centre instead of the image
  // arriving all at once.
  L*=smoothstep(0.,1.,reveal*1.8-length(uv)*.8);
  float on=step(b8(gl_FragCoord.xy)+.001,clamp(L,0.,1.));
  gl_FragColor=vec4(mix(paper,ink,on),1.);
}
`;

type Rgb = [number, number, number];

let colorProbe: CanvasRenderingContext2D | null | undefined;

// Resolves any computed CSS colour (rgb(), color(srgb …), oklab() from a
// color-mix) by painting it, rather than parsing each serialization.
function resolveCssColor(value: string, fallback: Rgb): Rgb {
  if (colorProbe === undefined) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    colorProbe = probe.getContext('2d', { willReadFrequently: true });
  }
  if (!colorProbe) {
    return fallback;
  }
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [red, green, blue] = colorProbe.getImageData(0, 0, 1, 1).data;
  return [red / 255, green / 255, blue / 255];
}

function compileProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

export function LoginDitherVisual({
  keepClearRef,
}: {
  /** Copy laid over the bottom-left of the surface, kept free of dither. */
  keepClearRef?: RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || typeof WebGLRenderingContext === 'undefined') {
      return undefined;
    }
    const gl = canvas.getContext('webgl', { antialias: false });
    if (!gl) {
      return undefined;
    }
    const program = compileProgram(gl);
    if (!program) {
      return undefined;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = {
      t: gl.getUniformLocation(program, 't'),
      r: gl.getUniformLocation(program, 'r'),
      m: gl.getUniformLocation(program, 'm'),
      paper: gl.getUniformLocation(program, 'paper'),
      ink: gl.getUniformLocation(program, 'ink'),
      reveal: gl.getUniformLocation(program, 'reveal'),
      clearTo: gl.getUniformLocation(program, 'clearTo'),
    };

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 };
    let paper: Rgb = [0.95, 0.95, 0.95];
    let ink: Rgb = [0, 0, 0];
    let elapsed = 0;
    let lastFrameAt = performance.now();
    let frameCount = 0;
    let raf = 0;
    let revealStartedAt: number | null = null;
    // Below the surface: nothing is cleared until the copy is measured.
    let clearTo: [number, number] = [-1, -1];

    const readTheme = () => {
      const style = getComputedStyle(container);
      paper = resolveCssColor(style.backgroundColor, paper);
      ink = resolveCssColor(style.color, ink);
    };

    // The copy sits in the bottom-left; its box (plus a margin) stays clear.
    const readClearZone = () => {
      const copy = keepClearRef?.current;
      const bounds = container.getBoundingClientRect();
      if (!copy || bounds.width === 0 || bounds.height === 0) {
        clearTo = [-1, -1];
        return;
      }
      const copyBounds = copy.getBoundingClientRect();
      clearTo = [
        (copyBounds.right - bounds.left + 16) / bounds.width,
        (bounds.bottom - copyBounds.top + 16) / bounds.height,
      ];
    };

    // The canvas is sized in whole cells and shown at exactly DITHER_CELL_PX per
    // cell. Stretching it to the container instead makes every cell a fraction
    // of a pixel wider, and that fraction changes on each resize step, so the
    // pattern swims. The sliver left over is the container's own paper colour.
    let sizedColumns = 0;
    let sizedRows = 0;
    const resize = () => {
      const columns = Math.max(1, Math.floor(container.clientWidth / DITHER_CELL_PX));
      const rows = Math.max(1, Math.floor(container.clientHeight / DITHER_CELL_PX));
      if (columns === sizedColumns && rows === sizedRows) {
        return false;
      }
      sizedColumns = columns;
      sizedRows = rows;
      canvas.width = columns;
      canvas.height = rows;
      canvas.style.width = `${columns * DITHER_CELL_PX}px`;
      canvas.style.height = `${rows * DITHER_CELL_PX}px`;
      gl.viewport(0, 0, columns, rows);
      return true;
    };

    const revealProgress = (now: number) => {
      if (reducedMotion?.matches) return 1;
      revealStartedAt ??= now;
      return Math.min(1, (now - revealStartedAt) / REVEAL_MS);
    };

    const draw = (now = performance.now()) => {
      if (frameCount % THEME_POLL_FRAMES === 0) {
        readTheme();
        readClearZone();
      }
      frameCount += 1;
      pointer.x += (pointer.targetX - pointer.x) * 0.05;
      pointer.y += (pointer.targetY - pointer.y) * 0.05;
      gl.uniform1f(uniforms.t, elapsed + 3);
      gl.uniform2f(uniforms.r, canvas.width, canvas.height);
      gl.uniform2f(uniforms.m, pointer.x, pointer.y);
      gl.uniform3f(uniforms.paper, paper[0], paper[1], paper[2]);
      gl.uniform3f(uniforms.ink, ink[0], ink[1], ink[2]);
      gl.uniform1f(uniforms.reveal, revealProgress(now));
      gl.uniform2f(uniforms.clearTo, clearTo[0], clearTo[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const tick = (now: number) => {
      elapsed += (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      draw(now);
      raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const start = () => {
      stop();
      if (reducedMotion?.matches || document.visibilityState === 'hidden') {
        // One still frame: the visual is decoration and must not move here.
        frameCount = 0;
        draw();
        return;
      }
      lastFrameAt = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.targetX = (event.clientX - rect.left) / (rect.width || 1);
      pointer.targetY = 1 - (event.clientY - rect.top) / (rect.height || 1);
    };

    // Resizing clears the drawing buffer. Observer callbacks run after layout
    // and before paint, so redrawing here, animating or not, means no frame is
    // ever presented empty.
    const resizeObserver = new ResizeObserver(() => {
      if (resize()) {
        readClearZone();
        draw();
      }
    });
    resize();
    resizeObserver.observe(container);
    container.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('visibilitychange', start);
    reducedMotion?.addEventListener?.('change', start);
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      container.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('visibilitychange', start);
      reducedMotion?.removeEventListener?.('change', start);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [keepClearRef]);

  return (
    <div ref={containerRef} aria-hidden="true" {...stylex.props(styles.fill)}>
      <canvas ref={canvasRef} {...stylex.props(styles.canvas)} />
    </div>
  );
}

const styles = stylex.create({
  // Inherits the surface's background and colour: they are the dither's paper
  // and ink.
  fill: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'inherit',
    color: 'inherit',
  },
  // Width and height are set in whole cells by the effect.
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'block',
    imageRendering: 'pixelated',
  },
});
