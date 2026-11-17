package app.lody.android.auth

import android.annotation.SuppressLint
import android.content.Context
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.SystemClock
import android.provider.Settings
import android.view.MotionEvent
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The sign-in page's inset visual: web `login-dither-visual.tsx` on OpenGL ES 2. The web
 * WebGL fragment shader runs unchanged into a framebuffer of whole dither cells, which is then
 * magnified without filtering, so every cell is exactly [CELL_DP] and the pattern never swims.
 * A SurfaceView ignores Compose clipping and alpha, so the blit pass draws the rounded corners
 * in the page colour and applies the fold-away fade itself. Decoration only: without GL it is
 * the plain page, and with animations off it draws one still frame.
 */
@SuppressLint("ViewConstructor")
internal class LoginDitherView(context: Context) : GLSurfaceView(context) {
    private val renderer = DitherRenderer(context.resources.displayMetrics.density)

    init {
        setEGLContextClientVersion(2)
        setRenderer(renderer)
        renderMode = if (animationsEnabled(context)) RENDERMODE_CONTINUOUSLY else RENDERMODE_WHEN_DIRTY
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    /** ARGB colours: the surface's paper and ink, and the page around its rounded corners. */
    fun setColors(paper: Int, ink: Int, page: Int) {
        renderer.paper = rgb(paper); renderer.ink = rgb(ink); renderer.page = rgb(page)
        requestRender()
    }

    fun setVisibleFraction(value: Float) {
        renderer.alpha = value.coerceIn(0f, 1f)
        requestRender()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        renderer.targetX = event.x / max(width, 1)
        renderer.targetY = 1f - event.y / max(height, 1)
        return true
    }

    private fun rgb(color: Int) = floatArrayOf(
        ((color shr 16) and 0xff) / 255f, ((color shr 8) and 0xff) / 255f, (color and 0xff) / 255f,
    )

    private class DitherRenderer(private val density: Float) : Renderer {
        @Volatile var paper = floatArrayOf(0.95f, 0.95f, 0.95f)
        @Volatile var ink = floatArrayOf(0f, 0f, 0f)
        @Volatile var page = floatArrayOf(1f, 1f, 1f)
        @Volatile var alpha = 1f
        @Volatile var targetX = 0.5f
        @Volatile var targetY = 0.5f
        private var pointerX = 0.5f
        private var pointerY = 0.5f
        private var dither = 0
        private var blit = 0
        private var framebuffer = 0
        private var texture = 0
        private var columns = 1
        private var rows = 1
        private var width = 1
        private var height = 1
        private var startedAt = -1L
        private var lastFrame = -1L
        private var elapsed = 0.0
        private val triangle: FloatBuffer = ByteBuffer.allocateDirect(6 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
            .apply { put(floatArrayOf(-1f, -1f, 3f, -1f, -1f, 3f)); position(0) }

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            dither = program(VERTEX_SHADER, FRAGMENT_SHADER)
            blit = program(VERTEX_SHADER, BLIT_SHADER)
            val ids = IntArray(1)
            GLES20.glGenFramebuffers(1, ids, 0); framebuffer = ids[0]
            GLES20.glGenTextures(1, ids, 0); texture = ids[0]
            columns = 0; rows = 0
        }

        override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
            this.width = max(1, width); this.height = max(1, height)
            val cell = CELL_DP * density
            val nextColumns = max(1, floor(width / cell).toInt())
            val nextRows = max(1, floor(height / cell).toInt())
            if (nextColumns == columns && nextRows == rows) return
            columns = nextColumns; rows = nextRows
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, columns, rows, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
            for (parameter in intArrayOf(GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_TEXTURE_MAG_FILTER)) {
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, parameter, GLES20.GL_NEAREST)
            }
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer)
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, texture, 0)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        }

        override fun onDrawFrame(gl: GL10?) {
            val now = SystemClock.uptimeMillis()
            if (lastFrame >= 0) elapsed += min(now - lastFrame, 100L) / 1000.0
            lastFrame = now
            if (startedAt < 0) startedAt = now
            pointerX += (targetX - pointerX) * 0.05f
            pointerY += (targetY - pointerY) * 0.05f
            val reveal = min(1f, (now - startedAt) / REVEAL_MS)
            val paper = paper; val ink = ink; val page = page
            if (dither == 0 || blit == 0) {
                GLES20.glClearColor(paper[0], paper[1], paper[2], 1f)
                GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
                return
            }
            // Pass 1: web's shader, one fragment per dither cell.
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer)
            GLES20.glViewport(0, 0, columns, rows)
            GLES20.glUseProgram(dither)
            GLES20.glUniform1f(GLES20.glGetUniformLocation(dither, "t"), (elapsed + 3).toFloat())
            GLES20.glUniform2f(GLES20.glGetUniformLocation(dither, "r"), columns.toFloat(), rows.toFloat())
            GLES20.glUniform2f(GLES20.glGetUniformLocation(dither, "m"), pointerX, pointerY)
            GLES20.glUniform3f(GLES20.glGetUniformLocation(dither, "paper"), paper[0], paper[1], paper[2])
            GLES20.glUniform3f(GLES20.glGetUniformLocation(dither, "ink"), ink[0], ink[1], ink[2])
            GLES20.glUniform1f(GLES20.glGetUniformLocation(dither, "reveal"), if (animates) reveal else 1f)
            // Nothing to keep clear: the page has no tagline over the visual.
            GLES20.glUniform2f(GLES20.glGetUniformLocation(dither, "clearTo"), -1f, -1f)
            drawTriangle(dither)
            // Pass 2: whole cells from the top-left, the sliver left over is paper, the
            // rounded corners are page.
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
            // During the fold, the surface buffer can resize before the renderer receives
            // its new viewport. Clear the whole buffer (not just that viewport) to page.
            GLES20.glClearColor(page[0], page[1], page[2], 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            GLES20.glViewport(0, 0, width, height)
            GLES20.glUseProgram(blit)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
            GLES20.glUniform1i(GLES20.glGetUniformLocation(blit, "image"), 0)
            val cell = CELL_DP * density
            GLES20.glUniform2f(GLES20.glGetUniformLocation(blit, "size"), width.toFloat(), height.toFloat())
            GLES20.glUniform2f(GLES20.glGetUniformLocation(blit, "covered"), columns * cell, rows * cell)
            GLES20.glUniform1f(GLES20.glGetUniformLocation(blit, "radius"), RADIUS_DP * density)
            GLES20.glUniform1f(GLES20.glGetUniformLocation(blit, "alpha"), alpha)
            GLES20.glUniform3f(GLES20.glGetUniformLocation(blit, "paper"), paper[0], paper[1], paper[2])
            GLES20.glUniform3f(GLES20.glGetUniformLocation(blit, "page"), page[0], page[1], page[2])
            drawTriangle(blit)
        }

        var animates = true

        private fun drawTriangle(program: Int) {
            val position = GLES20.glGetAttribLocation(program, "p")
            GLES20.glEnableVertexAttribArray(position)
            GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, triangle)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3)
        }

        private fun program(vertex: String, fragment: String): Int {
            fun compile(type: Int, source: String): Int {
                val shader = GLES20.glCreateShader(type)
                GLES20.glShaderSource(shader, source)
                GLES20.glCompileShader(shader)
                val status = IntArray(1)
                GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
                return if (status[0] == 0) 0 else shader
            }
            val vertexShader = compile(GLES20.GL_VERTEX_SHADER, vertex)
            val fragmentShader = compile(GLES20.GL_FRAGMENT_SHADER, fragment)
            if (vertexShader == 0 || fragmentShader == 0) return 0
            val program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, vertexShader)
            GLES20.glAttachShader(program, fragmentShader)
            GLES20.glLinkProgram(program)
            val status = IntArray(1)
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
            return if (status[0] == 0) 0 else program
        }
    }

    init {
        renderer.animates = animationsEnabled(context)
    }

    companion object {
        /** dp per dither cell, as web's CSS pixels per cell. */
        const val CELL_DP = 3f
        const val RADIUS_DP = 14f
        /** The entrance: the dither develops outward from the centre over this long. */
        const val REVEAL_MS = 1600f

        fun animationsEnabled(context: Context): Boolean =
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

        private const val VERTEX_SHADER = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"

        private const val BLIT_SHADER = """
precision mediump float;
uniform sampler2D image;
uniform vec2 size;
uniform vec2 covered;
uniform float radius;
uniform float alpha;
uniform vec3 paper;
uniform vec3 page;
void main(){
  // From the top-left, in pixels.
  vec2 px=vec2(gl_FragCoord.x,size.y-gl_FragCoord.y);
  vec3 color=paper;
  if(px.x<covered.x&&px.y<covered.y){
    color=texture2D(image,vec2(px.x/covered.x,1.-px.y/covered.y)).rgb;
  }
  vec2 q=abs(px-.5*size)-(.5*size-radius);
  float outside=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
  float inside=1.-smoothstep(-.5,.5,outside);
  gl_FragColor=vec4(mix(page,color,inside*alpha),1.);
}
"""

        // Web `login-dither-visual.tsx`, verbatim.
        private const val FRAGMENT_SHADER = """
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
  float clear=(1.-smoothstep(clearTo.x,clearTo.x+.15,sp.x))*(1.-smoothstep(clearTo.y,clearTo.y+.12,sp.y));
  L*=1.-clear;
  L*=smoothstep(0.,1.,reveal*1.8-length(uv)*.8);
  float on=step(b8(gl_FragCoord.xy)+.001,clamp(L,0.,1.));
  gl_FragColor=vec4(mix(paper,ink,on),1.);
}
"""
    }
}
