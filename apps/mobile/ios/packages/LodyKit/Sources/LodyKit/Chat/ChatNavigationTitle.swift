import LodyDesignSystem
import CoreText
import SwiftUI
import UIKit

private func lineInk(_ attributed: NSAttributedString) -> CGRect {
  CTLineGetImageBounds(CTLineCreateWithAttributedString(attributed), nil)
}

private func inkBottom(text: String, font: UIFont) -> CGFloat {
  guard !text.isEmpty else { return 0 }
  let ink = lineInk(NSAttributedString(string: text, attributes: [.font: font]))
  return ceil(max(0, font.ascender - ink.origin.y))
}

@Observable
final class ChatNavigationTitleModel {
  var text = ""
}

struct ChatNavigationTitleBridge: View {
  var model: ChatNavigationTitleModel

  var body: some View {
    Text(model.text)
      .lodyTextStyle(.conversationTitle, fontOnly: true)
      .foregroundStyle(Color.primary)
      .lineLimit(1)
      .contentTransition(.numericText())
      .fixedSize(horizontal: true, vertical: true)
      .frame(maxWidth: .infinity, alignment: .topLeading)
  }
}

final class ChatNavigationTitleHost: UIView {
  private let model: ChatNavigationTitleModel
  private let hosting: UIHostingController<ChatNavigationTitleBridge>
  private var probe: ChatTitleTransitionProbe?
  private let overflowMask = CAGradientLayer()
  var onTransitionReport: ((String) -> Void)?

  var text: String { model.text }

  override init(frame: CGRect) {
    let model = ChatNavigationTitleModel()
    self.model = model
    hosting = UIHostingController(rootView: ChatNavigationTitleBridge(model: model))
    super.init(frame: frame)
    hosting.safeAreaRegions = []
    hosting.sizingOptions = []
    hosting.view.backgroundColor = .clear
    hosting.view.isOpaque = false
    hosting.view.insetsLayoutMarginsFromSafeArea = false
    hosting.view.clipsToBounds = false
    hosting.view.isUserInteractionEnabled = false
    hosting.view.isAccessibilityElement = false
    hosting.view.accessibilityElementsHidden = true
    clipsToBounds = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    addSubview(hosting.view)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(_ text: String, animated: Bool) {
    guard text != model.text else { return }
    let update = { self.model.text = text }
    defer { setNeedsLayout() }
    let motion = animated
      && !model.text.isEmpty
      && !text.isEmpty
      && !UIAccessibility.isReduceMotionEnabled
    if motion {
      withAnimation(.default, update)
      if LodyUIVerify.enabled { probe = ChatTitleTransitionProbe(host: self) }
    } else {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction, update)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let natural = (text as NSString).size(withAttributes: [.font: LodyTextStyle.conversationTitle.uiFont])
    let width = max(bounds.width, ceil(natural.width))
    let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
    hosting.view.frame = CGRect(x: rtl ? bounds.width - width : 0, y: 0, width: width, height: bounds.height)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if natural.width > bounds.width && bounds.width > 0 {
      overflowMask.frame = bounds
      overflowMask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
      overflowMask.locations = [0, NSNumber(value: Double(max(0, 1 - 24 / bounds.width))), 1]
      overflowMask.startPoint = CGPoint(x: rtl ? 1 : 0, y: 0.5)
      overflowMask.endPoint = CGPoint(x: rtl ? 0 : 1, y: 0.5)
      layer.mask = overflowMask
    } else {
      layer.mask = nil
    }
    CATransaction.commit()
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    hosting.sizeThatFits(
      in: CGSize(width: max(1, size.width), height: UIView.layoutFittingExpandedSize.height)
    )
  }
}

@MainActor
final class ChatTitleTransitionProbe: NSObject {
  private weak var host: ChatNavigationTitleHost?
  private var link: CADisplayLink?
  private var frames: [Data] = []
  private var detached = 0
  private let started = CACurrentMediaTime()

  init(host: ChatNavigationTitleHost) {
    self.host = host
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(sample(_:)))
    self.link = link
    link.add(to: .main, forMode: .common)
  }

  @objc private func sample(_ link: CADisplayLink) {
    guard let host, link.timestamp - started < 0.7 else { finish(); return }
    if host.window == nil { detached += 1 }
    let size = CGSize(width: max(1, host.bounds.width), height: max(1, host.bounds.height))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      host.layer.render(in: context.cgContext)
    }
    if let data = image.pngData() { frames.append(data) }
  }

  private func finish() {
    link?.invalidate(); link = nil
    guard let host, let first = frames.first, let last = frames.last else { return }
    let mid = frames.filter { $0 != first && $0 != last }.count
    host.onTransitionReport?("transition-frames:\(mid) detached:\(detached) sampled:\(frames.count)")
  }
}

final class ChatNavigationTitleButton: UIButton {
  let titleHost = ChatNavigationTitleHost()
  let captionLabel = UILabel()

  var displayedTitle: String { titleHost.text }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = false
    contentHorizontalAlignment = .leading
    titleLabel?.isHidden = true
    captionLabel.numberOfLines = 1
    captionLabel.lineBreakMode = .byTruncatingMiddle
    captionLabel.clipsToBounds = false
    captionLabel.isOpaque = false
    captionLabel.backgroundColor = .clear
    captionLabel.isUserInteractionEnabled = false
    captionLabel.isAccessibilityElement = false
    addSubview(titleHost)
    addSubview(captionLabel)
    titleHost.onTransitionReport = { [weak self] report in self?.accessibilityValue = report }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet {
      let alpha: CGFloat = isHighlighted ? 0.4 : 1
      titleHost.alpha = alpha
      captionLabel.alpha = alpha
    }
  }

  override var intrinsicContentSize: CGSize {
    sizeThatFits(CGSize(width: UIView.layoutFittingExpandedSize.width, height: 44))
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    let titleFont = LodyTextStyle.conversationTitle.uiFont
    let titleWidth = (titleHost.text as NSString).size(withAttributes: [.font: titleFont]).width
    let subtitleWidth = captionLabel.attributedText?.size().width ?? 0
    return CGSize(width: ceil(max(44, max(titleWidth, subtitleWidth))), height: 44)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // UIKit already supplies navigation spacing; use the full title allocation.
    let width = max(0, bounds.width)
    let x: CGFloat = 0
    let titleFont = LodyTextStyle.conversationTitle.uiFont
    let captionFont = UIFont.preferredFont(forTextStyle: .caption1)
    let titleLine = titleHost.text.isEmpty ? 0 : ceil(titleFont.lineHeight)
    let subtitleLine = captionLabel.isHidden ? 0 : ceil(captionFont.lineHeight)
    let titleHeight = titleLine == 0 ? 0 : ceil(max(
      titleLine,
      titleHost.sizeThatFits(CGSize(width: width, height: UIView.layoutFittingExpandedSize.height)).height
    ))
    let subtitleHeight = subtitleLine == 0 ? 0 : ceil(max(
      subtitleLine,
      captionLabel.sizeThatFits(CGSize(width: width, height: UIView.layoutFittingExpandedSize.height)).height
    ))
    let titleInk = titleLine == 0 ? 0 : inkBottom(text: titleHost.text, font: titleFont)
    let symbolOpticalPad: CGFloat = 4
    let captionInkPad = subtitleLine == 0
      ? 0
      : max(0, round(captionFont.ascender - captionFont.capHeight) + symbolOpticalPad)
    let spacing: CGFloat = titleLine > 0 && subtitleLine > 0 ? 8 : 0
    let stackHeight = titleInk + spacing + subtitleHeight - captionInkPad
    let y = max(0, (bounds.height - stackHeight) / 2)
    titleHost.frame = CGRect(x: x, y: y, width: width, height: titleHeight)
    titleHost.isHidden = titleHeight == 0
    captionLabel.frame = CGRect(
      x: x,
      y: y + titleInk + spacing - captionInkPad,
      width: width,
      height: subtitleHeight
    )
  }
}

@MainActor
enum ChatNavigationTitle {
  static func plainSubtitle(project: String, machine: String, branch: String = "") -> String {
    [branch, project, machine].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  static func configureButton(_ button: ChatNavigationTitleButton, title: String, subtitle: String, machine: String = "", branch: String = "", machineState: String = "", tabSymbol: String? = nil) {
    button.titleHost.apply(title, animated: true)
    button.captionLabel.lineBreakMode = branch.isEmpty || !machineState.isEmpty ? .byTruncatingMiddle : .byTruncatingTail
    if let tabSymbol, !subtitle.isEmpty {
      let font = UIFont.preferredFont(forTextStyle: .caption1)
      let text = NSMutableAttributedString(string: subtitle + " ", attributes: [.font: font, .foregroundColor: UIColor.secondaryLabel])
      let tint: UIColor = tabSymbol == "exclamationmark.circle" ? .systemRed : .systemBlue
      if let icon = symbolAttachment(tabSymbol, font: font, color: tint) { text.append(NSAttributedString(attachment: icon)) }
      button.captionLabel.attributedText = text
      button.captionLabel.isHidden = false
    } else if let attributed = attributedSubtitle(project: subtitle, machine: machine, branch: branch, machineState: machineState) {
      button.captionLabel.attributedText = NSAttributedString(attributed)
      button.captionLabel.isHidden = false
    } else {
      button.captionLabel.attributedText = nil
      button.captionLabel.isHidden = true
    }
    let status = machineState.isEmpty ? "" : String(localized: String.LocalizationValue("devices." + machineState), bundle: .lody)
    button.accessibilityLabel = [title, branch, subtitle, machine, status].filter { !$0.isEmpty }.joined(separator: ", ")
    button.sizeToFit()
    button.bounds.size.height = 44
  }

  static func apply(title: String, subtitle: String, button: UIButton, to item: UINavigationItem) {
    clearNativeSubtitle(item)
    item.style = .browser
    let header = LodyNavigationHeader.of(item)
    header.title = title.isEmpty ? nil : title
    header.titleView = button
  }

  static func preserveSubtitle(_ subtitle: String, on item: UINavigationItem) {
    item.subtitle = subtitle.isEmpty ? nil : subtitle
  }

  static func clearNativeSubtitle(_ item: UINavigationItem) {
    item.subtitle = nil
  }

  static func setDisappearing(_ disappearing: Bool, on item: UINavigationItem) {
    LodyNavigationHeader.of(item).suspended = disappearing
  }

  static func detach(button: UIButton, from item: UINavigationItem) {
    let header = LodyNavigationHeader.of(item)
    guard header.titleView === button else { return }
    header.title = nil
    header.titleView = nil
    if item.titleView === button {
      item.titleView = nil
    }
  }

  private static func attributedSubtitle(project: String, machine: String, branch: String, machineState: String) -> AttributedString? {
    let font = UIFont.preferredFont(forTextStyle: .caption1)
    let color = UIColor.secondaryLabel
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color,
    ]
    let text = NSMutableAttributedString()
    func append(_ name: String, symbol: String) {
      guard !name.isEmpty else { return }
      if text.length > 0 {
        text.append(NSAttributedString(string: " · ", attributes: attributes))
      }
      if let attachment = symbolAttachment(symbol, font: font, color: color) {
        text.append(NSAttributedString(attachment: attachment))
        text.append(NSAttributedString(string: " ", attributes: attributes))
      }
      text.append(NSAttributedString(string: name, attributes: attributes))
    }
    append(branch, symbol: "arrow.triangle.branch")
    append(project, symbol: "folder")
    if !machine.isEmpty {
      let symbol = machineState == "online" ? "checkmark.circle" : machineState == "offline" ? "circle.slash" : "questionmark.circle"
      append(machine, symbol: symbol)
    }
    return text.length == 0 ? nil : AttributedString(text)
  }

  private static func symbolAttachment(_ name: String, font: UIFont, color: UIColor) -> NSTextAttachment? {
    let size = max(1, font.pointSize - 3)
    let image = UIImage(
      systemName: name,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .regular, scale: .small)
    )?.withTintColor(color, renderingMode: .alwaysOriginal)
    guard let image else { return nil }
    let drawn = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
      image.draw(in: CGRect(origin: .zero, size: CGSize(width: size, height: size)))
    }
    let attachment = NSTextAttachment()
    attachment.image = drawn
    attachment.bounds = CGRect(x: 0, y: (font.capHeight - size) / 2, width: size, height: size)
    return attachment
  }
}
