import Foundation
import WebKit

/// Platform owners supply lifecycle, resource location, credentials and messages.
@MainActor
public enum RuntimeDocument {
  public static func makeWebView(handler: any WKScriptMessageHandler, delegate: any WKNavigationDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.userContentController.add(handler, name: "dataRuntime")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = delegate
    #if DEBUG
    view.isInspectable = true
    #endif
    return view
  }

  public static func load(in view: WKWebView, bundle: Bundle) throws {
    guard let url = bundle.url(forResource: "DataRuntime", withExtension: "html")
      ?? Bundle.main.url(forResource: "DataRuntime", withExtension: "html")
    else { throw CocoaError(.fileNoSuchFile) }
    // Keep the official origin without loading remote documents or scripts.
    view.loadHTMLString(try String(contentsOf: url, encoding: .utf8), baseURL: URL(string: "https://lody.ai"))
  }

  public static func deliver(_ envelope: String, to view: WKWebView) {
    view.callAsyncJavaScript("globalThis.dataRuntime.receive(envelope)", arguments: ["envelope": envelope], in: nil, in: .page, completionHandler: nil)
  }

  public static func allows(_ action: WKNavigationAction) -> Bool {
    let url = action.request.url?.absoluteString
    return action.navigationType == .other && (url == "about:blank" || url == "https://lody.ai/")
  }
}

/// Untrusted previews have no access to the credential-bearing data runtime.
/// Always add this policy: multiple CSPs intersect, so an authored policy can
/// tighten these restrictions but cannot reopen a blocked channel.
public enum HTMLPreviewDocumentPolicy {
  public static let contentSecurityPolicy = "default-src 'none'; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; media-src 'self' https: data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'"

  public static func protect(_ data: Data) -> Data? {
    guard let html = String(data: data, encoding: .utf8) else { return nil }
    // The policy is parsed before any untrusted element, including an early
    // script, malformed head, base element or a permissive authored CSP.
    return Data(("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"" + contentSecurityPolicy + "\"><meta name=\"referrer\" content=\"no-referrer\">" + html).utf8)
  }

  public static func allowsNavigation(url: URL, documentURL: URL, isMainFrame: Bool, isInitialLoad: Bool, method: String, navigationType: WKNavigationType) -> Bool {
    guard isMainFrame, method == "GET" else { return false }
    if isInitialLoad { return navigationType == .other && url == documentURL }
    // Same-document anchors do not issue resource requests. Every other
    // navigation, popup and form stays in the preview and is refused.
    var destination = URLComponents(url: url, resolvingAgainstBaseURL: false)
    guard destination?.fragment != nil else { return false }
    destination?.fragment = nil
    return destination?.url == documentURL && navigationType != .formSubmitted && navigationType != .formResubmitted
  }
}
