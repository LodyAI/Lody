import UniformTypeIdentifiers
import UIKit
import WebKit

private final class HTMLPreviewHandler: NSObject, WKURLSchemeHandler, WKScriptMessageHandler {
  weak var owner: LodyHTMLPreviewView?
  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) { owner?.start(urlSchemeTask) }
  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { owner?.stop(urlSchemeTask) }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    owner?.receive(message)
  }
}

final class LodyHTMLPreviewView: LodyAppearanceView, WKNavigationDelegate, WKUIDelegate {
  var onResourceRequest: ([String: Any]) -> Void = { _ in }
  var onIssues: ([String: Any]) -> Void = { _ in }
  var onLoad: ([String: Any]) -> Void = { _ in }
  var onFail: ([String: Any]) -> Void = { _ in }
  var loaded: (() -> Void)?
  var failed: ((String) -> Void)?
  var issuesChanged: (([[String: String]]) -> Void)?
  var resourceRequested: ((_ id: String, _ path: String) -> Void)?
  private var webView: WKWebView?
  private var content: StoredContent?
  private var documentURL: URL?
  private var requests: [String: WKURLSchemeTask] = [:]
  private var issues: [String: [String: String]] = [:]
  private var resourceCount = 0
  private var resourceBytes = 0
  private weak var scrollOwner: UIViewController?
  private var handle = ""

  func setHandle(_ handle: String) {
    if self.handle == handle, webView != nil { return }
    self.handle = handle
    guard let stored = ContentStore.shared.get(handle) else { fail("content_expired"); return }
    stopLoading()
    content = stored
    resourceCount = 0
    resourceBytes = 0
    issues.removeAll()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let handler = HTMLPreviewHandler()
    handler.owner = self
    configuration.setURLSchemeHandler(handler, forURLScheme: HTMLPreviewResource.scheme)
    configuration.userContentController.add(handler, name: "lodyPreview")
    configuration.userContentController.addUserScript(WKUserScript(
      source: HTMLPreviewScripts.observer, injectionTime: .atDocumentStart, forMainFrameOnly: false
    ))
    if LodyUIVerify.enabled {
      configuration.userContentController.addUserScript(WKUserScript(source: "document.addEventListener('click', () => setTimeout(() => window.webkit.messageHandlers.lodyPreview.postMessage({type:'verify'}), 0), true);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    let web = WKWebView(frame: bounds, configuration: configuration)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.backgroundColor = .systemBackground
    web.underPageBackgroundColor = .systemBackground
    web.scrollView.contentInsetAdjustmentBehavior = .automatic
    web.accessibilityIdentifier = "html-preview"
    web.isAccessibilityElement = false
    isAccessibilityElement = false
    addSubview(web)
    webView = web
    let url = HTMLPreviewResource.url(path: stored.path, host: UUID().uuidString.lowercased())
    documentURL = url
    // WebKit content filters accept a regex subset; use separate host rules.
    let rules = #"[{"trigger":{"url-filter":"^https?://localhost[:/]"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https?://[^/]*\\.localhost[:/]"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https?://127\\.[0-9.]+[:/]"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https?://\\[::1\\][:/]"},"action":{"type":"block"}}]"#
    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "lody-preview-localhost", encodedContentRuleList: rules) { [weak self, weak web] ruleList, _ in
      DispatchQueue.main.async {
        guard let self, let web, web === self.webView else { return }
        guard let ruleList else { self.fail("resource_failed"); return }
        web.configuration.userContentController.add(ruleList)
        web.load(URLRequest(url: url))
      }
    }
    attachScrollOwner()
  }

  fileprivate func start(_ task: WKURLSchemeTask) {
    guard let url = task.request.url, let root = documentURL, let content,
      url.host == root.host, task.request.httpMethod == "GET" else {
      task.didFailWithError(NSError(domain: "LodyKit.HTMLPreview", code: 1)); return
    }
    if url.path == root.path {
      finish(task, data: content.data, mime: "text/html")
      return
    }
    guard url.path.hasPrefix(HTMLPreviewResource.filePrefix) else {
      fail(task, code: "root_path_unavailable")
      return
    }
    resourceCount += 1
    guard resourceCount <= 128 else { fail(task, code: "resource_limit"); return }
    let id = UUID().uuidString
    requests[id] = task
    let path = HTMLPreviewResource.path(url, documentPath: content.path)
    onResourceRequest(["id": id, "path": path])
    resourceRequested?(id, path)
  }

  fileprivate func stop(_ task: WKURLSchemeTask) {
    requests = requests.filter { ($0.value as AnyObject) !== (task as AnyObject) }
  }

  func setResponses(_ json: String) {
    guard let data = json.data(using: .utf8),
      let replies = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return }
    respond(replies)
  }

  func respond(_ replies: [[String: String]]) {
    for reply in replies {
      guard let id = reply["id"], let task = requests.removeValue(forKey: id) else { continue }
      guard let handle = reply["handle"], let resource = ContentStore.shared.get(handle) else {
        fail(task, code: reply["code"] ?? "resource_failed"); continue
      }
      resourceBytes += resource.data.count
      guard resourceBytes <= 16 * 1024 * 1024 else { fail(task, code: "resource_limit"); continue }
      let mime = resource.mimeType ?? UTType(filenameExtension: (resource.path as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
      finish(task, data: resource.data, mime: mime)
    }
  }

  private func finish(_ task: WKURLSchemeTask, data: Data, mime: String) {
    guard let url = task.request.url else { return }
    task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") || mime.contains("javascript") ? "utf-8" : nil))
    task.didReceive(data)
    task.didFinish()
  }

  private func fail(_ task: WKURLSchemeTask, code: String) {
    if let url = task.request.url {
      record(url: url, reference: url.path, kind: "resource", code: code)
    }
    task.didFailWithError(NSError(domain: "LodyKit.HTMLPreview", code: 2))
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    if LodyUIVerify.enabled, message.webView === webView,
      let body = message.body as? [String: String], body["type"] == "verify" {
      probe()
      return
    }
    guard message.webView === webView, let body = message.body as? [String: String],
      let reference = body["reference"], let root = documentURL,
      let url = URL(string: reference, relativeTo: message.frameInfo.request.url ?? root)?.absoluteURL else { return }
    let code = body["code"].flatMap { $0.isEmpty ? nil : $0 } ?? HTMLPreviewResource.code(url)
    record(url: url, reference: reference, kind: body["kind"] ?? "resource", code: code)
  }

  private func record(url: URL, reference: String, kind: String, code: String) {
    guard let content else { return }
    var issue = ["reference": HTMLPreviewResource.safeReference(reference), "kind": String(kind.prefix(32)), "code": code]
    let key = HTMLPreviewResource.safeReference(url.absoluteString)
    guard issues[key] != nil || issues.count < 128 else { return }
    if url.scheme == HTMLPreviewResource.scheme, url.path.hasPrefix(HTMLPreviewResource.filePrefix) {
      issue["path"] = HTMLPreviewResource.path(url, documentPath: content.path)
      if reference.hasPrefix(HTMLPreviewResource.scheme + ":") || reference == url.path { issue["reference"] = issue["path"] }
    }
    if let old = issues[key], old["code"] != "resource_failed", code == "resource_failed" {
      issue["code"] = old["code"]
    }
    if issues[key] == issue { return }
    issues[key] = issue
    let sorted = issues.keys.sorted().compactMap { issues[$0] }
    onIssues(["issues": sorted])
    issuesChanged?(sorted)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard webView === self.webView else { return }
    onLoad([:])
    loaded?()
    probe()
  }

  private func probe() {
    guard LodyUIVerify.enabled, let web = webView else { return }
    web.evaluateJavaScript("""
      ({heading:document.querySelector('h1')?.textContent || '',
      styled:getComputedStyle(document.querySelector('#style') || document.body).borderTopWidth === '2px',
      controls:Array.from(document.querySelectorAll('button')).map(e => {
        const r=e.getBoundingClientRect();return {label:e.textContent,x:r.x,y:r.y,width:r.width,height:r.height};
      })})
      """) { [weak self, weak web] result, _ in
      guard let self, let web, web === self.webView, var value = result as? [String: Any] else { return }
      let origin = web.convert(CGPoint.zero, to: nil)
      value["originX"] = origin.x
      value["originY"] = origin.y + web.scrollView.adjustedContentInset.top
      value["handle"] = self.handle
      if let data = try? JSONSerialization.data(withJSONObject: value) {
        try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-html-preview.json"), options: .atomic)
      }
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    guard webView === self.webView else { return }
    if (error as NSError).code == NSURLErrorCancelled { return }
    fail("resource_failed")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    guard webView === self.webView else { return }
    if (error as NSError).code == NSURLErrorCancelled { return }
    fail("resource_failed")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard webView === self.webView else { return }
    fail("content_expired")
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    if action.navigationType == .linkActivated || action.targetFrame == nil, ["https", "http"].contains(url.scheme ?? ""), HTMLPreviewResource.code(url) != "local_service_unavailable" {
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
    } else if url.scheme == HTMLPreviewResource.scheme || url.absoluteString == "about:blank" {
      decisionHandler(.allow)
    } else if action.targetFrame?.isMainFrame == true || action.targetFrame == nil {
      record(url: url, reference: url.absoluteString, kind: "navigation", code: HTMLPreviewResource.code(url))
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if action.targetFrame == nil { webView.load(action.request) }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default) { _ in completionHandler() })
    if !present(alert) { completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default) { _ in completionHandler(true) })
    if !present(alert) { completionHandler(false) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
    let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
    if !present(alert) { completionHandler(nil) }
  }

  private func present(_ alert: UIAlertController) -> Bool {
    guard window != nil else { return false }
    var responder = next
    while let current = responder {
      if var owner = current as? UIViewController {
        while let presented = owner.presentedViewController { owner = presented }
        owner.present(alert, animated: true)
        return true
      }
      responder = current.next
    }
    return false
  }

  override func layoutSubviews() { super.layoutSubviews(); webView?.frame = bounds; attachScrollOwner() }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil, webView == nil, !handle.isEmpty { setHandle(handle) }
    attachScrollOwner()
  }

  private func attachScrollOwner() {
    guard window != nil, let scroll = webView?.scrollView else { return }
    var responder = next
    while let current = responder {
      if let owner = current as? UIViewController {
        owner.setContentScrollView(scroll, for: .top)
        owner.setContentScrollView(scroll, for: .bottom)
        LodyScrollEdges.navigation(scroll)
        scrollOwner = owner
        return
      }
      responder = current.next
    }
  }

  private func fail(_ code: String) {
    onFail(["code": code])
    failed?(code)
  }

  private func stopLoading() {
    webView?.stopLoading()
    requests.removeAll()
    if let owner = scrollOwner, owner.contentScrollView(for: .top) === webView?.scrollView {
      owner.setContentScrollView(nil, for: .top)
      owner.setContentScrollView(nil, for: .bottom)
    }
    webView?.removeFromSuperview()
    webView = nil
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { stopLoading() }
  }
}
