import Capacitor
import UIKit
import WebKit
import os

/// Unified-system logger, not `CAPLog`: Capacitor's `loggingBehavior` defaults
/// to `debug`, so `CAPLog.print` is a no-op in TestFlight/App Store builds —
/// exactly the builds where we need to see this recovery happen. Visible in
/// Console.app by filtering on the subsystem below.
private let webViewRecoveryLog = Logger(
    subsystem: "ai.lody.mobile",
    category: "webview-recovery"
)

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

private final class LodyViewportContainer: UIView {
    var onRegionsChanged: (() -> Void)?
    var occlusions: [CGRect] = []
    var divisions: [CGRect] = []
    override func updateConstraints() {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            let next = reservedRegions(kind: .occlusion).map(\.frame)
            let nextDivisions = reservedRegions(kind: .division).map(\.frame)
            if next != occlusions || nextDivisions != divisions {
                occlusions = next
                divisions = nextDivisions
                onRegionsChanged?()
            }
        }
        #endif
        super.updateConstraints()
    }
}

final class LodyBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {
    /// Re-check delay used when a load is still in flight on resume. Long enough
    /// for a healthy reload to commit a document, short enough that a user
    /// staring at a white screen is not waiting on us.
    private static let inFlightLoadRecheckDelay: TimeInterval = 3
    /// Floor between two recovery loads, so a rapid background/foreground cycle
    /// cannot stack loads on top of each other.
    private static let recoveryLoadMinimumInterval: TimeInterval = 10

    var isResettingData = false

    private var titleObservation: NSKeyValueObservation?
    /// Set once the WebView has ever had a document with a title, i.e. the app
    /// has loaded at least once. Until then an empty title just means "still
    /// booting" and must not be read as a crash.
    private var hasLoadedOnce = false
    private var lastRecoveryLoadAt: Date?
    private var lastKeyboardHeight: Int?
    private var lastDivisionScript: String?
    private let sideRail = UIStackView()
    private var railOwner = ""
    private var railItems: [(id: String, label: String, symbol: String, selected: Bool)] = []
    private var reportedRailState = ""

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Capacitor installs its content controller after webViewConfiguration.
        // Add the script here so that installation cannot discard it.
        configuration.userContentController.addUserScript(WKUserScript(
            source: LodyViewportLayout.keyboardScript(height: 0),
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        configuration.userContentController.add(WeakScriptHandler(self), name: "lodySideRail")
        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        if let webView = webView {
            // Capacitor makes WKWebView the root view. A container lets every
            // web surface, including fixed portals, avoid either side's system
            // chrome without duplicating horizontal safe-area padding in CSS.
            let container = LodyViewportContainer(frame: webView.frame)
            container.onRegionsChanged = { [weak container] in container?.setNeedsLayout() }
            view = container
            container.addSubview(webView)
            sideRail.axis = .vertical
            sideRail.spacing = 8
            sideRail.distribution = .fillEqually
            sideRail.isHidden = true
            container.addSubview(sideRail)
            webView.autoresizingMask = []
            container.keyboardLayoutGuide.followsUndockedKeyboard = false
            // Reading an otherwise unused guide does not drive a view layout
            // when the keyboard moves. A hidden constraint consumer makes
            // UIKit lay out the container before we publish the new offset.
            let keyboardProbe = UIView()
            keyboardProbe.isHidden = true
            keyboardProbe.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(keyboardProbe)
            NSLayoutConstraint.activate([
                keyboardProbe.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                keyboardProbe.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                keyboardProbe.topAnchor.constraint(equalTo: container.keyboardLayoutGuide.topAnchor),
                keyboardProbe.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])
        }
        // The web UI owns the safe-area background; UIKit's automatic edge
        // effect would add a second gradient behind the status bar.
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
        }
        bridge?.registerPluginInstance(LodyAppIconPlugin())
        bridge?.registerPluginInstance(LodyAppStoreReviewPlugin())
        bridge?.registerPluginInstance(LodyLiveActivityPlugin())
        bridge?.registerPluginInstance(LodyHomeWidgetPlugin())
        bridge?.registerPluginInstance(LodyStartupThemePlugin())
        bridge?.registerPluginInstance(LodyNativeResetPlugin())
        bridge?.registerPluginInstance(LodyKekPlugin())
        #if canImport(LodyIrohBindings)
        bridge?.registerPluginInstance(LodyIrohPlugin())
        #endif
        bridge?.registerPluginInstance(LodyPasskeyPlugin())
        installWebContentProcessRecovery()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        applyStartupThemeBackground(LodyStartupTheme.load())
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (self: LodyBridgeViewController, _) in
                self.view.setNeedsLayout()
            }
        }
        #endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let webView = webView {
            let frame = LodyViewportLayout.contentFrame(
                in: view.bounds, left: view.safeAreaInsets.left, right: view.safeAreaInsets.right
            )
            if webView.frame != frame { webView.frame = frame }
        }
        updateKeyboardLayout()
        updateDivisionLayout()
        layoutSideRail()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.name == "lodySideRail",
              let body = message.body as? [String: Any], let owner = body["owner"] as? String,
              owner.count <= 80, let rawItems = body["items"] as? [[String: Any]], rawItems.count <= 6 else { return }
        let allowedSymbols: Set<String> = ["chevron.left", "bubble.left.and.bubble.right", "ellipsis", "bubble.left", "clock", "folder", "bell", "doc", "gearshape", "square.and.pencil"]
        let validItems = rawItems.compactMap { item -> (String, String, String, Bool)? in
            guard let id = item["id"] as? String, id.count <= 80,
                  let label = item["label"] as? String, label.count <= 100,
                  let symbol = item["symbol"] as? String, allowedSymbols.contains(symbol) else { return nil }
            return (id, label, symbol, item["selected"] as? Bool ?? false)
        }
        // Invalid metadata must restore the web controls, not leave the previous
        // surface's native buttons visible with stale callbacks.
        let items = validItems.count == rawItems.count ? validItems : []
        railOwner = owner
        railItems = items
        reportedRailState = ""
        sideRail.arrangedSubviews.forEach { sideRail.removeArrangedSubview($0); $0.removeFromSuperview() }
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .system)
            button.tag = index
            button.accessibilityLabel = item.1
            button.accessibilityTraits = item.3 ? [.button, .selected] : .button
            button.setImage(UIImage(systemName: item.2), for: .normal)
            button.tintColor = item.3 ? .systemBlue : .label
            button.backgroundColor = item.3 ? UIColor.systemBlue.withAlphaComponent(0.12) : .clear
            button.layer.cornerRadius = 22
            button.addTarget(self, action: #selector(sideRailPressed(_:)), for: .touchUpInside)
            sideRail.addArrangedSubview(button)
        }
        view.setNeedsLayout()
        layoutSideRail()
    }

    @objc private func sideRailPressed(_ sender: UIButton) {
        guard sender.tag < railItems.count else { return }
        publishRailEvent(["owner": railOwner, "action": railItems[sender.tag].id])
    }

    private func layoutSideRail() {
        guard let container = view as? LodyViewportContainer else { return }
        let height = lastKeyboardHeight ?? 0
        let bottom = view.bounds.maxY - max(CGFloat(height), view.safeAreaInsets.bottom)
        var systemHasVerticalBar = false
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            systemHasVerticalBar = traitCollection.verticalBarEdge != .unspecified
        }
        #endif
        let frame = LodyViewportLayout.sideRailFrame(in: view.bounds, systemHasVerticalBar: systemHasVerticalBar,
            left: view.safeAreaInsets.left,
            right: view.safeAreaInsets.right, occlusions: container.occlusions, divisions: container.divisions,
            bottomLimit: bottom, itemCount: railItems.count)
        sideRail.isHidden = frame == nil
        if let frame = frame { sideRail.frame = frame }
        let state = "\(railOwner):\(frame != nil)"
        if state != reportedRailState {
            reportedRailState = state
            publishRailEvent(["owner": railOwner, "visible": frame != nil])
        }
    }

    private func publishRailEvent(_ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        bridge?.eval(js: "window.dispatchEvent(new CustomEvent('lody:side-rail', {detail: \(json)}))")
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        view.setNeedsLayout()
    }

    private func updateDivisionLayout(force: Bool = false) {
        guard let container = view as? LodyViewportContainer, let webView = webView else { return }
        let division = LodyViewportLayout.verticalDivision(in: webView.frame, regions: container.divisions)
        let horizontal = LodyViewportLayout.horizontalDivision(in: webView.frame, regions: container.divisions)
        let script = LodyViewportLayout.divisionScript(division, horizontal: horizontal,
            viewportWidth: webView.frame.width, viewportHeight: webView.frame.height)
        guard force || script != lastDivisionScript else { return }
        lastDivisionScript = script
        bridge?.eval(js: script)
    }

    private func updateKeyboardLayout(force: Bool = false) {
        guard let webView = webView else { return }
        let height = LodyViewportLayout.keyboardHeight(
            in: webView.frame, guide: view.keyboardLayoutGuide.layoutFrame,
            bottomSafeArea: view.safeAreaInsets.bottom
        )
        guard force || height != lastKeyboardHeight else { return }
        lastKeyboardHeight = height
        bridge?.eval(js: LodyViewportLayout.keyboardScript(height: height))
    }

    /// Paints what shows between the splash fading out and the page's first
    /// paint. WKWebView is opaque white until the document has a background;
    /// with `isOpaque` off it shows this color through instead.
    func applyStartupThemeBackground(_ theme: LodyStartupTheme) {
        let color = theme.backgroundColor(for: traitCollection)
        view.backgroundColor = color
        webView?.isOpaque = false
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - White screen after returning from background

    /// Recovers from the "app is white after switching back to it" failure.
    ///
    /// Under memory pressure iOS kills the WKWebView's *web content process*
    /// without killing the app. Capacitor already reacts to that in
    /// `WebViewDelegationHandler.webViewWebContentProcessDidTerminate` by
    /// calling `webView.reload()` — but that fires at kill time, which is while
    /// we are backgrounded, and a load started in the background can be
    /// suspended or fail outright. Nothing retries it: `didFail*` only routes to
    /// `errorPathURL`, which this app does not configure, so the WebView stays
    /// blank forever. The JS-side guard in `src/resume-recovery.ts` cannot help
    /// either, because its `appStateChange` listener died with the content
    /// process.
    ///
    /// So we re-check on the way *back* to the foreground, where a load can
    /// actually succeed.
    ///
    /// Division of labour with `src/resume-recovery.ts`: that file owns "JS is
    /// alive but the DOM is blank"; this owns "there is no document at all".
    /// The two cannot both fire — the check here is the WebView's own title,
    /// which is set from `index.html` and which the app never rewrites, so it
    /// is non-empty for as long as a document exists, however broken the React
    /// tree inside it is.
    private func installWebContentProcessRecovery() {
        guard let webView = webView else {
            webViewRecoveryLog.error("no WebView to guard; blank-screen recovery is off")
            return
        }

        // KVO rather than the navigation delegate: Capacitor owns that delegate
        // and routes every navigation decision through it, and it is built
        // inside the `final` `CAPBridgeViewController.loadView()`, so there is
        // no seam to subclass. Observing is side-effect free.
        titleObservation = webView.observe(\.title, options: [.initial, .new]) {
            [weak self] observedWebView, _ in
            guard let self = self else { return }
            if Self.hasDocument(observedWebView) {
                self.hasLoadedOnce = true
                // Every new document needs the current offset even if the
                // keyboard stayed open through WebKit recovery/navigation.
                self.updateKeyboardLayout(force: true)
                self.updateDivisionLayout(force: true)
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleApplicationDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    /// A live document always carries the `index.html` title. WKWebView drops it
    /// when the web content process dies, which is what makes this a usable
    /// liveness check that does not need the (possibly dead, possibly merely
    /// busy) content process to answer us.
    private static func hasDocument(_ webView: WKWebView) -> Bool {
        guard let title = webView.title else { return false }
        return !title.isEmpty
    }

    @objc private func handleApplicationDidBecomeActive() {
        reloadIfBlank(allowInFlightLoad: false)
    }

    /// - Parameter allowInFlightLoad: when false, a load already in flight wins
    ///   and we only schedule a re-check; when true (the re-check itself) we
    ///   reload anyway, because a load that has been in flight that long is
    ///   stuck rather than slow.
    private func reloadIfBlank(allowInFlightLoad: Bool) {
        guard !isResettingData else { return }
        guard let webView = webView else { return }
        // Before the first successful load, an empty title is just "booting".
        guard hasLoadedOnce else { return }
        guard !Self.hasDocument(webView) else { return }
        // Loading in the background is the failure we are recovering from, so
        // only ever act while we can actually render.
        guard UIApplication.shared.applicationState == .active else { return }

        if webView.isLoading, !allowInFlightLoad {
            // Most likely Capacitor's own post-termination reload, now running
            // in the foreground where it can succeed. Give it room first.
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.inFlightLoadRecheckDelay) {
                [weak self] in
                self?.reloadIfBlank(allowInFlightLoad: true)
            }
            return
        }

        if let last = lastRecoveryLoadAt,
            Date().timeIntervalSince(last) < Self.recoveryLoadMinimumInterval
        {
            return
        }

        lastRecoveryLoadAt = Date()
        webViewRecoveryLog.error("WebView has no document on resume; reloading the app")
        // Not `webView.reload()`: after the content process dies the
        // back-forward list can be empty, which makes `reload()` a no-op.
        // `loadWebView()` always navigates to the configured app start URL.
        loadWebView()
    }
}
