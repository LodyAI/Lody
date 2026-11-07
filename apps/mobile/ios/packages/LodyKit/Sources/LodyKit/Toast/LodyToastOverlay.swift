import UIKit

/// Toasts use their own window so failures remain visible above presented sheets.
@MainActor
enum LodyToastOverlay {
  static let shared = Host()
  // Extensions cannot enumerate UIApplication scenes; their host sets this.
  static weak var scene: UIWindowScene?

  @MainActor
  final class Host {
    fileprivate var window: PassThroughWindow?
    fileprivate let canvas = Canvas()

    func show(
      message: String,
      kind: String,
      actionTitle: String? = nil,
      action: (() -> Void)? = nil
    ) {
      guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      attachIfNeeded()
      window?.isHidden = false
      window?.layoutIfNeeded()
      canvas.enqueue(message, kind: kind, actionTitle: actionTitle, action: action)
    }

    func dismiss() {
      canvas.dismiss()
    }

    var hostedWindow: UIWindow? { window }

    func performFrontAction() {
      canvas.performFrontAction()
    }

    func showBanner(title: String, kind: String) {
      guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      attachIfNeeded()
      window?.isHidden = false
      window?.layoutIfNeeded()
      canvas.showBanner(title: title, kind: kind)
    }

    func dismissBanner() {
      canvas.dismissBanner()
    }
  }

  fileprivate final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
      let hit = super.hitTest(point, with: event)
      if hit == self || hit == rootViewController?.view { return nil }
      return hit
    }
  }

  fileprivate final class Canvas: UIView {
    private var pills: [LodyToastPillView] = []
    private var timer: Timer?
    private var bannerTimer: Timer?
    private var banner: LodySessionBannerView?
    private var dragOffset: CGFloat = 0

    override init(frame: CGRect) {
      super.init(frame: frame)
      backgroundColor = .clear
      isOpaque = false
      addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(handlePan)))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
      let hit = super.hitTest(point, with: event)
      return hit === self ? nil : hit
    }

    func enqueue(
      _ message: String,
      kind: String,
      actionTitle: String? = nil,
      action: (() -> Void)? = nil
    ) {
      if action == nil, pills.last?.message == message {
        restartTimer()
        return
      }
      let symbol: String
      let tint: UIColor
      switch kind {
      case "error": symbol = "exclamationmark.circle.fill"; tint = .systemRed
      case "warning": symbol = "exclamationmark.triangle.fill"; tint = .systemOrange
      default: symbol = "checkmark"; tint = .secondaryLabel
      }
      let pill = LodyToastPillView(message: message, symbol: symbol, tint: tint, actionTitle: actionTitle)
      pill.onAction = { [weak self] in
        action?()
        self?.dismiss()
      }
      addSubview(pill)
      pills.append(pill)
      while pills.count > 3 { pills.removeFirst().removeFromSuperview() }
      dragOffset = 0
      layoutPills(entering: pill)
      restartTimer()
      UIAccessibility.post(notification: .announcement, argument: message)
      UINotificationFeedbackGenerator().notificationOccurred(kind == "error" ? .error : .success)
    }

    func showBanner(title: String, kind: String) {
      guard let parsed = LodySessionBannerKind(rawValue: kind) else { return }
      bannerTimer?.invalidate()
      bannerTimer = nil
      banner?.removeFromSuperview()
      let view = LodySessionBannerView(title: title, kind: parsed)
      view.onTap = { [weak self] in self?.dismissBanner() }
      view.onDismiss = { [weak self] in self?.dismissBanner() }
      addSubview(view)
      banner = view
      layoutBanner(entering: view)
      if !parsed.sticky {
        let duration: TimeInterval = UIAccessibility.isVoiceOverRunning ? 6 : 4
        bannerTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
          MainActor.assumeIsolated { self?.dismissBanner() }
        }
      }
      UIAccessibility.post(notification: .announcement, argument: view.accessibilityLabel)
      UINotificationFeedbackGenerator().notificationOccurred(parsed.feedback)
    }

    func dismissBanner() {
      bannerTimer?.invalidate()
      bannerTimer = nil
      guard let view = banner else {
        hideIfEmpty()
        return
      }
      banner = nil
      view.isUserInteractionEnabled = false
      UIView.animate(
        withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.2,
        delay: 0, options: [.beginFromCurrentState, .curveEaseIn]
      ) {
        view.alpha = 0
        view.transform = view.transform.translatedBy(x: 0, y: -8)
      } completion: { [weak self] _ in
        view.removeFromSuperview()
        self?.hideIfEmpty()
      }
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      layoutPills()
      layoutBanner()
    }

    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
      if let banner, banner.frame.contains(gesture.location(in: self)) { return false }
      if hitTest(gesture.location(in: self), with: nil) is UIButton { return false }
      return !pills.isEmpty
    }

    // On an active book fold, toasts center on the trailing pane instead
    // of straddling the hinge.
    private var toastBand: CGRect {
      var band = bounds.inset(by: safeAreaInsets)
      #if compiler(>=6.4)
      if #available(iOS 27.1, *) {
        let folds = reservedRegions(kind: .division, options: [])
        if let fold = folds.first(where: { $0.frame.height >= bounds.height - 1 }) {
          if effectiveUserInterfaceLayoutDirection == .rightToLeft {
            band.size.width = min(band.maxX, fold.frame.minX) - band.minX
          } else {
            let minX = max(band.minX, fold.frame.maxX)
            band.size.width = band.maxX - minX
            band.origin.x = minX
          }
        }
      }
      #endif
      return band.width > 0 ? band : bounds
    }

    private func layoutPills(entering: LodyToastPillView? = nil) {
      guard let front = pills.last else { return }
      let reduced = UIAccessibility.isReduceMotionEnabled
      let band = toastBand
      let size = front.fittedSize(maxWidth: min(band.width - 32, 360))
      for (index, pill) in pills.reversed().enumerated() {
        let depth = CGFloat(index)
        let scale = 1 - depth * 0.05
        let center = CGPoint(
          x: band.midX,
          y: safeAreaInsets.top + 8 + size.height / 2 + depth * 6 + dragOffset
        )
        pill.isUserInteractionEnabled = index == 0
        pill.showsContent = index == 0
        pill.layer.zPosition = CGFloat(3 - index)
        if pill === entering {
          pill.bounds = CGRect(origin: .zero, size: size)
          pill.center = center
          pill.transform = reduced ? .identity : CGAffineTransform(translationX: 0, y: -10)
            .scaledBy(x: 0.96, y: 0.96)
          pill.alpha = 0
        }
        let changes = {
          pill.bounds = CGRect(origin: .zero, size: size)
          pill.center = center
          pill.transform = CGAffineTransform(scaleX: scale, y: scale)
          pill.alpha = 1 - depth * 0.12
        }
        if entering != nil && !reduced {
          UIView.animate(
            withDuration: 0.35, delay: 0,
            usingSpringWithDamping: 0.88, initialSpringVelocity: 0,
            options: [.beginFromCurrentState, .allowUserInteraction], animations: changes
          )
        } else {
          changes()
        }
      }
    }

    private func restartTimer() {
      timer?.invalidate()
      let voiceOver = UIAccessibility.isVoiceOverRunning
      let duration: TimeInterval
      if pills.last?.hasAction == true {
        duration = voiceOver ? 8 : 5
      } else if voiceOver {
        duration = 6
      } else {
        duration = 3.2
      }
      timer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { self?.dismiss() }
      }
    }

    func performFrontAction() {
      pills.last?.triggerAction()
    }

    func dismiss() {
      timer?.invalidate()
      timer = nil
      let departing = pills
      pills.removeAll()
      dragOffset = 0
      for pill in departing { pill.isUserInteractionEnabled = false }
      UIView.animate(
        withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.2,
        delay: 0, options: [.beginFromCurrentState, .curveEaseIn]
      ) {
        for pill in departing {
          pill.alpha = 0
          pill.transform = pill.transform.translatedBy(x: 0, y: -6)
        }
      } completion: { [weak self] _ in
        departing.forEach { $0.removeFromSuperview() }
        self?.hideIfEmpty()
      }
    }

    private func hideIfEmpty() {
      if subviews.isEmpty { LodyToastOverlay.shared.window?.isHidden = true }
    }

    private func layoutBanner(entering: LodySessionBannerView? = nil) {
      guard let banner else { return }
      let reduced = UIAccessibility.isReduceMotionEnabled
      let band = toastBand
      let size = banner.fittedSize(maxWidth: min(band.width - 20, 400))
      let center = CGPoint(
        x: band.midX,
        y: safeAreaInsets.top + 8 + size.height / 2
      )
      if banner === entering {
        banner.bounds = CGRect(origin: .zero, size: size)
        banner.center = center
        banner.transform = reduced ? .identity : CGAffineTransform(translationX: 0, y: -10)
          .scaledBy(x: 0.96, y: 0.96)
        banner.alpha = 0
        let changes = {
          banner.bounds = CGRect(origin: .zero, size: size)
          banner.center = center
          banner.transform = .identity
          banner.alpha = 1
        }
        if reduced {
          changes()
        } else {
          UIView.animate(
            withDuration: 0.35, delay: 0,
            usingSpringWithDamping: 0.88, initialSpringVelocity: 0,
            options: [.beginFromCurrentState, .allowUserInteraction], animations: changes
          )
        }
        return
      }
      banner.bounds = CGRect(origin: .zero, size: size)
      banner.center = center
    }

    override func accessibilityPerformEscape() -> Bool {
      if banner != nil {
        dismissBanner()
        return true
      }
      guard !pills.isEmpty else { return false }
      dismiss()
      return true
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
      let translation = gesture.translation(in: self).y
      switch gesture.state {
      case .began:
        timer?.invalidate()
      case .changed:
        dragOffset = translation < 0 ? translation : translation / (translation + 120) * 40
        layoutPills()
      case .ended, .cancelled:
        if gesture.state == .ended && (translation < -40 || gesture.velocity(in: self).y < -600) {
          dismiss()
        } else {
          dragOffset = 0
          UIView.animate(
            withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.3,
            delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0,
            options: [.beginFromCurrentState, .allowUserInteraction]
          ) { self.layoutPills() }
          restartTimer()
        }
      default:
        break
      }
    }
  }
}

extension LodyToastOverlay.Host {
  fileprivate func attachIfNeeded() {
    if window != nil { return }
    #if LODY_SHARE_EXTENSION
    let scenes = [LodyToastOverlay.scene].compactMap { $0 }
    #else
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    #endif
    let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
    let win: LodyToastOverlay.PassThroughWindow
    if let scene {
      win = LodyToastOverlay.PassThroughWindow(windowScene: scene)
      win.frame = scene.coordinateSpace.bounds
    } else {
      win = LodyToastOverlay.PassThroughWindow(frame: UIScreen.main.bounds)
    }
    win.windowLevel = .alert + 1
    win.backgroundColor = .clear
    let root = UIViewController()
    root.view.backgroundColor = .clear
    canvas.translatesAutoresizingMaskIntoConstraints = false
    root.view.addSubview(canvas)
    NSLayoutConstraint.activate([
      canvas.topAnchor.constraint(equalTo: root.view.topAnchor),
      canvas.bottomAnchor.constraint(equalTo: root.view.bottomAnchor),
      canvas.leadingAnchor.constraint(equalTo: root.view.leadingAnchor),
      canvas.trailingAnchor.constraint(equalTo: root.view.trailingAnchor),
    ])
    win.rootViewController = root
    win.isHidden = false
    window = win
  }
}
