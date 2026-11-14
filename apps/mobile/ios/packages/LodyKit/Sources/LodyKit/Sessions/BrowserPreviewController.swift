import SafariServices
import UIKit
import WebKit

/// The conversation's browser preview, embedded rather than presented over the whole window: on
/// iPad `LodyShell.presentDetail` places it in the inspector column beside the conversation, so the
/// page can be watched while the agent edits it; compact widths get the same page as a sheet.
///
/// The page is the user's own dev server behind a share tunnel, not Lody content. It runs in a
/// non-persistent website data store, apart from the trusted cloud data runtime, with no script
/// message handlers; links that leave the web open in the system instead.
@MainActor
final class BrowserPreviewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
  private let url: URL
  private lazy var webView: WKWebView = {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.accessibilityIdentifier = "browser-preview-web"
    return webView
  }()
  private let progress = UIProgressView(progressViewStyle: .bar)
  private var observations: [NSKeyValueObservation] = []

  init(url: URL) {
    self.url = url
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "session.preview.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    for child in [webView, progress] as [UIView] {
      child.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(child)
    }
    progress.trackTintColor = .clear
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    observations = [
      webView.observe(\.estimatedProgress, options: [.initial, .new]) { [weak self] webView, _ in
        MainActor.assumeIsolated { self?.renderProgress(webView.estimatedProgress, loading: webView.isLoading) }
      },
      webView.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
        MainActor.assumeIsolated { self?.renderProgress(webView.estimatedProgress, loading: webView.isLoading) }
      },
    ]
    webView.load(URLRequest(url: url))
  }

  /// Appended once the hosting page has loaded, so a sheet keeps the shell's shared close item
  /// and the iPad inspector its leading close.
  override func viewIsAppearing(_ animated: Bool) {
    super.viewIsAppearing(animated)
    guard let item = parent?.navigationItem, !(item.rightBarButtonItems ?? []).contains(where: { $0.accessibilityIdentifier == "browser-preview-reload" }) else { return }
    let reload = UIBarButtonItem(image: UIImage(systemName: "arrow.clockwise"), primaryAction: UIAction { [weak self] _ in
      self?.webView.reload()
    })
    reload.accessibilityLabel = String(localized: "session.preview.reload", bundle: .lody)
    reload.accessibilityIdentifier = "browser-preview-reload"
    let safari = UIBarButtonItem(image: UIImage(systemName: "safari"), primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      present(SFSafariViewController(url: webView.url ?? url), animated: true)
    })
    safari.accessibilityLabel = String(localized: "session.preview.openInSafari", bundle: .lody)
    safari.accessibilityIdentifier = "browser-preview-safari"
    item.rightBarButtonItems = (item.rightBarButtonItems ?? []) + [safari, reload]
  }

  private func renderProgress(_ value: Double, loading: Bool) {
    progress.setProgress(Float(value), animated: loading)
    progress.isHidden = !loading
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let target = navigationAction.request.url else { return .cancel }
    if ["http", "https", "about", "blob", "data"].contains(target.scheme?.lowercased() ?? "") { return .allow }
    // mailto:, tel: and app links belong to the system, never to the preview.
    if navigationAction.navigationType == .linkActivated { await UIApplication.shared.open(target) }
    return .cancel
  }

  /// `target="_blank"` and `window.open` stay in the preview instead of being dropped.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
    return nil
  }
}
