import LodyCore
import UIKit

struct CreateSessionHostParams: Decodable {
  var userId = ""
  var workspaceId = ""
  var projects: [CreateProject] = []
  var machineNames: [String: String] = [:]
  var machineOs: [String: String] = [:]
  var projectId: String?
  var context: String?
  var initialText: String?
  var initialAttachmentsJSON: String?
  var sendHandoff: Bool?
  var relay: Bool?
  /// Pushed full screen (iPhone Home) rather than presented: the form leads with a back button.
  var pushed: Bool?

  init() {}

  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    userId = try values.decodeIfPresent(String.self, forKey: .userId) ?? ""
    workspaceId = try values.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
    projects = try values.decodeIfPresent([CreateProject].self, forKey: .projects) ?? []
    machineNames = try values.decodeIfPresent([String: String].self, forKey: .machineNames) ?? [:]
    machineOs = try values.decodeIfPresent([String: String].self, forKey: .machineOs) ?? [:]
    projectId = try values.decodeIfPresent(String.self, forKey: .projectId)
    context = try values.decodeIfPresent(String.self, forKey: .context)
    initialText = try values.decodeIfPresent(String.self, forKey: .initialText)
    initialAttachmentsJSON = try values.decodeIfPresent(String.self, forKey: .initialAttachmentsJSON)
    sendHandoff = try values.decodeIfPresent(Bool.self, forKey: .sendHandoff)
    relay = try values.decodeIfPresent(Bool.self, forKey: .relay)
    pushed = try values.decodeIfPresent(Bool.self, forKey: .pushed)
  }

  private enum CodingKeys: String, CodingKey {
    case userId, workspaceId, projects, machineNames, machineOs, projectId, context, initialText, initialAttachmentsJSON, sendHandoff, relay, pushed
  }
}

/// Owns its header: the shell page hides its bar for the form's own, so the edge swipe back
/// to Home is restored through the owned-header pop delegate.
@MainActor
class CreateSessionHostController: UIViewController, LodyPageOwnedHeader {
  private let params: CreateSessionHostParams
  private let service: CreateSessionService
  private let input = LodyComposerView(frame: .zero)
  private let controller: CreateSessionController
  private let navigation: UINavigationController
  private var mentions: MentionCatalogStore?
  private var created: Any?
  private var opening = false
  private let optionsObservers = NotificationObservers()
  private var optionsRefresh: Task<Void, Never>?
  private var capabilityTask: Task<Void, Never>?
  private var capabilityConfig: String?
  /// Set once the Outbox holds the typed turn, so a composer that keeps its text visible while
  /// the page dismisses does not write it back as the next new-chat draft.
  private var draftSubmitted = false
  var onCreated: (@MainActor ([String: Any]) async throws -> Void)?

  init(params: CreateSessionHostParams, service: CreateSessionService = .live) {
    self.params = params
    self.service = service
    controller = CreateSessionController(composer: input.composer, host: input)
    navigation = UINavigationController(rootViewController: controller)
    controller.pushed = params.pushed == true
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "create.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    input.scrollEdge = true
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    navigation.navigationBar.standardAppearance = appearance
    navigation.navigationBar.scrollEdgeAppearance = appearance
    navigation.navigationBar.compactAppearance = appearance
    navigation.view.backgroundColor = .clear
    input.composerRelay = relays
    input.composer.sendHandoff = params.sendHandoff ?? true
    input.composer.dismissesKeyboardOnSend = params.pushed != true
    // Web's mobile landing composer: a card that keeps its controls row in view.
    input.composer.cardStyle = true
    wire()
    if service.persistShare {
      optionsObservers.add(NotificationCenter.default.addObserver(forName: .lodyDataRuntimeEvent, object: nil, queue: .main) { [weak self] note in
        let optionsChanged = note.userInfo?["creationOptionsChanged"] as? Bool == true
        let live = note.userInfo?["state"] as? String == "live"
        guard optionsChanged || live else { return }
        MainActor.assumeIsolated {
          guard let self, DataRuntime.current?.workspace == self.params.workspaceId else { return }
          // A read that failed before the runtime was ready (or while it was offline) is read
          // again once it is live, so the page does not stay on "Tap to retry".
          guard optionsChanged || self.controller.optionsFailed else { return }
          self.optionsRefresh?.cancel()
          self.optionsRefresh = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
            guard let self, self.controller.isViewLoaded, self.view.window != nil else { return }
            self.controller.load(background: true)
          }
        }
      })
    }
    Task {
      await configure()
      embedForm()
    }
  }

  // The form loads its options when its view loads, so it is embedded only once prefs are in place.
  private func embedForm() {
    addChild(navigation)
    navigation.view.frame = view.bounds
    navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(navigation.view)
    navigation.didMove(toParent: self)
  }

  // A pushed picker takes the edge swipe back to the form first.
  var allowsPageSwipeBack: Bool { navigation.viewControllers.count <= 1 }

  // A pushed form covers Home's destination: waiting for its viewDidAppear to adopt the
  // composer would deadlock navigation. Close the form with the native transition instead.
  var relays: Bool { params.relay == true && params.sendHandoff != false && params.pushed != true }

  private func wire() {
    input.forwarded = { [weak self] name, body in
      guard let self else { return }
      switch name {
      case "send": controller.submit(body)
      case "relayReady": relayReady()
      case "contentHeight": controller.setComposerHeight(body["height"] as? CGFloat ?? 64)
      case "mentionBrowse": browseMentions(body)
      case "optionChange": controller.composerOptionChanged(body)
      default: break
      }
    }
    controller.restoreDraft = { [weak self] token in
      self?.draftSubmitted = false
      self?.input.restoreDraft(token: token)
    }
    controller.showMessage = { LodyToastOverlay.shared.show(message: $0, kind: $1) }
    controller.onCancel = { [weak self] in self?.close() }
    let prefsKey = CreateSessionService.prefsKey(userId: params.userId, workspaceId: params.workspaceId)
    controller.onPrefs = { [weak self] prefs in
      guard let self else { return }
      if service.persistShare { try? ShareStore.writePrefs(prefs) }
      service.writePrefs(prefsKey, prefs)
    }
    controller.onSelection = { [weak self] form in self?.selectionChanged(form) }
    controller.onSubmit = { [weak self] draft, payload in
      guard let draft else { return }
      self?.submit(draft, payload)
    }
    let workspaceId = params.workspaceId
    controller.loadCachedOptions = { [weak self] in
      guard let self else { return nil }
      return await service.cachedOptions(params.userId, workspaceId, nil)
    }
    controller.loadOptions = { [weak self] in
      guard let self else { throw CancellationError() }
      let options = try await service.options(workspaceId, nil)
      if service.persistShare { try? ShareStore.writeOptions(options, target: CreateLogic.chatTarget) }
      return options
    }
    controller.loadRoles = { [weak self] in
      guard let self else { throw CancellationError() }
      return try await service.roles(workspaceId)
    }
    controller.loadProjectGroups = { [weak self] in
      guard let self else { throw CancellationError() }
      return try await service.projectGroups(workspaceId)
    }
    controller.loadRepositories = { [weak self] in
      guard let self else { throw CancellationError() }
      return try await service.repositories(workspaceId).compactMap(CreateSessionService.githubProject)
    }
    controller.loadCachedBranches = { [weak self, params] repo in
      guard let self else { return nil }
      return await service.cachedBranches(params.userId, params.workspaceId, repo)
    }
    controller.loadBranches = { [weak self] repo, page in
      guard let self else { throw CancellationError() }
      return try await service.branches(workspaceId, repo, page)
    }
    controller.onBranches = { [weak self, params] repo, branches in
      guard let self else { return }
      service.persistBranches(params.userId, params.workspaceId, repo, branches)
      guard service.persistShare else { return }
      try? ShareStore.writeBranches(branches, repo: repo, userId: params.userId, workspaceId: params.workspaceId)
    }
    controller.browseProject = { await DirectoryController.browse(workspaceId: workspaceId) }
  }

  private func configure() async {
    let prefs = await service.readPrefs(CreateSessionService.prefsKey(userId: params.userId, workspaceId: params.workspaceId))
    controller.form = CreateSessionForm(
      userId: params.userId, workspaceId: params.workspaceId, projects: params.projects,
      machineNames: params.machineNames, machineOs: params.machineOs, prefs: prefs)
    controller.form.open(projectId: params.projectId, context: params.context)
    if let text = params.initialText, !text.isEmpty { input.composer.setInitialDraft(text) }
    if let attachments = params.initialAttachmentsJSON, !attachments.isEmpty { input.composer.setInitialAttachments(attachments) }
    persistDraft()
  }

  static func draftKey(userId: String, workspaceId: String) -> String { "create-draft:v1:" + CreateJSON.encode([userId, workspaceId]) }

  /// The typed new-chat text is kept per account and workspace, as a conversation's draft is.
  /// Shared content opens its own page and leaves the stored draft alone; encrypted workspaces
  /// never write plaintext.
  private func persistDraft() {
    guard service.persistShare, service.workspaceMode(params.workspaceId) == .plaintext,
      params.initialText?.isEmpty != false, params.initialAttachmentsJSON?.isEmpty != false else { return }
    let key = Self.draftKey(userId: params.userId, workspaceId: params.workspaceId)
    let store = LocalStore.shared
    input.composer.onDraftChange = { [weak self] text in
      guard self?.draftSubmitted != true else { return }
      LocalStore.queue.async { try? store.write(key, text) }
    }
    LocalStore.queue.async { [weak self] in
      guard let text = try? store.read(key), !text.isEmpty else { return }
      DispatchQueue.main.async { self?.input.composer.setStoredDraft(text) }
    }
  }

  private func clearStoredDraft() {
    guard input.composer.onDraftChange != nil, !draftSubmitted else { return }
    draftSubmitted = true
    let key = Self.draftKey(userId: params.userId, workspaceId: params.workspaceId)
    let store = LocalStore.shared
    LocalStore.queue.async { try? store.write(key, "") }
  }

  private func selectionChanged(_ form: CreateSessionForm) {
    let page = form.current
    if page.options?.availability == "online", let agent = page.agent,
       capabilityConfig != agent.id {
      capabilityConfig = agent.id
      capabilityTask?.cancel()
      capabilityTask = Task { [weak self] in
        guard let self else { return }
        try? await service.refreshCapability(params.workspaceId, agent.id)
      }
    }
    guard let machineId = page.machine?.id, !machineId.isEmpty else {
      mentions = nil
      input.composer.setMentionItems("null")
      return
    }
    let source = MentionSource(
      workspaceId: form.workspaceId, projectId: page.chat ? nil : page.projectId.nilIfEmpty, machineId: machineId,
      agentConfigId: page.agent?.id, cliType: page.agent?.cliType, agentType: page.agent?.agentType
    )
    guard mentions?.source != source || mentions?.userId != form.userId else { return }
    let store = MentionCatalogStore(source: source, userId: form.userId)
    store.changed = { [weak self, weak store] in
      guard let self, let store, mentions === store else { return }
      input.composer.setMentionItems(store.composerItemsJSON())
    }
    mentions = store
    input.composer.setMentionItems(store.composerItemsJSON())
    store.preload()
  }

  private var mentionSequence = 0

  private func browseMentions(_ body: [String: Any]) {
    guard let store = mentions, let category = body["category"] as? String,
          MentionCatalogStore.categories.contains(category) else { return }
    let picker = MentionPickerController(
      category: category, query: body["query"] as? String ?? "", store: store, initial: store.catalog(category)
    ) { [weak self] item in
      guard let self else { return }
      mentionSequence += 1
      let result: [String: Any] = [
        "id": String(mentionSequence), "path": item.path,
        "item": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(item))) ?? NSNull(),
      ]
      let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data()
      input.composer.setMentionResult(String(decoding: data, as: UTF8.self))
      if let page = parent, let container = page.navigationController { container.popToViewController(page, animated: true) }
    }
    LodyShell.shared.pushNative(
      picker, title: String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody), from: self
    )
  }

  private func submit(_ draft: CreateSessionDraft, _ payload: [String: Any]) {
    guard !opening, service.workspaceMode(draft.workspaceId) == .plaintext else { return controller.submissionFailed() }
    let built = CreateDraftRecord(draft: draft, payload: payload)
    let userId = params.userId, workspaceId = params.workspaceId
    let failed = built.record?.with(phase: "failed", reason: String(localized: "send.error.draftSaveShort", bundle: .lody))
    let task: Task<Void, Error>
    do { task = try service.submit(user: userId, workspace: workspaceId, json: built.recordJSON) }
    catch { controller.submissionFailed(); return }
    clearStoredDraft()
    Task { [service] in
      guard (try? await task.value) == nil, let failed else { return }
      _ = try? await service.submit(user: userId, workspace: workspaceId, json: String(decoding: (try? JSONEncoder().encode(failed)) ?? Data(), as: UTF8.self)).value
    }
    created = built.created
    guard relays, input.relayPayload != nil else {
      if let onCreated {
        Task {
          // A pushed form hands over to the conversation prepared beneath it: the sent text flies
          // into its bubble while the form fades, never sliding back like a return to Home.
          do { try await onCreated(built.created as! [String: Any]); close(crossfade: params.pushed == true) }
          catch { controller.submissionFailed(); LodyToastOverlay.shared.show(message: String(localized: "session.toast.openFailed", bundle: .lody), kind: .error) }
        }
      } else { LodyShell.shared.finish(from: self, value: built.created); close() }
      return
    }
    opening = true
    Task {
      do {
        if let onCreated { try await onCreated(built.created as! [String: Any]) }
        else { try await LodyShell.shared.callback(from: self, name: "onCreated", value: built.created ?? NSNull()) }
      } catch {
        guard opening, (error as NSError).localizedDescription != "request_reset" else { return }
        opening = false
        created = nil
        controller.submissionFailed()
        LodyToastOverlay.shared.show(message: String(localized: "session.toast.openFailed", bundle: .lody), kind: .error)
        return
      }
      opening = false
    }
  }

  private func relayReady() {
    guard let created else { return }
    LodyShell.shared.finish(from: self, value: created)
    close()
  }

  private func close(crossfade: Bool = false) {
    LodyShell.shared.close(from: self, crossfade: crossfade)
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
