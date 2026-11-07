import LodyCore
import UIKit
import UserNotifications

@MainActor
final class ShareViewController: UIViewController {
  private let composer = ChatComposerView(frame: .zero)
  private let host = UIView()
  private lazy var form = CreateSessionController(composer: composer, host: host)
  private var ingest: Task<Void, Never>?
  private var pendingMessage: String?

  override func viewDidLoad() {
    super.viewDidLoad()
    host.addSubview(composer)
    composer.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      composer.topAnchor.constraint(equalTo: host.topAnchor),
      composer.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: host.trailingAnchor),
    ])
    composer.sendHandoff = false
    composer.onHeightChange = { [weak self] in self?.form.setComposerHeight($0) }
    composer.onSend = { [weak self] in self?.form.submit($0) }
    composer.onComposerOptionChange = { [weak self] in self?.form.composerOptionChanged($0) }

    configureForm()
    let navigation = UINavigationController(rootViewController: form)
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    navigation.navigationBar.standardAppearance = appearance
    navigation.navigationBar.scrollEdgeAppearance = appearance
    addChild(navigation)
    navigation.view.frame = view.bounds
    navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(navigation.view)
    navigation.didMove(toParent: self)
    view.backgroundColor = .systemBackground

    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    ingest = Task { [weak self] in
      let draft = await ShareIngest.load(providers)
      guard let self, !Task.isCancelled else { return }
      if !draft.text.isEmpty { self.composer.setInitialDraft(draft.text) }
      if !draft.attachments.isEmpty { self.composer.setInitialAttachments(CreateJSON.encode(draft.attachments.map(Self.attachment))) }
      if draft.dropped > 0 { self.show(String(localized: "native.share.dropped", bundle: .lody)) }
    }
  }

  private func configureForm() {
    form.onCancel = { [weak self] in self?.finish() }
    form.showMessage = nil
    guard let catalog = ShareStore.catalog() else {
      form.form = CreateSessionForm(signedOut: true)
      form.navigationItem.leftBarButtonItem = UIBarButtonItem(
        title: String(localized: "native.share.openLody", bundle: .lody),
        primaryAction: UIAction { [weak self] _ in self?.openLody(nil) })
      return
    }
    var state = CreateSessionForm(
      userId: catalog.userId, workspaceId: catalog.workspaceId, projects: catalog.projects,
      machineNames: catalog.machineNames ?? [:], prefs: ShareStore.prefs())
    state.deferUnresolved = true
    state.open(projectId: nil, context: nil)
    form.form = state
    form.loadOptions = {
      guard let options = ShareStore.options(CreateLogic.chatTarget) else { throw CocoaError(.fileNoSuchFile) }
      return options
    }
    form.loadBranches = { repo, _ in
      guard let branches = ShareStore.branches(repo) else { throw CocoaError(.fileNoSuchFile) }
      return branches
    }
    form.onPrefs = { try? ShareStore.writePrefs($0) }
    form.onSubmit = { [weak self] draft, payload in self?.send(draft, payload) }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    LodyToastOverlay.scene = view.window?.windowScene
    if let pendingMessage { show(pendingMessage) }
  }

  private func show(_ text: String) {
    guard form.viewIfLoaded?.window != nil else {
      pendingMessage = text
      return
    }
    pendingMessage = nil
    form.message(text)
  }

  private static func attachment(_ item: ChatAttachment) -> ShareAttachment {
    ShareAttachment(id: item.id, name: item.name, uri: item.url.absoluteString, kind: item.isImage ? "image" : "file")
  }

  private func send(_ draft: CreateSessionDraft?, _ payload: [String: Any]) {
    let page = form.form.current
    let pairs = (payload["attachments"] as? [[String: Any]] ?? []).compactMap { item -> (ShareAttachment, URL)? in
      guard let id = item["id"] as? String, let name = item["name"] as? String, let uri = item["uri"] as? String,
        let kind = item["kind"] as? String, let file = URL(string: uri), file.isFileURL else { return nil }
      return (ShareAttachment(id: id, name: name, uri: uri, kind: kind), file)
    }
    var fresh = draft
    fresh?.sessionId = UUID().uuidString.lowercased()
    let manifest = ShareManifest(
      id: UUID().uuidString.lowercased(), createdAt: Date().timeIntervalSince1970 * 1000,
      userId: form.form.userId, workspaceId: form.form.workspaceId,
      projectId: page.chat || page.projectId.isEmpty ? nil : page.projectId, context: page.chat ? "chat" : "project",
      text: payload["text"] as? String ?? "", attachments: pairs.map(\.0), draft: fresh)
    do {
      try ShareStore.enqueue(manifest, files: pairs.map(\.1))
    } catch {
      form.submissionFailed()
      show(String(localized: "native.share.sendFailed", bundle: .lody))
      return
    }
    openLody(manifest.id)
  }

  private func openLody(_ entry: String?) {
    let url = URL(string: entry.map { "lody://share/\($0)" } ?? "lody://")!
    open(url) { [weak self] opened in
      if !opened, let entry { Self.notify(entry) }
      self?.finish()
    }
  }

  // Share extensions have no public API to open their app; UIApplication is
  // reachable on the responder chain and still honors openURL:options:completionHandler:.
  private func open(_ url: URL, completion: @escaping (Bool) -> Void) {
    let selector = NSSelectorFromString("openURL:options:completionHandler:")
    var responder: UIResponder? = self
    while let current = responder {
      if current.responds(to: selector), current.isKind(of: NSClassFromString("UIApplication")!) {
        typealias Open = @convention(c) (AnyObject, Selector, URL, NSDictionary, @escaping @convention(block) (Bool) -> Void) -> Void
        let function = unsafeBitCast(current.method(for: selector), to: Open.self)
        function(current, selector, url, NSDictionary(), { opened in
          DispatchQueue.main.async { completion(opened) }
        })
        return
      }
      responder = current.next
    }
    completion(false)
  }

  private static func notify(_ entry: String) {
    let content = UNMutableNotificationContent()
    content.body = String(localized: "native.share.notification", bundle: .lody)
    content.userInfo = ["lodyShare": entry]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "share-\(entry)", content: content, trigger: nil))
  }

  private func finish() {
    ingest?.cancel()
    extensionContext?.completeRequest(returningItems: nil)
  }
}
