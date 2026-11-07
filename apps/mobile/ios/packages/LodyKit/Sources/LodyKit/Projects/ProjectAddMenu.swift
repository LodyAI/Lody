import LodyDesignSystem
import UIKit

/// The Projects tab's add button, opened: two Liquid Glass capsules spring up from the bottom-
/// trailing create button — Add local folder, Add GitHub repository — over a soft dim. A tap
/// outside (or on the create button again) folds them back. Android: `ProjectAddMenu`.
@MainActor
final class ProjectAddMenu: UIView {
  private let dim = UIView()
  private let stack = UIStackView()
  private var options: [UIView] = []

  /// The menu shown in `host`, if any.
  static func shown(in host: UIView) -> ProjectAddMenu? { host.subviews.compactMap { $0 as? ProjectAddMenu }.first }

  @discardableResult
  static func present(in host: UIView, above bar: UIView?, onLocal: @escaping () -> Void, onGitHub: @escaping () -> Void) -> ProjectAddMenu {
    let menu = ProjectAddMenu(onLocal: onLocal, onGitHub: onGitHub)
    menu.show(in: host, above: bar)
    return menu
  }

  private init(onLocal: @escaping () -> Void, onGitHub: @escaping () -> Void) {
    super.init(frame: .zero)
    accessibilityViewIsModal = true
    accessibilityIdentifier = "project-add-menu"
    dim.backgroundColor = UIColor.black.withAlphaComponent(0.18)
    dim.alpha = 0
    dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(dismissTapped)))
    stack.axis = .vertical
    stack.alignment = .trailing
    stack.spacing = LodySpacing.sm
    // Top to bottom: GitHub, then the local folder nearest the button.
    options = [
      Self.option(title: String(localized: "projects.add.github", bundle: .lody), icon: LodyIcon.github.uiImage, id: "project-add-github") { [weak self] in
        self?.close { onGitHub() }
      },
      Self.option(title: String(localized: "projects.add.local", bundle: .lody), icon: LodyIcon.folder.uiImage, id: "project-add-local") { [weak self] in
        self?.close { onLocal() }
      },
    ]
    options.forEach(stack.addArrangedSubview)
    for view in [dim, stack] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private static func option(title: String, icon: UIImage?, id: String, action: @escaping () -> Void) -> UIView {
    var configuration = UIButton.Configuration.glass()
    configuration.title = title
    configuration.image = icon?.withRenderingMode(.alwaysTemplate)
    configuration.imagePadding = LodySpacing.sm
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    configuration.cornerStyle = .capsule
    configuration.baseForegroundColor = .label
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 18, bottom: 12, trailing: 18)
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var next = attributes
      next.font = .dynamic(of: 16, weight: .semibold)
      return next
    }
    let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
    button.accessibilityIdentifier = id
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    return button
  }

  private func show(in host: UIView, above bar: UIView?) {
    translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(self)
    let bottom = bar.map { stack.bottomAnchor.constraint(equalTo: $0.topAnchor, constant: -LodySpacing.md) }
      ?? stack.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -72)
    NSLayoutConstraint.activate([
      topAnchor.constraint(equalTo: host.topAnchor), bottomAnchor.constraint(equalTo: host.bottomAnchor),
      leadingAnchor.constraint(equalTo: host.leadingAnchor), trailingAnchor.constraint(equalTo: host.trailingAnchor),
      dim.topAnchor.constraint(equalTo: topAnchor), dim.bottomAnchor.constraint(equalTo: bottomAnchor),
      dim.leadingAnchor.constraint(equalTo: leadingAnchor), dim.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -LodyLayout.screenPaddingX),
      bottom,
    ])
    host.layoutIfNeeded()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    let reduce = UIAccessibility.isReduceMotionEnabled
    // Each capsule grows out of the bottom-trailing button, the nearest first.
    for (index, view) in options.reversed().enumerated() {
      view.alpha = 0
      if !reduce { view.transform = Self.folded(view, rise: CGFloat(index + 1) * 28) }
      UIView.animate(springDuration: reduce ? 0.2 : 0.42, bounce: reduce ? 0 : 0.22, initialSpringVelocity: 0, delay: Double(index) * 0.045,
                     options: [.allowUserInteraction]) {
        view.alpha = 1
        view.transform = .identity
      }
    }
    UIView.animate(withDuration: 0.2) { self.dim.alpha = 1 }
    UIAccessibility.post(notification: .screenChanged, argument: options.last)
  }

  /// A capsule folded into the button: smaller, lower, anchored at its trailing edge.
  private static func folded(_ view: UIView, rise: CGFloat) -> CGAffineTransform {
    let width = view.bounds.width
    return CGAffineTransform(translationX: width * 0.2, y: rise).scaledBy(x: 0.6, y: 0.6)
  }

  @objc private func dismissTapped() { close() }

  /// Folds the capsules back into the button, then removes the menu and runs `then`.
  func close(then done: (() -> Void)? = nil) {
    isUserInteractionEnabled = false
    let finish = {
      self.removeFromSuperview()
      done?()
    }
    guard window != nil, !UIAccessibility.isReduceMotionEnabled else { return finish() }
    UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
      self.dim.alpha = 0
      for (index, view) in self.options.reversed().enumerated() {
        view.alpha = 0
        view.transform = Self.folded(view, rise: CGFloat(index + 1) * 20)
      }
    } completion: { _ in finish() }
  }
}
