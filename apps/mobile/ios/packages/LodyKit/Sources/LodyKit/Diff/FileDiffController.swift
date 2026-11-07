import LodyCore
import UIKit

@MainActor
class FileDiffController: UIViewController {
  private enum Body {
    case loading
    case notice(String, action: Action?)
    case document(old: String, new: String)
  }

  private enum Action { case retry, preview }

  private static let reasons = [
    "not_changed": "diff.reason.notChanged",
    "base_unavailable": "diff.reason.baseUnavailable",
    "transient_io": "diff.reason.transientIo",
    "unsupported_binary": "diff.reason.unsupportedBinary",
  ]

  let request: FileDiffRequest
  let feedback: PreviewFeedback?
  private let service: FileDiffService
  private let files: FileContentService
  private let document = DiffDocumentView()
  private let toolbar = LodyDiffToolbar(frame: .zero)
  private let notice = UIContentUnavailableView(configuration: .empty())
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let renderProbe = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
  private var body = Body.loading
  private var result: RuntimeContract.DiffResultOk?
  private var style = DiffDocumentStyle.unified
  private var load: Task<Void, Never>?
  private var readyAt: CFTimeInterval = 0

  init(request: FileDiffRequest, feedback: PreviewFeedback? = nil, service: FileDiffService = .live, files: FileContentService = .live) {
    self.request = request
    self.feedback = feedback
    self.service = service
    self.files = files
    super.init(nibName: nil, bundle: nil)
    title = FilePathText.basename(request.path)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { load?.cancel() }

  private var html: Bool { HTMLPreviewText.isHTML(request.path) }
  private var sides: (old: String, new: String)? {
    if case .document(let old, let new) = body { return (old, new) }
    return nil
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyOpaqueBackground
    for subview in [document, notice, spinner] {
      subview.frame = view.bounds
      subview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(subview)
    }
    document.collectionView.contentInsetAdjustmentBehavior = .automatic
    document.collectionView.contentInset.bottom = 72
    LodyScrollEdges.navigation(document.collectionView)
    document.onRender = { [weak self] in self?.rendered() }
    toolbar.translatesAutoresizingMaskIntoConstraints = false
    toolbar.styleChanged = { [weak self] value in self?.changeStyle(DiffDocumentStyle(rawValue: value) ?? .unified) }
    view.addSubview(toolbar)
    NSLayoutConstraint.activate([
      toolbar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      toolbar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
      toolbar.heightAnchor.constraint(equalToConstant: 56),
    ])
    renderProbe.isAccessibilityElement = true
    renderProbe.accessibilityIdentifier = "diff-render-ms"
    renderProbe.isUserInteractionEnabled = false
    renderProbe.isHidden = true
    view.addSubview(renderProbe)
    Task { [weak self] in
      guard let stored = await self?.service.readStyle(), let self, stored != self.style else { return }
      self.style = stored
      self.toolbar.setStyle(stored.rawValue)
      if case .document = self.body { self.document.setStyle(stored) }
    }
    reload()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(document.collectionView, to: self)
    toolbar.attachScrollEdge(to: document.collectionView)
    renderHeader()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    renderHeader()
  }

  private func reload() {
    load?.cancel()
    result = nil
    renderProbe.isHidden = true
    show(.loading)
    load = Task { [weak self, request, service] in
      do {
        let value = try await service.diff(request)
        guard !Task.isCancelled else { return }
        self?.loaded(value)
      } catch {
        guard !Task.isCancelled else { return }
        let archived = String(describing: error).contains("permission_denied")
        self?.show(.notice(String(localized: String.LocalizationValue(archived ? "files.error.archived" : "diff.error.offline"), bundle: .lody), action: .retry))
      }
    }
  }

  private func loaded(_ value: RuntimeContract.DiffResult) {
    switch value {
    case .unavailable(let unavailable):
      let text = Self.reasons[unavailable.reason].map { String(localized: String.LocalizationValue($0), bundle: .lody) } ?? unavailable.message ?? String(localized: "diff.error.fetch", bundle: .lody)
      show(.notice(text, action: unavailable.reason == "unsupported_binary" ? .preview : nil))
    case .ok(let ok):
      result = ok
      if ok.new.kind == .binary || ok.old.kind == .binary {
        show(.notice(String(localized: "diff.reason.unsupportedBinary", bundle: .lody), action: .preview))
      } else if ok.new.kind == .tooLarge || ok.old.kind == .tooLarge {
        show(.notice(String(localized: "diff.error.tooLarge", bundle: .lody), action: nil))
      } else {
        readyAt = CACurrentMediaTime()
        show(.document(old: ok.old.text ?? "", new: ok.new.text ?? ""))
      }
    }
  }

  private func show(_ next: Body) {
    body = next
    spinner.stopAnimating()
    notice.isHidden = true
    document.isHidden = true
    switch next {
    case .loading:
      spinner.startAnimating()
    case .notice(let text, let action):
      var configuration = UIContentUnavailableConfiguration.empty()
      configuration.secondaryText = text
      if let action {
        var button = UIButton.Configuration.gray()
        button.title = String(localized: String.LocalizationValue(action == .retry ? "common.retry" : "diff.action.previewFile"), bundle: .lody)
        configuration.button = button
        configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in
          if action == .retry { self?.reload() } else { self?.preview() }
        }
      }
      notice.configuration = configuration
      notice.isHidden = false
    case .document(let old, let new):
      document.isHidden = false
      document.show(path: request.path, old: old, new: new, mode: .diff(style))
    }
    toolbar.isHidden = result == nil
    if let result {
      toolbar.setStats(add: result.add ?? 0, del: result.del ?? 0, base: String(localized: String.LocalizationValue(result.base == .turn ? "diff.base.turn" : "diff.base.current"), bundle: .lody))
    }
    renderHeader()
  }

  private func rendered() {
    guard readyAt > 0, sides != nil else { return }
    renderProbe.accessibilityLabel = String(max(1, Int((CACurrentMediaTime() - readyAt) * 1000)))
    renderProbe.isHidden = false
  }

  private func changeStyle(_ next: DiffDocumentStyle) {
    style = next
    document.setStyle(next)
    service.writeStyle(next)
  }

  private func renderHeader() {
    guard let host = parent?.navigationItem else { return }
    host.title = title
    func action(_ key: String, _ symbol: String, disabled: Bool = false, _ handler: @escaping (FileDiffController) -> Void) -> UIAction {
      UIAction(title: String(localized: String.LocalizationValue(key), bundle: .lody), image: UIImage(systemName: symbol), attributes: disabled ? .disabled : []) { [weak self] _ in
        self.map(handler)
      }
    }
    let sides = sides, path = request.path
    var actions = [
      action("diff.action.copyFileName", "doc.on.doc") { $0.copy(FilePathText.basename(path)) },
      action("diff.action.copyPath", "folder") { $0.copy(path) },
      action("diff.action.copyContents", "doc.text", disabled: sides == nil) { $0.copy(sides?.new) },
      action("diff.action.copyPatch", "plus.forwardslash.minus", disabled: sides == nil) {
        $0.copy(sides.map { UnifiedPatch.make(path: path, old: $0.old, new: $0.new) })
      },
    ]
    if !html { actions.append(action("diff.action.previewFile", "eye") { $0.preview() }) }
    let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: actions))
    more.accessibilityLabel = String(localized: "common.more", bundle: .lody)
    var items = [more]
    if html {
      let eye = UIBarButtonItem(primaryAction: UIAction(image: UIImage(systemName: "eye")) { [weak self] _ in self?.preview() })
      eye.accessibilityLabel = String(localized: "file.preview", bundle: .lody)
      items.append(eye)
    }
    host.rightBarButtonItems = items
  }

  private func copy(_ text: String?) {
    guard let text else { return }
    UIPasteboard.general.string = text
    LodyToastOverlay.shared.show(message: String(localized: "diff.toast.copied", bundle: .lody), kind: "info")
  }

  func preview() {
    if html {
      let content = FileContentController(sessionId: request.sessionId, path: request.path, preview: true, feedback: feedback, service: files)
      LodyShell.shared.presentDetail(content, title: FilePathText.basename(request.path), from: self, detents: [1])
      return
    }
    Task { [weak self, request, service] in
      guard let self else { return }
      do {
        try await service.preview(request.sessionId, request.path, self)
      } catch let failure as FilePreviewFailure {
        LodyToastOverlay.shared.show(message: failure.message, kind: "error")
      } catch {
        LodyToastOverlay.shared.show(message: String(localized: "diff.toast.previewFailed", bundle: .lody), kind: "error")
      }
    }
  }
}

struct FilePreviewFailure: Error {
  let message: String
}
