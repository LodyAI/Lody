import UIKit
import MetalKit

struct ChatComposerOption: Decodable {
  let id: String
  let title: String
  var description: String?
}

struct ChatComposerOptions: Decodable {
  var modelId = ""
  var effort = ""
  var permissionId: String?
  var permissions: [ChatComposerOption]?
  var fast: Bool?
  var models: [ChatComposerOption] = []
  var efforts: [ChatComposerOption] = []
  /// Asset name of the running assistant's mark; the model chip leads with it, like web's
  /// mobile run-config chip. Absent in chats, which show the model alone.
  var agentAsset: String?
  var agentName: String?
  /// The Agent Role the composer is (new chat): its emoji leads the chip, and its name too when it fits.
  var roleEmoji: String?
  var roleName: String?
}

extension ChatComposerOptions {
  var modelTitle: String {
    models.first { $0.id == modelId }?.title
      ?? (modelId.isEmpty ? String(localized: "native.chat.composer.defaultModel", bundle: .lody) : modelId)
  }
  var effortTitle: String {
    let title = efforts.first { $0.id == effort }?.title ?? effort
    switch title.lowercased() {
    case "": return String(localized: "native.chat.composer.defaultEffort", bundle: .lody)
    case "xhigh": return "Extra High"
    default: return title.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  var orderedEfforts: [ChatComposerOption] {
    let rank = [
      "off": 0, "none": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6, "ultra": 7,
    ]
    return efforts.enumerated().sorted { lhs, rhs in
      let left = rank[lhs.element.id.lowercased()]
      let right = rank[rhs.element.id.lowercased()]
      if let left, let right { return left < right }
      if left != nil { return true }
      if right != nil { return false }
      return lhs.offset < rhs.offset
    }.map(\.element)
  }
}

private struct ChatEffortHeatUniforms {
  var track: SIMD4<Float>
  var accent: SIMD4<Float>
  var violet: SIMD4<Float>
  var dotOff: SIMD4<Float>
  var frame: SIMD4<Float>
  var clock: SIMD4<Float>
  var thumb: SIMD4<Float>
}

private extension UIColor {
  func shaderColor(_ traits: UITraitCollection) -> SIMD4<Float> {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return SIMD4(Float(red), Float(green), Float(blue), Float(alpha))
  }
}

// Draws the whole slider because the heat haze bends the slider's own pixels.
// The display link runs only while the thumb spring, a state fade or visible Ultra/Fast energy needs frames.
private final class ChatEffortHeat: MTKView, MTKViewDelegate {
  static let violet = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0.70, green: 0.61, blue: 0.91, alpha: 1)
      : UIColor(red: 0.48, green: 0.36, blue: 0.70, alpha: 1)
  }
  private static let renderer: (MTLDevice, MTLCommandQueue, MTLRenderPipelineState)? = {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
    do {
      #if SWIFT_PACKAGE
      let bundle = Bundle.module
      #else
      guard let url = Bundle(for: ChatComposerModelPanel.self).url(forResource: "LodyKitShaders", withExtension: "bundle"),
        let bundle = Bundle(url: url)
      else { throw CocoaError(.fileNoSuchFile) }
      #endif
      let library = try device.makeDefaultLibrary(bundle: bundle)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "heatVertex")
      descriptor.fragmentFunction = library.makeFunction(name: "heatFragment")
      descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
      return (device, queue, try device.makeRenderPipelineState(descriptor: descriptor))
    } catch {
      NSLog("Effort heat shader unavailable: %@", String(describing: error))
      return nil
    }
  }()
  static var isAvailable: Bool { renderer != nil }

  var fraction: Float = 0 { didSet { if fraction != oldValue { wake() } } }
  var steps: Float = 1 { didSet { if steps != oldValue { wake() } } }
  var ultra = false { didSet { if ultra != oldValue { wake() } } }
  var fast = false { didSet { if fast != oldValue { wake() } } }
  var motion = false { didSet { if motion != oldValue { wake() } } }
  private var thumb: Float?
  private var velocity: Float = 0
  private var ultraAmount: Float = 0
  private var fastAmount: Float = 0
  private var flow: Float = 0
  private var lastFrame: CFTimeInterval?

  init() {
    super.init(frame: .zero, device: Self.renderer?.0)
    isOpaque = false
    backgroundColor = .clear
    clearColor = MTLClearColorMake(0, 0, 0, 0)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    preferredFramesPerSecond = 60
    isPaused = true
    delegate = self
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: ChatEffortHeat, _) in
      view.wake()
    }
  }
  required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { isPaused = true } else { wake() }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    wake()
  }
  func wake() {
    guard window != nil, isPaused, Self.renderer != nil else { return }
    lastFrame = nil
    isPaused = false
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}
  func draw(in view: MTKView) {
    guard let (_, queue, pipeline) = Self.renderer, bounds.width > 32 else {
      isPaused = true
      return
    }
    let now = CACurrentMediaTime()
    let dt = Float(min(1.0 / 20, lastFrame.map { now - $0 } ?? 1.0 / 60))
    lastFrame = now
    let settled = advance(dt)
    if let descriptor = currentRenderPassDescriptor, let drawable = currentDrawable,
      let command = queue.makeCommandBuffer(), let encoder = command.makeRenderCommandEncoder(descriptor: descriptor)
    {
      var uniforms = makeUniforms()
      encoder.setRenderPipelineState(pipeline)
      encoder.setFragmentBytes(&uniforms, length: MemoryLayout<ChatEffortHeatUniforms>.stride, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      encoder.endEncoding()
      command.present(drawable)
      command.commit()
    }
    if settled { isPaused = true }
  }

  private var target: Float { 16 + fraction * max(0, Float(bounds.width) - 32) }

  private func advance(_ dt: Float) -> Bool {
    let goal = target
    let goalUltra: Float = ultra ? 1 : 0
    let goalFast: Float = fast ? 1 : 0
    guard motion, var position = thumb else {
      thumb = goal
      velocity = 0
      ultraAmount = goalUltra
      fastAmount = goalFast
      return !(motion && (ultra || fast))
    }
    let stiffness: Float = 520
    let damping = 2 * stiffness.squareRoot() * 0.62
    for _ in 0..<4 {
      velocity += (stiffness * (goal - position) - damping * velocity) * dt / 4
      position += velocity * dt / 4
    }
    let springing = abs(goal - position) > 0.05 || abs(velocity) > 0.5
    if !springing {
      position = goal
      velocity = 0
    }
    thumb = position
    let ease = 1 - exp(-dt * 7)
    ultraAmount += (goalUltra - ultraAmount) * ease
    fastAmount += (goalFast - fastAmount) * ease
    let fading = abs(goalUltra - ultraAmount) > 0.002 || abs(goalFast - fastAmount) > 0.002
    if !fading {
      ultraAmount = goalUltra
      fastAmount = goalFast
    }
    // Float noise inputs lose precision as flow grows; wrapping costs one pattern jump every few minutes of animation.
    flow = (flow + dt * (1 + 1.4 * fastAmount)).truncatingRemainder(dividingBy: 600)
    return !springing && !fading && !ultra && !fast
  }

  private func makeUniforms() -> ChatEffortHeatUniforms {
    let width = Float(bounds.width)
    let position = thumb ?? target
    return ChatEffortHeatUniforms(
      track: UIColor.tertiarySystemFill.shaderColor(traitCollection),
      accent: UIColor.lodyAccent.shaderColor(traitCollection),
      violet: Self.violet.shaderColor(traitCollection),
      dotOff: UIColor.tertiaryLabel.shaderColor(traitCollection),
      frame: SIMD4(width, Float(bounds.height), Float(drawableSize.width) / width, 0),
      clock: SIMD4(flow, ultraAmount, fastAmount, steps),
      thumb: SIMD4(position, (position - 16) / max(1, width - 32), min(1500, max(-1500, velocity)), 0)
    )
  }
}

final class ChatEffortSlider: UIControl {
  var steps = 1 { didSet { heat.steps = Float(steps); setNeedsDisplay() } }
  var value: Float = 0 { didSet { heat.fraction = value; setNeedsDisplay() } }
  var isFast = false { didSet { heat.fast = isFast } }
  var isUltra = false { didSet { heat.ultra = isUltra; setNeedsDisplay() } }
  private let heat = ChatEffortHeat()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isOpaque = false
    isAccessibilityElement = true
    accessibilityTraits = .adjustable
    heat.isHidden = !ChatEffortHeat.isAvailable
    addSubview(heat)
    for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(energyEnvironmentChanged(_:)), name: name, object: nil)
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit { NotificationCenter.default.removeObserver(self) }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateEnergy()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    heat.frame = bounds
    updateEnergy()
  }
  @objc private func energyEnvironmentChanged(_ notification: Notification) {
    updateEnergy(suspended: notification.name == UIApplication.willResignActiveNotification)
  }
  private func updateEnergy(suspended: Bool = false) {
    heat.motion = window != nil && !isHidden && !suspended && window?.windowScene?.activationState == .foregroundActive && !UIAccessibility.isReduceMotionEnabled
  }

  override func draw(_ rect: CGRect) {
    guard !ChatEffortHeat.isAvailable else { return }
    let track = CGRect(x: 0, y: (bounds.height - 28) / 2, width: bounds.width, height: 28)
    let thumbX = 16 + CGFloat(value) * max(0, bounds.width - 32)
    let path = UIBezierPath(roundedRect: track, cornerRadius: 14)
    UIColor.tertiarySystemFill.setFill()
    path.fill()
    let context = UIGraphicsGetCurrentContext()
    context?.saveGState()
    path.addClip()
    (isUltra ? ChatEffortHeat.violet : UIColor.lodyAccent).setFill()
    UIRectFill(CGRect(x: 0, y: track.minY, width: thumbX, height: track.height))
    for index in 0...steps {
      let x = 16 + CGFloat(index) / CGFloat(steps) * max(0, bounds.width - 32)
      (x <= thumbX ? UIColor.white.withAlphaComponent(0.4) : UIColor.tertiaryLabel).setFill()
      UIBezierPath(ovalIn: CGRect(x: x - 2.5, y: bounds.midY - 2.5, width: 5, height: 5)).fill()
    }
    context?.restoreGState()
    context?.saveGState()
    context?.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: UIColor.black.withAlphaComponent(0.12).cgColor)
    UIColor.white.setFill()
    UIBezierPath(ovalIn: CGRect(x: thumbX - 16, y: bounds.midY - 16, width: 32, height: 32)).fill()
    context?.restoreGState()

  }

  private func move(to point: CGPoint) {
    let fraction = max(0, min(1, (point.x - 16) / max(1, bounds.width - 32)))
    setStep(Int((fraction * CGFloat(steps)).rounded()))
  }
  private func setStep(_ step: Int) {
    let next = Float(min(steps, max(0, step))) / Float(steps)
    guard value != next else { return }
    value = next
    sendActions(for: .valueChanged)
  }
  override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    move(to: touch.location(in: self))
    return true
  }
  override func continueTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    move(to: touch.location(in: self))
    return true
  }
  override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
    if let touch { move(to: touch.location(in: self)) }
  }
  override func accessibilityIncrement() { setStep(Int((value * Float(steps)).rounded()) + 1) }
  override func accessibilityDecrement() { setStep(Int((value * Float(steps)).rounded()) - 1) }
}

final class ChatComposerModelPanel: UIViewController, UIPopoverPresentationControllerDelegate {
  var onModel: ((String) -> Void)?
  var onEffort: ((String) -> Void)?
  var onFast: ((Bool) -> Void)?
  private var options = ChatComposerOptions()
  private let model = UIButton(type: .system)
  private let fast = UIButton(type: .system)
  private let slider = ChatEffortSlider()
  private lazy var modelLeading = model.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24)
  private lazy var modelTrailing = model.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .secondarySystemGroupedBackground
    fast.accessibilityIdentifier = "composer-fast"
    fast.accessibilityLabel = String(localized: "native.chat.composer.fast", bundle: .lody)
    fast.addTarget(self, action: #selector(toggleFast), for: .touchUpInside)
    model.showsMenuAsPrimaryAction = true
    model.accessibilityIdentifier = "composer-model-menu"
    slider.accessibilityLabel = String(localized: "native.chat.composer.effort", bundle: .lody)
    slider.accessibilityIdentifier = "composer-effort-slider"
    slider.addTarget(self, action: #selector(changeEffort), for: .valueChanged)
    for child in [model, slider, fast] {
      child.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(child)
    }
    NSLayoutConstraint.activate([
      fast.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
      fast.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
      fast.widthAnchor.constraint(equalToConstant: 44),
      fast.heightAnchor.constraint(equalToConstant: 44),
      modelLeading,
      modelTrailing,
      model.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
      model.heightAnchor.constraint(equalToConstant: 56),
      slider.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      slider.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      slider.topAnchor.constraint(equalTo: model.bottomAnchor, constant: 8),
      slider.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  func render(_ options: ChatComposerOptions) {
    self.options = options
    fast.isHidden = options.fast == nil
    modelLeading.constant = options.fast == nil ? 24 : 56
    modelTrailing.constant = -modelLeading.constant
    let enabled = options.fast == true
    var fastConfiguration = UIButton.Configuration.plain()
    fastConfiguration.image = UIImage(systemName: enabled ? "bolt.fill" : "bolt")
    fastConfiguration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)
    fastConfiguration.baseForegroundColor = enabled ? .lodyAccent : .secondaryLabel
    fastConfiguration.contentInsets = .zero
    if fast.configuration?.image != nil {
      fastConfiguration.symbolContentTransition = .init(.replace.byLayer)
    }
    fast.configuration = fastConfiguration
    fast.accessibilityTraits = enabled ? [.button, .selected] : [.button]
    fast.accessibilityValue = String(localized: String.LocalizationValue(enabled ? "native.chat.composer.fastOn" : "native.chat.composer.fastOff"), bundle: .lody)
    preferredContentSize = CGSize(width: 320, height: options.efforts.isEmpty ? 76 : 132)
    var configuration = UIButton.Configuration.plain()
    configuration.baseForegroundColor = options.effort.lowercased() == "ultra" ? ChatEffortHeat.violet : .lodyAccent
    configuration.title = options.effortTitle + " ›"
    configuration.subtitle = options.modelTitle
    configuration.titleAlignment = .center
    configuration.titleLineBreakMode = .byTruncatingTail
    configuration.subtitleLineBreakMode = .byTruncatingTail
    configuration.titleTextAttributesTransformer = .init { attributes in
      var attributes = attributes
      attributes.font = .preferredFont(forTextStyle: .headline)
      return attributes
    }
    configuration.subtitleTextAttributesTransformer = .init { attributes in
      var attributes = attributes
      attributes.font = .preferredFont(forTextStyle: .subheadline)
      attributes.foregroundColor = .secondaryLabel
      return attributes
    }
    model.configuration = configuration
    model.accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.composer.modelPicker", bundle: .lody), String(describing: options.effortTitle), String(describing: options.modelTitle))
    model.menu = UIMenu(children: [
      UIAction(title: String(localized: "native.chat.composer.defaultModel", bundle: .lody), state: options.modelId.isEmpty ? .on : .off) { [weak self] _ in self?.onModel?("") },
    ] + options.models.map { option in
      UIAction(title: option.title, state: option.id == options.modelId ? .on : .off) { [weak self] _ in self?.onModel?(option.id) }
    })
    let efforts = options.orderedEfforts
    slider.isHidden = efforts.isEmpty
    slider.steps = max(1, efforts.count)
    slider.value = Float(efforts.firstIndex { $0.id == options.effort }.map { $0 + 1 } ?? 0) / Float(max(1, efforts.count))
    slider.accessibilityValue = options.effortTitle
    slider.isFast = options.fast == true
    slider.isUltra = options.effort.lowercased() == "ultra" && !efforts.isEmpty
  }

  @objc private func toggleFast() {
    guard let current = options.fast else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    onFast?(!current)
  }

  @objc private func changeEffort() {
    let efforts = options.orderedEfforts
    let index = min(efforts.count, max(0, Int((slider.value * Float(efforts.count)).rounded())))
    slider.value = Float(index) / Float(max(1, efforts.count))
    let effort = index == 0 ? "" : efforts[index - 1].id
    guard effort != options.effort else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    onEffort?(effort)
  }

  func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle { .none }
}
