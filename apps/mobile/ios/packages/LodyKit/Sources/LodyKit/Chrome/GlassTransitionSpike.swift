import ChatKit
import UIKit

/// Compare direct UIKit animation with the reversible production surface.
@MainActor final class GlassTransitionSpike: UIViewController {
  private static var spikeWindow: UIWindow?
  private let phase = UILabel()
  private var surfaces: [UIVisualEffectView] = []
  private var effects: [UIGlassEffect] = []
  private var events: [[String: Any]] = []
  private var started = false
  private var targetVisible = true
  private var generation = 0
  private var startTime = 0.0

  static func openIfRequested() {
    guard LodyUIVerify.enabled,
          LodyUIVerify.has("--glass-spike"),
          spikeWindow == nil,
          let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    window.rootViewController = GlassTransitionSpike()
    spikeWindow = window
    window.makeKeyAndVisible()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 20
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
    phase.text = "UIKit glass transition spike"
    phase.font = .preferredFont(forTextStyle: .headline)
    phase.accessibilityIdentifier = "glass-spike-phase"
    stack.addArrangedSubview(phase)
    for (index, title) in ["1 · isHidden", "2 · Whole-view alpha", "3 · effect = nil", "4 · Reversible glass in container"].enumerated() {
      let label = UILabel()
      label.text = title
      label.font = .preferredFont(forTextStyle: .subheadline)
      stack.addArrangedSubview(label)
      let backdrop = UIView()
      backdrop.heightAnchor.constraint(equalToConstant: 76).isActive = true
      // Contrasting edges make refraction distinguishable from plain fading.
      for stripe in 0..<8 {
        let band = UIView(frame: CGRect(x: stripe * 44, y: 0, width: 44, height: 76))
        band.backgroundColor = stripe.isMultiple(of: 2) ? .systemOrange : .systemBlue
        backdrop.addSubview(band)
      }
      backdrop.clipsToBounds = true
      stack.addArrangedSubview(backdrop)
      let effect = UIGlassEffect(style: .regular)
      effect.isInteractive = true
      effects.append(effect)
      let surface: UIVisualEffectView
      if index == 3 {
        let reversible = CKGlassSurface(interactive: true)
        reversible.setVisible(true, animated: false)
        surface = reversible
      } else {
        surface = UIVisualEffectView(effect: effect)
      }
      surface.cornerConfiguration = .capsule()
      surface.frame = CGRect(x: 50, y: 12, width: 230, height: 52)
      if index == 3 {
        let container = UIVisualEffectView(effect: UIGlassContainerEffect())
        container.frame = CGRect(x: 0, y: 0, width: 360, height: 76)
        backdrop.addSubview(container)
        container.contentView.addSubview(surface)
      } else {
        backdrop.addSubview(surface)
      }
      let button = UIButton(configuration: .plain())
      button.setTitle("↓  Scroll to bottom", for: .normal)
      button.frame = surface.bounds
      button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      surface.contentView.addSubview(button)
      surfaces.append(surface)
    }
    let run = UIButton(configuration: .borderedProminent())
    run.setTitle("Run comparison", for: .normal)
    run.accessibilityIdentifier = "glass-spike-run"
    run.heightAnchor.constraint(equalToConstant: 44).isActive = true
    run.addAction(UIAction { [weak self] _ in self?.run() }, for: .touchUpInside)
    stack.addArrangedSubview(run)
  }

  private func capture(_ name: String) {
    events.append([
      "event": name, "time": CACurrentMediaTime() - startTime,
      "surfaces": surfaces.map { surface in
        ["effect": surface.effect.map { String(describing: type(of: $0)) } ?? "nil",
         "hidden": surface.isHidden, "alpha": surface.alpha,
         "contentAlpha": surface.contentView.alpha,
         "interactive": surface.isUserInteractionEnabled] as [String: Any]
      },
    ])
  }

  private func transition(_ visible: Bool, duration: TimeInterval) {
    targetVisible = visible
    generation += 1
    let token = generation
    phase.text = visible ? "Materializing" : "Dematerializing"
    for surface in surfaces {
      surface.isUserInteractionEnabled = visible
      surface.accessibilityElementsHidden = !visible
      if visible { surface.isHidden = false }
    }
    surfaces[0].isHidden = !visible
    (surfaces[3] as! CKGlassSurface).setVisible(visible)
    UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.surfaces[1].alpha = visible ? 1 : 0
      self.surfaces[2].effect = visible ? self.effects[2] : nil
      self.surfaces[2].contentView.alpha = visible ? 1 : 0
    } completion: { _ in
      self.capture("completion-\(visible)-\(token)")
      guard self.generation == token else { return }
      // Leave surfaces mounted to expose any glass left behind by effect=nil.
      self.capture("settled-\(visible)")
    }
    capture("requested-\(visible)")
  }

  private func run() {
    guard !started else { return }
    started = true
    startTime = CACurrentMediaTime()
    capture("initial")
    let steps: [(Double, @MainActor @Sendable () -> Void)] = [
      (1, { self.transition(false, duration: 1) }),
      (3, { self.transition(true, duration: 1) }),
      (5, { self.transition(false, duration: 0.35) }),
      (6, { self.transition(true, duration: 0.35) }),
      (7, { self.transition(false, duration: 1) }),
      (7.15, { self.transition(true, duration: 0.35) }),
      (9, { self.finish() }),
    ]
    for (delay, action) in steps {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: action)
    }
  }

  private func finish() {
    precondition(targetVisible)
    precondition(surfaces.allSatisfy { !$0.isHidden && $0.alpha == 1 && $0.isUserInteractionEnabled })
    precondition(surfaces[2...3].allSatisfy { $0.effect is UIGlassEffect && $0.contentView.alpha == 1 })
    capture("final-visible-after-reversal")
    let report: [String: Any] = [
      "system": UIDevice.current.systemVersion,
      "reduceMotion": UIAccessibility.isReduceMotionEnabled,
      "events": events,
    ]
    do {
      let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("glass-spike.json")
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url)
      phase.text = "Spike complete"
    } catch {
      phase.text = "Report failed: \(error.localizedDescription)"
    }
  }
}
