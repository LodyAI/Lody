import AVFoundation
import UIKit

/// The target Mac's DeviceKit bezel and geometry, in PNG pixels. Without it the
/// display is shown alone; a drawn body would misstate the real hardware.
struct SimulatorExterior {
  let size: CGSize
  let screen: CGRect
  let radius: CGFloat
  let buttons: [(id: String, frame: CGRect)]
  let image: UIImage?

  static func plain(_ size: CGSize) -> SimulatorExterior {
    SimulatorExterior(size: size, screen: CGRect(origin: .zero, size: size), radius: 0, buttons: [], image: nil)
  }
}

@MainActor final class SimulatorDeviceView: UIView {
  final class DisplayView: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
  }

  let exterior: SimulatorExterior
  let display = DisplayView()
  let seed = UIImageView()
  private let bezel = UIImageView()
  private var buttons: [(UIButton, CGRect)] = []
  var onButton: ((String) -> Void)?
  var canvasSize: CGSize { exterior.size }
  var bodyFrame: CGRect { exterior.image == nil ? display.frame : bounds }
  var bodyCornerRadius: CGFloat {
    let scale = bounds.width / max(exterior.size.width, 1)
    return exterior.image == nil ? display.layer.cornerRadius : (exterior.radius + exterior.screen.minX) * scale
  }

  init(exterior: SimulatorExterior) {
    self.exterior = exterior
    super.init(frame: .zero)
    bezel.image = exterior.image
    bezel.isUserInteractionEnabled = false
    addSubview(bezel)
    for item in [seed, display] {
      item.clipsToBounds = true
      item.layer.cornerCurve = .continuous
      item.isUserInteractionEnabled = false
      addSubview(item)
    }
    seed.contentMode = .scaleAspectFill
    display.displayLayer.videoGravity = .resizeAspectFill
    for item in exterior.buttons {
      let button = UIButton(type: .custom)
      button.accessibilityLabel = Self.label(item.id)
      button.accessibilityIdentifier = "simulator-button:\(item.id)"
      button.addAction(UIAction { [weak self] _ in self?.onButton?(item.id) }, for: .touchUpInside)
      addSubview(button)
      buttons.append((button, item.frame))
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = bounds.width / max(exterior.size.width, 1)
    func scaled(_ rect: CGRect) -> CGRect {
      CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale)
    }
    bezel.frame = bounds
    for item in [seed, display] as [UIView] {
      item.frame = scaled(exterior.screen)
      item.layer.cornerRadius = exterior.radius * scale
    }
    for (button, frame) in buttons {
      let target = scaled(frame)
      button.frame = target.insetBy(dx: min(0, (target.width - 44) / 2), dy: min(0, (target.height - 44) / 2))
    }
  }

  private static func label(_ id: String) -> String {
    let key = "native.simulator.button.\(id)"
    let text = String(localized: String.LocalizationValue(key), bundle: .lody)
    return text == key ? id : text
  }
}
