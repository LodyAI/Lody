import Foundation
import WebKit

/// Platform owners supply lifecycle, resource location, credentials and messages.
@MainActor
public enum RuntimeDocument {
  public static func makeWebView(handler: any WKScriptMessageHandler, delegate: any WKNavigationDelegate) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
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
