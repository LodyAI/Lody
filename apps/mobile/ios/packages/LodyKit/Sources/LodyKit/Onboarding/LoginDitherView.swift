import MetalKit
import UIKit

/// The sign-in page's inset visual: web `login-dither-visual.tsx` on Metal. A
/// ray-marched jellyfish (the Lody mark) drawn as 1-bit ordered dither in the
/// surface's own ink and paper. It is decoration only: without Metal it is the
/// plain paper surface, and Reduce Motion leaves one still frame.
@MainActor
final class LoginDitherView: UIView, MTKViewDelegate {
  /// Points per dither cell, as web's CSS pixels per cell.
  private static let cell: CGFloat = 3
  /// The entrance: the dither develops outward from the centre over this long.
  private static let revealDuration: CFTimeInterval = 1.6

  private let metal: MTKView?
  private let queue: MTLCommandQueue?
  private var elapsed: CFTimeInterval = 0
  private var lastFrame: CFTimeInterval?
  private var revealStarted: CFTimeInterval?
  private var pointer = (x: Float(0.5), y: Float(0.5), targetX: Float(0.5), targetY: Float(0.5))
  private var columns = 0
  private var rows = 0
  private var observers: [NSObjectProtocol] = []

  override init(frame: CGRect) {
    let renderer = Self.renderer
    if let renderer {
      let view = MTKView(frame: .zero, device: renderer.device)
      view.colorPixelFormat = .bgra8Unorm
      view.framebufferOnly = true
      view.autoResizeDrawable = false
      view.isOpaque = true
      view.preferredFramesPerSecond = 60
      // The drawable is sized in whole cells and magnified without filtering, so
      // every cell is exactly `cell` points and the pattern never swims on resize.
      view.layer.magnificationFilter = .nearest
      view.isUserInteractionEnabled = false
      metal = view
      queue = renderer.queue
    } else {
      metal = nil
      queue = nil
    }
    super.init(frame: frame)
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    backgroundColor = LoginPalette.visualPaper
    clipsToBounds = true
    if let metal {
      metal.delegate = self
      metal.isPaused = true
      metal.enableSetNeedsDisplay = true
      addSubview(metal)
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LoginDitherView, _: UITraitCollection) in view.metal?.setNeedsDisplay() }
    let pan = UIPanGestureRecognizer(target: self, action: #selector(track(_:)))
    pan.cancelsTouchesInView = false
    addGestureRecognizer(pan)
    for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, UIApplication.didBecomeActiveNotification,
                 UIApplication.didEnterBackgroundNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.updatePlayback() }
      })
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
  isolated deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let metal, bounds.width >= Self.cell, bounds.height >= Self.cell else { return }
    // Auto Layout applies the folded model height before its presentation layer
    // finishes collapsing. Keep the full drawable while that layer clips it;
    // resizing to one row here stretches a vertical ink stripe through the fold.
    let nextColumns = max(1, Int(floor(bounds.width / Self.cell)))
    let nextRows = max(1, Int(floor(bounds.height / Self.cell)))
    metal.frame = CGRect(x: 0, y: 0, width: CGFloat(nextColumns) * Self.cell, height: CGFloat(nextRows) * Self.cell)
    guard nextColumns != columns || nextRows != rows else { return }
    columns = nextColumns
    rows = nextRows
    metal.drawableSize = CGSize(width: nextColumns, height: nextRows)
    metal.setNeedsDisplay()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updatePlayback()
  }

  private var animates: Bool {
    window != nil && !UIAccessibility.isReduceMotionEnabled && UIApplication.shared.applicationState != .background
  }

  private func updatePlayback() {
    guard let metal else { return }
    let playing = animates
    lastFrame = nil
    metal.enableSetNeedsDisplay = !playing
    metal.isPaused = !playing
    if !playing { metal.setNeedsDisplay() }
  }

  @objc private func track(_ gesture: UIPanGestureRecognizer) {
    let point = gesture.location(in: self)
    pointer.targetX = Float(point.x / max(bounds.width, 1))
    pointer.targetY = Float(1 - point.y / max(bounds.height, 1))
  }

  nonisolated func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  nonisolated func draw(in view: MTKView) {
    MainActor.assumeIsolated { render(view) }
  }

  private func render(_ view: MTKView) {
    guard let renderer = Self.renderer, let queue, let pass = view.currentRenderPassDescriptor,
          let drawable = view.currentDrawable, let buffer = queue.makeCommandBuffer(),
          let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
    let now = CACurrentMediaTime()
    if !view.isPaused, let lastFrame { elapsed += now - lastFrame }
    lastFrame = view.isPaused ? nil : now
    pointer.x += (pointer.targetX - pointer.x) * 0.05
    pointer.y += (pointer.targetY - pointer.y) * 0.05
    let reveal: Float
    if UIAccessibility.isReduceMotionEnabled {
      reveal = 1
    } else {
      revealStarted = revealStarted ?? now
      reveal = Float(min(1, (now - (revealStarted ?? now)) / Self.revealDuration))
    }
    let paper = Self.rgb(LoginPalette.visualPaper.resolvedColor(with: traitCollection))
    let ink = Self.rgb(LoginPalette.visualInk.resolvedColor(with: traitCollection))
    // Matches the shader's `Uniforms` layout: float4 paper, float4 ink, float2 r,
    // float2 m, float2 clearTo, float t, float reveal.
    var uniforms: [Float] = [
      paper.0, paper.1, paper.2, 1,
      ink.0, ink.1, ink.2, 1,
      Float(view.drawableSize.width), Float(view.drawableSize.height),
      pointer.x, pointer.y,
      // Nothing to keep clear: the page has no tagline over the visual.
      -1, -1,
      Float(elapsed + 3), reveal,
    ]
    encoder.setRenderPipelineState(renderer.pipeline)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Float>.stride * uniforms.count, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    buffer.present(drawable)
    buffer.commit()
  }

  private static func rgb(_ color: UIColor) -> (Float, Float, Float) {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return (Float(red), Float(green), Float(blue))
  }

  private struct Renderer: @unchecked Sendable {
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState
  }

  private static let renderer: Renderer? = {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
          let library = try? device.makeLibrary(source: shader, options: nil) else { return nil }
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: "loginDitherVertex")
    descriptor.fragmentFunction = library.makeFunction(name: "loginDitherFragment")
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else { return nil }
    return Renderer(device: device, queue: queue, pipeline: pipeline)
  }()

  // A line-for-line port of web's fragment shader. Metal's fragment origin is the
  // top-left, so `frag` flips y back to GL's bottom-left before anything reads it;
  // `ss` is GLSL's smoothstep, which web also calls with reversed edges.
  private static let shader = """
  #include <metal_stdlib>
  using namespace metal;

  struct Uniforms { float4 paper; float4 ink; float2 r; float2 m; float2 clearTo; float t; float reveal; };
  struct Out { float4 position [[position]]; };

  vertex Out loginDitherVertex(uint id [[vertex_id]]) {
    const float2 p[3] = { float2(-1, -1), float2(3, -1), float2(-1, 3) };
    Out out; out.position = float4(p[id], 0, 1); return out;
  }

  static float ss(float a, float b, float x) { float k = clamp((x - a) / (b - a), 0.0, 1.0); return k * k * (3.0 - 2.0 * k); }
  static float2x2 rot(float a) { float c = cos(a), s = sin(a); return float2x2(float2(c, -s), float2(s, c)); }
  static float b2(float2 a) { a = floor(a); return fract(a.x * .5 + a.y * a.y * .75); }
  static float b4(float2 a) { return b2(.5 * a) * .25 + b2(a); }
  static float b8(float2 a) { return b4(.5 * a) * .25 + b2(a); }

  static float bell(float3 p, float t) {
    float pu = 1. + .08 * sin(t * 2.2); float3 q = p; q.xz /= pu; q.y *= pu;
    float3 e = q * float3(1., 1.3, 1.);
    float d = max((length(e) - 1.) / 1.3, -(q.y + .05));
    d = max(d, -((length(e - float3(0., -.16, 0.)) - .84) / 1.3));
    d += .025 * sin(atan2(q.z, q.x) * 12. + t * 3.) * ss(.25, -.05, q.y);
    return d;
  }

  static float tent(float3 p, float t) {
    float d = 1e5;
    for (int i = 0; i < 8; i++) {
      float fi = float(i); float a = fi * .785 + .3; float y = clamp(-p.y, 0., 2.8);
      float2 o = float2(cos(a), sin(a)) * (.62 - y * .08) + float2(sin(y * 2.3 - t * 2. + fi), cos(y * 2. - t * 1.6 + fi * 1.3)) * .13 * y;
      d = min(d, length(p - float3(o.x, -y, o.y)) - .05 * (1. - y / 3.1));
    }
    float y = clamp(-p.y, 0., 1.8);
    d = min(d, length(p - float3(sin(y * 3. - t * 1.5) * .12 * y, -y, cos(y * 2.5 - t * 1.3) * .1 * y)) - .15 * (1. - y / 2.));
    return d;
  }

  static float map(float3 p, float t, float2 m) {
    p.y -= .14 * sin(t * .7);
    p.xz = rot((m.x - .5) * 1.4 + t * .15) * p.xz;
    p.yz = rot(.38 + (m.y - .5) * .6) * p.yz;
    return min(bell(p, t), tent(p, t));
  }

  fragment float4 loginDitherFragment(Out in [[stage_in]], constant Uniforms &u [[buffer(0)]]) {
    float t = u.t; float2 r = u.r; float2 m = u.m;
    float2 frag = float2(in.position.x, r.y - in.position.y);
    float2 sp = frag / r;
    float2 uv = (frag - .5 * r) / r.y;
    // Wide surfaces set the jellyfish off to the right; square and tall ones centre it.
    float aspect = r.x / r.y;
    float3 ro = float3(-.75 * clamp((aspect - 1.) / .6, 0., 1.), -.95, 7.4), rd = normalize(float3(uv, -1.7));
    float d = 0., hit = 0.;
    for (int i = 0; i < 80; i++) { float h = map(ro + rd * d, t, m); if (h < .002) { hit = 1.; break; } d += h * .8; if (d > 13.) break; }
    float L = .02 + .1 * (1. - sp.y) + .04 * sin(sp.x * 9. + t * .4 + sin(sp.y * 7. - t * .3) * 2.);
    if (hit > .5) {
      float3 p = ro + rd * d; float2 e = float2(.003, 0.);
      float3 n = normalize(float3(map(p + e.xyy, t, m) - map(p - e.xyy, t, m), map(p + e.yxy, t, m) - map(p - e.yxy, t, m), map(p + e.yyx, t, m) - map(p - e.yyx, t, m)));
      float dif = max(dot(n, normalize(float3(-.5, .8, .6))), 0.);
      float rim = pow(1. - max(dot(n, -rd), 0.), 2.);
      L = .12 + .6 * dif + .55 * rim;
    }
    float clearZone = (1. - ss(u.clearTo.x, u.clearTo.x + .15, sp.x)) * (1. - ss(u.clearTo.y, u.clearTo.y + .12, sp.y));
    L *= 1. - clearZone;
    // Entrance: density grows outward from the centre instead of arriving at once.
    L *= ss(0., 1., u.reveal * 1.8 - length(uv) * .8);
    float on = step(b8(frag) + .001, clamp(L, 0., 1.));
    return float4(mix(u.paper.rgb, u.ink.rgb, on), 1.);
  }
  """
}
