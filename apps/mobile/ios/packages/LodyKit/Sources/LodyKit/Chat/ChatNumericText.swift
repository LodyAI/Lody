import SwiftUI
import UIKit

@Observable
final class ChatNumericTextModel {
  var attributed = AttributedString()
  var value = ""
  var shines = false
  var color = Color.primary
}

struct ChatNumericTextBridge: View {
  var model: ChatNumericTextModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !model.shines || reduceMotion)) { context in
      let period = 1.5
      let progress = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
      let highlight = model.shines && !reduceMotion ? model.color.mix(with: .white, by: 0.64) : model.color
      Text(model.attributed)
        .foregroundStyle(LinearGradient(
          stops: [
            .init(color: model.color, location: 0.25),
            .init(color: highlight, location: 0.5),
            .init(color: model.color, location: 0.75),
          ],
          startPoint: UnitPoint(x: -1 + 2 * progress, y: 0),
          endPoint: UnitPoint(x: 2 * progress, y: 0)
        ))
        .multilineTextAlignment(.leading)
        .contentTransition(.numericText())
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }
}

final class ChatNumericTextHost: UIView {
  private let model: ChatNumericTextModel
  private let hosting: UIHostingController<ChatNumericTextBridge>

  override init(frame: CGRect) {
    let model = ChatNumericTextModel()
    self.model = model
    hosting = UIHostingController(rootView: ChatNumericTextBridge(model: model))
    super.init(frame: frame)
    hosting.safeAreaRegions = []
    hosting.sizingOptions = []
    hosting.view.backgroundColor = .clear
    hosting.view.isOpaque = false
    hosting.view.insetsLayoutMarginsFromSafeArea = false
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

  func apply(text: NSAttributedString, animated: Bool, shines: Bool) {
    let styled = NSMutableAttributedString(attributedString: text)
    let color = text.length > 0 ? text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor : nil
    styled.removeAttribute(.foregroundColor, range: NSRange(location: 0, length: styled.length))
    let attributed = AttributedString(styled)
    let value = text.string
    let update = {
      self.model.attributed = attributed
      self.model.value = value
      self.model.shines = shines
      self.model.color = Color(uiColor: color ?? .label)
    }
    let motion = animated
      && window != nil
      && !value.isEmpty
      && !model.value.isEmpty
      && model.value != value
      && !UIAccessibility.isReduceMotionEnabled
    if motion {
      withAnimation(.default, update)
    } else {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction, update)
    }
  }

  func reset() {
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      model.attributed = AttributedString()
      model.value = ""
      model.shines = false
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    hosting.view.frame = bounds
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    hosting.sizeThatFits(
      in: CGSize(width: max(1, size.width), height: UIView.layoutFittingExpandedSize.height)
    )
  }
}
