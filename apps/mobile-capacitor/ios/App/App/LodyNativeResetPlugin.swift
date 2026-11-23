import OneSignalFramework
import Capacitor
import UIKit
import WebKit
import WidgetKit

/// Full, user-requested sign-out. Cache-only recovery must never call this plugin.
@objc(LodyNativeResetPlugin)
public final class LodyNativeResetPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "LodyNativeResetPlugin"
    public let jsName = "LodyNativeReset"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "resetAllData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getResetResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeResetResult", returnType: CAPPluginReturnPromise),
    ]

    private static let installIdKey = "LodyDiagnostics.installId"
    private static let resultKey = "LodyNativeReset.result"
    private static let lastOutcomeKey = "LodyDiagnostics.lastNativeResetOutcome"
    // Re-audit the namespace when the dependency version guard changes.
    private let credentials = LodyNativeResetCredentials()
    private var resetCall: CAPPluginCall?
    // WKWebView's delegate is weak; retain Capacitor's delegate until restoration.
    private var previousDelegate: WKNavigationDelegate?
    private var rootURL: URL?
    private var blankNavigation: WKNavigation?
    private var cover: UIView?
    private var deleting = false

    public override func load() {
        installDiagnosticsScript()
    }

    private func installDiagnosticsScript() {
        var info: [String: String] = [:]
        if let id = UserDefaults.standard.string(forKey: Self.installIdKey) {
            info["install_id"] = id
        }
        if let outcome = UserDefaults.standard.string(forKey: Self.lastOutcomeKey) {
            info["last_native_reset_outcome"] = outcome
        }
        guard !info.isEmpty,
            let data = try? JSONSerialization.data(withJSONObject: info),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__LODY_APP_INFO__ = Object.assign({}, window.__LODY_APP_INFO__, \(json));",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    /// Read on the fresh root document, before importing the app bundle.
    @objc public func getResetResult(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.resetCall == nil else {
                call.reject("A reset is already running")
                return
            }
            let result = UserDefaults.standard.string(forKey: Self.resultKey)
            // A previous process may have exited before reaching clearData.
            let cleanupFailed = result == "fallback" && !self.clearCredentials()
            if result == "fallback",
                self.credentials.shouldBlockBoot(afterCleanupSucceeded: !cleanupFailed)
            {
                call.reject("Native credentials could not be cleared")
                return
            }
            // After three failed boots, attempt the shared web wipe and let the
            // app load. Do not relabel this as a successful native sign-out.
            call.resolve([
                "outcome": result ?? "none",
                "credentialCleanupFailed": cleanupFailed,
            ])
        }
    }

    /// Keep recovery durable until the fresh renderer actually completes its wipe.
    @objc public func acknowledgeResetResult(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.resetCall == nil,
                let outcome = call.getString("outcome"),
                outcome == UserDefaults.standard.string(forKey: Self.resultKey)
            else {
                call.reject("Reset state changed before recovery completed")
                return
            }
            let acknowledge = { [weak self] (custodyCleanupFailed: Bool) in
                // The purge settles asynchronously: a reset started meanwhile owns the result.
                guard let self = self, self.resetCall == nil,
                    UserDefaults.standard.string(forKey: Self.resultKey) == outcome
                else {
                    call.reject("Reset state changed before recovery completed")
                    return
                }
                UserDefaults.standard.removeObject(forKey: Self.resultKey)
                self.credentials.resetFailureCount()
                call.resolve(["custodyCleanupFailed": custodyCleanupFailed])
            }
            guard outcome == "fallback" else {
                acknowledge(false)
                return
            }
            // The shared web wipe has just run and the app is not imported yet: the
            // wrapped originals are gone, so their KEKs follow. Best effort, like that
            // wipe; a failure never blocks boot, is reported in the result, and the next
            // full reset retries it.
            self.clearCustody { cleared in acknowledge(!cleared) }
        }
    }

    @objc public func resetAllData(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let webView = self.webView,
                let controller = self.bridge?.viewController as? LodyBridgeViewController,
                self.bridge is CapacitorBridge,
                let serverURL = self.bridge?.config.serverURL,
                let rootURL = URL(string: "/", relativeTo: serverURL)?.absoluteURL
            else {
                call.reject("Native reset is unavailable")
                return
            }
            guard self.resetCall == nil else {
                call.reject("A reset is already running")
                return
            }
            self.credentials.resetFailureCount()
            self.resetCall = call
            self.rootURL = rootURL
            controller.isResettingData = true

            if UserDefaults.standard.string(forKey: Self.installIdKey) == nil,
                let id = call.getString("installId"), !id.isEmpty, id.utf8.count <= 128
            {
                UserDefaults.standard.set(id, forKey: Self.installIdKey)
            }
            // If the OS kills the app mid-reset, the next boot still attempts
            // the web wipe. Normal success replaces this with "success".
            UserDefaults.standard.set("fallback", forKey: Self.resultKey)
            UserDefaults.standard.set("fallback", forKey: Self.lastOutcomeKey)
            self.installDiagnosticsScript()

            let cover = UIView(frame: controller.view.bounds)
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            cover.backgroundColor = .systemBackground
            let label = UILabel(frame: cover.bounds)
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            label.text = "Resetting…"
            label.textAlignment = .center
            label.textColor = .label
            cover.addSubview(label)
            controller.view.addSubview(cover)
            self.cover = cover

            // A cover/stopLoading alone leaves JS and auth responses running.
            // Replace the document before clearing data, and do not forward the
            // blank navigation to Capacitor (its didStart resets saved calls).
            self.previousDelegate = webView.navigationDelegate
            webView.navigationDelegate = self
            webView.stopLoading()
            self.blankNavigation = webView.load(URLRequest(url: URL(string: "about:blank")!))
            if self.blankNavigation == nil {
                self.finish(error: "Could not prepare native reset")
            }
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Block late route changes from the outgoing document during reset.
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard resetCall != nil, !deleting, let expected = blankNavigation,
            navigation === expected, webView.url?.absoluteString == "about:blank",
            let capacitor = bridge as? CapacitorBridge
        else { return }
        deleting = true
        // Preferences writes already received from the outgoing document execute
        // on Capacitor's serial queue. Drain them before the final credential wipe.
        capacitor.dispatchQueue.async { [weak self] in
            DispatchQueue.main.async {
                self?.clearData()
            }
        }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let expected = blankNavigation, navigation === expected else { return }
        if !deleting { finish(error: "Could not prepare native reset") }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                        withError error: Error) {
        // stopLoading may fail the outgoing navigation; only our blank load
        // determines whether reset preparation succeeded.
        guard let expected = blankNavigation, navigation === expected else { return }
        if !deleting { finish(error: "Could not prepare native reset") }
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // While replacing the page, WebKit may terminate without a navigation
        // failure callback. No deletion has started yet, so root recovery is safe.
        // Once deleting, keep ownership until its uncancellable callback returns.
        if !deleting { finish(error: "WebKit stopped while preparing native reset") }
    }

    private func clearData() {
        guard let webView = webView, resetCall != nil else { return }
        guard clearCredentials() else {
            finish(error: "Native credentials could not be cleared")
            return
        }
        removeAndVerify(store: webView.configuration.websiteDataStore, retry: true)
    }

    private func clearCredentials() -> Bool {
        // The outgoing renderer and its queued native writes have stopped before
        // this reset boundary; boot recovery calls it before importing the bundle.
        if let defaults = LodyHomeWidgetStore.defaults(),
            LodyHomeWidgetStore.clearAll(from: defaults)
        {
            WidgetCenter.shared.reloadTimelines(ofKind: LodyHomeWidgetStore.kind)
            WidgetCenter.shared.reloadTimelines(ofKind: LodyTokenUsageWidgetStore.kind)
            WidgetCenter.shared.reloadTimelines(ofKind: LodyProviderQuotaWidgetStore.kind)
        }
        return credentials.clear(
            clearSharedCookies: { HTTPCookieStorage.shared.removeCookies(since: .distantPast) },
            logoutPush: {
                OneSignal.User.pushSubscription.optOut()
                OneSignal.logout()
                UIApplication.shared.unregisterForRemoteNotifications()
                Task { @MainActor in
                    if #available(iOS 16.1, *) { LodyActivityPushTokens.shared.configure(installationId: "", enabled: false, language: "en") }
                }
            }
        )
    }

    private func removeAndVerify(store: WKWebsiteDataStore, retry: Bool) {
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        // This operation cannot be cancelled. Never release reset ownership on a
        // timer: a late deletion could erase data from a subsequent sign-in.
        store.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
            store.fetchDataRecords(ofTypes: types) { records in
                guard let self = self else { return }
                if records.isEmpty {
                    // Custody goes only once its wrapped originals are verifiably gone.
                    self.clearCustody { cleared in
                        self.finish(error: cleared ? nil : "Encrypted workspace keys could not be cleared")
                    }
                } else if retry {
                    self.removeAndVerify(store: store, retry: false)
                } else {
                    // Capacitor retains the WebView/process pool. Unlinking
                    // Library/WebKit here would delete files under a live process.
                    self.finish(error: "WebKit data remains after two reset attempts")
                }
            }
        }
    }

    /// Every E2EE KEK and receipt, after any LodyKek call the outgoing renderer admitted
    /// has returned. KEKs only protect originals stored in WebKit storage, which a full
    /// reset deletes; leaving them would orphan device-bound keys from a signed-out identity.
    private func clearCustody(_ done: @escaping (Bool) -> Void) {
        LodyKekCallQueue.shared.fenced(on: .global(qos: .userInitiated)) {
            let cleared = LodyKeychainKekStorage.purgeAll()
            DispatchQueue.main.async { done(cleared) }
        }
    }

    private func finish(error: String?) {
        guard let call = resetCall else { return }
        if let error = error {
            call.reject(error)
            // After about:blank the original promise's document is gone. Hand
            // failure to the fresh root's bootstrap for the same web-level wipe.
            UserDefaults.standard.set("fallback", forKey: Self.resultKey)
        } else {
            UserDefaults.standard.set("success", forKey: Self.resultKey)
        }
        UserDefaults.standard.set(error == nil ? "success" : "fallback", forKey: Self.lastOutcomeKey)
        installDiagnosticsScript()
        webView?.navigationDelegate = previousDelegate
        previousDelegate = nil
        resetCall = nil
        blankNavigation = nil
        deleting = false
        (bridge?.viewController as? LodyBridgeViewController)?.isResettingData = false
        if let url = rootURL, webView?.load(URLRequest(url: url)) != nil {
            cover?.removeFromSuperview()
            cover = nil
        } else {
            call.reject("Could not reload the app root; close and reopen Lody")
            if let label = cover?.subviews.first as? UILabel {
                label.text = "Close and reopen Lody to finish resetting."
                label.numberOfLines = 0
            }
        }
        rootURL = nil
        // Success intentionally never resolves: navigation discards its promise.
    }
}
