import UIKit

@main
final class ShareProbeHostApp: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Share Source", sessionRole: session.role)
    configuration.delegateClass = ShareProbeHostScene.self
    return configuration
  }
}

final class ShareProbeHostScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = ShareProbeSource()
    window.makeKeyAndVisible()
    self.window = window
  }
}

final class ShareProbeSource: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let button = UIButton(type: .system)
    button.setTitle("Share test text", for: .normal)
    button.accessibilityIdentifier = "share-probe-host.open"
    button.addTarget(self, action: #selector(share), for: .touchUpInside)
    button.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      button.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      button.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  @objc private func share() {
    guard presentedViewController == nil else { return }
    let activity = UIActivityViewController(activityItems: ["Lody share probe: Please reply with exactly OK."], applicationActivities: nil)
    activity.popoverPresentationController?.sourceView = view
    present(activity, animated: false)
  }
}
