import QuickLook
import UIKit

@MainActor
enum FilePreview {
  static func read(sessionId: String, path: String, runtime: DataRuntime) async throws -> String {
    let payload = String(
      data: try JSONSerialization.data(withJSONObject: ["sessionId": sessionId, "path": path]),
      encoding: .utf8
    )!
    if let failure = FilePreviewFixture.failure(payload) {
      throw failure
    }
    if let response = FilePreviewFixture.response(payload) {
      let fast = ["document.pdf", "interactive.html", "broken.html", "preview.css", "preview.js"].contains { payload.contains($0) }
      let delay = fast ? 0.0 : 5.0
      if delay > 0 { try await Task.sleep(for: .seconds(delay)) }
      try Task.checkCancellation()
      return response
    }
    return try await runtime.readFile(payload)
  }

  static func presentsQuickLook(_ path: String) -> Bool {
    switch ChatFileLink.iconName(for: path) {
    case "image", "pdf", "video", "audio", "zip", "word", "powerpoint", "table":
      return true
    default:
      return false
    }
  }

  static func open(
    sessionId: String,
    path: String,
    line: Int,
    runtime: DataRuntime,
    from controller: UIViewController
  ) async -> Bool {
    guard !sessionId.isEmpty, !path.isEmpty else { return false }
    if presentsQuickLook(path) {
      await FileQuickLookController.present(
        sessionId: sessionId, path: path, runtime: runtime, from: controller
      )
      return true
    }
    return false
  }
}

@MainActor
final class FileQuickLookController: QLPreviewController, QLPreviewControllerDataSource, @MainActor QLPreviewControllerDelegate {
  private let sessionId: String
  private let path: String
  private let runtime: DataRuntime
  private var onClose: (() -> Void)?
  private var loadTask: Task<Void, Never>?
  private var previewURL: URL?
  private let directory = ContentPreview.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
  private let spinner = UIActivityIndicatorView(style: .medium)

  static func present(
    sessionId: String,
    path: String,
    runtime: DataRuntime,
    from controller: UIViewController
  ) async {
    await withCheckedContinuation { continuation in
      let preview = FileQuickLookController(sessionId: sessionId, path: path, runtime: runtime)
      preview.onClose = { continuation.resume() }
      let navigation = UINavigationController(rootViewController: preview)
      navigation.modalPresentationStyle = .pageSheet
      if let sheet = navigation.sheetPresentationController {
        sheet.detents = [.large()]
        sheet.prefersGrabberVisible = true
      }
      var host = controller
      while let presented = host.presentedViewController { host = presented }
      host.present(navigation, animated: true)
    }
  }

  private init(sessionId: String, path: String, runtime: DataRuntime) {
    self.sessionId = sessionId
    self.path = path
    self.runtime = runtime
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    dataSource = self
    delegate = self
    let close = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
      self?.dismiss(animated: true)
    })
    close.accessibilityLabel = String(localized: "native.close", bundle: .lody)
    close.accessibilityIdentifier = "file-quicklook-close"
    navigationItem.leftBarButtonItem = close
    spinner.color = .secondaryLabel
    spinner.accessibilityIdentifier = "file-loading"
    spinner.accessibilityLabel = String(localized: "native.file.reading", bundle: .lody)
    spinner.hidesWhenStopped = true
    view.addSubview(spinner)
    load()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    spinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
  }

  private func load() {
    loadTask?.cancel()
    var loading = UIContentUnavailableConfiguration.loading()
    loading.text = String(localized: "native.file.reading", bundle: .lody)
    loading.background.backgroundColor = .systemBackground
    contentUnavailableConfiguration = loading
    spinner.startAnimating()
    let sessionId = sessionId
    let path = path
    let runtime = runtime
    loadTask = Task { [weak self] in
      do {
        let json = try await FilePreview.read(sessionId: sessionId, path: path, runtime: runtime)
        try Task.checkCancellation()
        guard let self else { return }
        self.show(json)
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled, let self else { return }
        self.fail(String(localized: "native.file.error.read", bundle: .lody))
      }
    }
  }

  private func show(_ json: String) {
    guard let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      fail(String(localized: "native.file.error.read", bundle: .lody))
      return
    }
    if object["status"] as? String != "ok" {
      let code = object["code"] as? String ?? ""
      let keys = [
        "too_large": "native.file.error.tooLarge",
        "file_not_found": "native.file.error.notFound",
        "permission_denied": "native.file.error.permissionDenied",
        "path_not_allowed": "native.file.error.pathNotAllowed",
        "decode_error": "native.file.error.decode",
      ]
      fail(String(localized: String.LocalizationValue(keys[code] ?? "native.file.error.read"), bundle: .lody))
      return
    }
    guard let handle = object["handle"] as? String else {
      fail(String(localized: "native.file.error.read", bundle: .lody))
      return
    }
    do {
      previewURL = try ContentPreview.prepare(handle: handle, directory: directory)
    } catch {
      fail(String(localized: "native.file.error.stale", bundle: .lody))
      return
    }
    spinner.stopAnimating()
    contentUnavailableConfiguration = nil
    reloadData()
  }

  private func fail(_ message: String) {
    var failed = UIContentUnavailableConfiguration.empty()
    failed.background.backgroundColor = .systemBackground
    failed.image = UIImage(systemName: "doc.badge.ellipsis")
    failed.text = (path as NSString).lastPathComponent
    failed.secondaryText = message
    failed.button.title = String(localized: "native.file.retry", bundle: .lody)
    failed.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.load() }
    spinner.stopAnimating()
    contentUnavailableConfiguration = failed
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    finish()
  }

  private func finish() {
    loadTask?.cancel()
    try? FileManager.default.removeItem(at: directory)
    let close = onClose
    onClose = nil
    close?()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || navigationController?.isBeingDismissed == true {
      finish()
    }
  }

  deinit {
    loadTask?.cancel()
    try? FileManager.default.removeItem(at: directory)
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    previewURL! as NSURL
  }
}
