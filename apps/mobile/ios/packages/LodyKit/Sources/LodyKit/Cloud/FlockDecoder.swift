import WebKit

// One isolated, offline WebKit instance per decode. The WASM replica is released with it.
@MainActor
final class FlockDecoder: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  private var webView: WKWebView?
  private var timeout: DispatchWorkItem?
  private var completion: ((Result<String, Error>) -> Void)?
  private let arguments: [String: Any]

  init(snapshot: String, updates: [String], mode: String, completion: @escaping (Result<String, Error>) -> Void) {
    self.arguments = ["snapshot": snapshot, "updates": updates, "mode": mode]
    self.completion = completion
    super.init()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(self, name: "decoderReady")
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView?.navigationDelegate = self
    let timer = DispatchWorkItem { self.finish(.failure(NSError(domain: "LodyKit.DecoderTimeout", code: 1))) }
    timeout = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timer)
    do {
      guard let url = Bundle.main.url(forResource: "FlockDecoder", withExtension: "html") else {
        throw NSError(domain: "LodyKit.DecoderMissing", code: 1)
      }
      webView?.loadHTMLString(try String(contentsOf: url, encoding: .utf8), baseURL: nil)
    } catch { finish(.failure(error)) }
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    webView?.callAsyncJavaScript("return globalThis.decodeFlock(snapshot, updates, mode)", arguments: arguments, in: nil, in: .page) { result in
      switch result {
      case .success(let value):
        guard let value = value as? String else { self.finish(.failure(NSError(domain: "LodyKit.DecoderResult", code: 1))); return }
        self.finish(.success(value))
      case .failure(let error): self.finish(.failure(error))
      }
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.failure(NSError(domain: "LodyKit.DecoderTerminated", code: 1))) }
  private func finish(_ result: Result<String, Error>) {
    guard let completion else { return }
    self.completion = nil
    timeout?.cancel(); timeout = nil
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "decoderReady")
    webView?.stopLoading(); webView = nil
    completion(result)
  }
}
