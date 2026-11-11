import LodyCore
import LodyDesignSystem
import SwiftUI
import UIKit

@MainActor
final class CreateSessionController: UIViewController, UIGestureRecognizerDelegate {
  var form = CreateSessionForm()
  var loadCachedOptions: (() async -> CreationOptions?)?
  var loadOptions: (() async throws -> CreationOptions)?
  /// The workspace's Agent Roles; the run config shows no Role row until they are listed.
  var loadRoles: (() async throws -> [RuntimeContract.AgentRoleItem])?
  var loadProjectGroups: (() async throws -> [RuntimeContract.ProjectGroupItem])?
  private var groupsTask: Task<Void, Never>?
  private var rolesTask: Task<Void, Never>?
  var loadRepositories: (() async throws -> [CreateProject])?
  var loadCachedBranches: ((_ repo: String) async -> CreateBranches?)?
  var loadBranches: ((_ repo: String, _ page: Int) async throws -> CreateBranches)?
  var onBranches: ((String, CreateBranches) -> Void)?
  private var branchTask: Task<Void, Never>?
  private weak var branchPicker: CreateBranchController?
  var browseProject: (() async -> CreateProject?)?
  var onPrefs: ((CreatePrefs) -> Void)?
  var onSelection: ((CreateSessionForm) -> Void)?
  var onSubmit: ((CreateSessionDraft?, [String: Any]) -> Void)?
  var onCancel: (() -> Void)?
  var showMessage: ((String, LodyToastKind) -> Void)?
  var restoreDraft: ((Int) -> Void)?
  private(set) var sending = false
  /// Pushed full screen: lead with a back button instead of the sheet's close button.
  var pushed = false
  private var restoreToken = 0

  let composer: ChatComposerView
  private let host: UIView
  /// Computer / project / worktree-or-branch cards with inline lists (SwiftUI), and the
  /// composer chip's run-config sheet, both driven by one state object.
  private let panelState = CreatePanelState()
  private lazy var context = UIHostingController(rootView: CreateContextPanel(state: panelState))
  private weak var runConfigSheet: UIViewController?
  private let signedOutLabel = UILabel()
  private lazy var hostHeight = host.heightAnchor.constraint(equalToConstant: 64)
  private var optionsTask: Task<Void, Never>?
  private var composingConstraints: [NSLayoutConstraint] = []
  private var searchingConstraints: [NSLayoutConstraint] = []
  isolated deinit {
    branchTask?.cancel()
    optionsTask?.cancel()
  }

  init(composer: ChatComposerView, host: UIView) {
    self.composer = composer
    self.host = host
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = String(localized: "create.title", bundle: .lody)
    navigationItem.backButtonDisplayMode = .minimal
    let close = UIButton(type: .close)
    close.accessibilityLabel = String.localizedStringWithFormat(String(localized: "accessibility.closeSheet", bundle: .lody), String(describing: String(localized: "create.title", bundle: .lody)))
    close.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .primaryActionTriggered)
    close.frame = CGRect(x: 0, y: 0, width: 30, height: 30)
    if pushed {
      let back = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), primaryAction: UIAction { [weak self] _ in self?.onCancel?() })
      back.accessibilityLabel = String(localized: "common.back", bundle: .lody)
      navigationItem.leftBarButtonItem = back
    } else {
      navigationItem.rightBarButtonItem = UIBarButtonItem(customView: close)
    }

    view.backgroundColor = LodyUIColor.bgBase
    let dismissKeyboard = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
    dismissKeyboard.cancelsTouchesInView = false
    dismissKeyboard.delegate = self
    view.addGestureRecognizer(dismissKeyboard)
    panelState.onPick = { [weak self] id, option in self?.optionPicked(id, option) }
    panelState.onRetry = { [weak self] in self?.load() }
    panelState.onWorktree = { [weak self] on in
      guard let self, !self.sending else { return }
      self.form.current.worktree = on
      self.changed(prefs: false)
    }
    composer.onRunConfig = { [weak self] in self?.presentRunConfig() }
    addChild(context)
    context.view.backgroundColor = .clear
    context.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(context.view)
    context.didMove(toParent: self)
    signedOutLabel.text = String(localized: "native.share.signIn", bundle: .lody)
    signedOutLabel.font = LodyTextStyle.body.uiFont
    signedOutLabel.adjustsFontForContentSizeCategory = true
    signedOutLabel.textColor = LodyUIColor.textSecondary
    signedOutLabel.textAlignment = .center
    signedOutLabel.numberOfLines = 0
    signedOutLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(signedOutLabel)

    host.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(host)
    let keyboard = host.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -LodySpacing.sm)
    keyboard.priority = .defaultHigh
    composingConstraints = [keyboard, context.view.bottomAnchor.constraint(equalTo: host.topAnchor)]
    let searchBottom = context.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -LodySpacing.sm)
    searchBottom.priority = .defaultHigh
    searchingConstraints = [
      host.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -LodySpacing.sm),
      searchBottom,
      context.view.bottomAnchor.constraint(lessThanOrEqualTo: host.topAnchor),
    ]
    NotificationCenter.default.addObserver(self, selector: #selector(searchFocusChanged(_:)), name: UITextField.textDidBeginEditingNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(searchFocusChanged(_:)), name: UITextField.textDidEndEditingNotification, object: nil)
    NSLayoutConstraint.activate([
      host.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      host.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -16),
      hostHeight,
      // The context fills the space above the composer, bottom-aligned within thumb reach, and
      // rides up with it; expanded lists grow upward and scroll when they run out of room.
      context.view.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      context.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      context.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      signedOutLabel.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
      signedOutLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: LodyLayout.screenPaddingX * 2),
      signedOutLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -LodyLayout.screenPaddingX * 2),
    ])
    NSLayoutConstraint.activate(composingConstraints)
    composer.setInputIdentifier("create-session-input")
    composer.setComposerState(CreateJSON.encode(["placeholder": String(localized: "create.composer.placeholder", bundle: .lody)]))
    render()
    // One workspace-wide snapshot; cached options render before the complete runtime response.
    load()
    fetchBranches()
    loadAgentRoles()
    loadGroups()
  }

  @objc private func searchFocusChanged(_ notification: Notification) {
    guard let field = notification.object as? UITextField, field.isDescendant(of: context.view) else { return }
    let searching = notification.name == UITextField.textDidBeginEditingNotification
    NSLayoutConstraint.deactivate(searching ? composingConstraints : searchingConstraints)
    NSLayoutConstraint.activate(searching ? searchingConstraints : composingConstraints)
    view.setNeedsLayout()
  }

  @objc private func dismissKeyboard() { view.endEditing(true) }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let target = touch.view, !target.isDescendant(of: host) else { return false }
    // Search fields in expanded pickers must still be able to take focus.
    var ancestor: UIView? = target
    while let current = ancestor {
      if current is UITextInput { return false }
      ancestor = current.superview
    }
    return true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

  func setComposerHeight(_ height: CGFloat) {
    guard hostHeight.constant != height else { return }
    hostHeight.constant = height
    viewIfLoaded?.setNeedsLayout()
  }

  func render() {
    guard isViewLoaded else { return }
    let signedOut = form.signedOut
    signedOutLabel.isHidden = !signedOut
    context.view.isHidden = signedOut
    if !signedOut {
      let panel = CreateSessionContext.panel(form)
      if panelState.panel != panel { panelState.panel = panel }
      let rows = CreateSessionContext.runConfig(form)
      if panelState.runConfig != rows { panelState.runConfig = rows }
      let recents = CreateSessionContext.recents(form)
      if panelState.recents != recents { panelState.recents = recents }
    }
    renderComposer()
  }

  /// Web's run-config sheet from the composer chip: Agent (when there is a choice), Model,
  /// Reasoning and Mode rows that expand in place.
  private func presentRunConfig() {
    guard !sending, runConfigSheet == nil, !panelState.runConfig.isEmpty else { return }
    view.endEditing(true)
    panelState.openInSheet = nil
    let sheet = UIHostingController(rootView: CreateRunConfigSheet(state: panelState))
    var contentHeight = CGFloat(panelState.runConfig.count + panelState.recents.count) * (LodySize.controlMd + LodySpacing.xs * 2)
      + LodySpacing.xl + LodySize.controlMd + LodySpacing.lg
    sheet.rootView = CreateRunConfigSheet(state: panelState, onHeightChange: { [weak sheet] height in
      guard height > 0, abs(contentHeight - height) > 1 else { return }
      contentHeight = height
      sheet?.sheetPresentationController?.animateChanges {
        sheet?.sheetPresentationController?.invalidateDetents()
      }
    })
    if let presentation = sheet.sheetPresentationController {
      presentation.detents = [.custom(identifier: .init("runConfigContent")) { context in
        min(contentHeight, context.maximumDetentValue)
      }]
      presentation.prefersGrabberVisible = true
    }
    runConfigSheet = sheet
    present(sheet, animated: true)
  }

  /// A choice in the context panel or the run-config sheet.
  private func optionPicked(_ id: String, _ option: String) {
    guard !sending else { return render() }
    switch (id, option) {
    case ("project", CreateSessionContext.chatOption):
      guard !form.current.chat else { return }
      form.selectProject(nil)
      branchTask?.cancel()
      branchPicker = nil
      changed()
    case ("project", CreateSessionContext.moreOption):
      pickProject()
    case ("branch", CreateSessionContext.loadMoreOption):
      fetchBranches()
    case ("branch", _):
      guard form.current.branches?.names.contains(option) == true else { return }
      form.selectBranch(option)
      changed()
    case ("model", _):
      composerOptionChanged(["modelId": option, "effort": form.current.choice.effort ?? ""])
    case ("effort", _):
      composerOptionChanged(["modelId": form.current.choice.modelId ?? "", "effort": option])
    case ("permission", _):
      composerOptionChanged(["permissionId": option])
    case ("project", _):
      guard let project = form.projects.first(where: { $0.id == option }) else { return pickProject() }
      apply(project)
    case ("machine", _):
      pickMachine(option)
    case ("agent", _):
      form.selectAgent(option)
      changed()
    case ("role", _):
      form.selectRole(option == CreateSessionContext.roleNoneOption ? nil : option)
      changed()
    case (CreateSessionContext.recentRow, _):
      form.selectRecent(option)
      changed()
      // A recent entry is a terminal "run it like this" choice (web closes its menu).
      runConfigSheet?.dismiss(animated: true)
    default:
      break
    }
  }

  private func renderComposer() {
    let page = form.current
    let capability = page.capability
    let fast = CreateLogic.fastMode(capability, page.choice)
    var options: [String: Any] = [
      "modelId": page.choice.modelId ?? "", "effort": page.choice.effort ?? "",
      "models": (capability?.models ?? []).map { ["id": $0.id, "title": $0.name] },
      "efforts": CreateLogic.effortsFor(capability, modelId: page.choice.modelId).map { ["id": $0, "title": $0] },
    ]
    if let permission = CreateLogic.permissionMode(capability, page.choice) {
      options["permissionId"] = permission.value ?? ""
      options["permissions"] = permission.options.map { ["id": $0.id, "title": $0.name, "description": $0.description ?? ""] }
    }
    if let fast { options["fast"] = fast.enabled }
    if let agent = page.agent { options["agentName"] = agent.name }
    if let asset = LodyAgentIcon.asset(cliType: page.agent?.cliType, agentType: page.agent?.agentType) { options["agentAsset"] = asset }
    if let role = form.activeRole {
      options["roleEmoji"] = role.glyph
      options["roleName"] = role.role.name
    }
    composer.setComposerOptions(Self.json(options))
    composer.setComposerState(Self.json([
      "editable": true, "canSend": form.canSend, "sending": sending, "notice": form.notice,
      "reconnect": false, "placeholder": placeholder,
    ]))
  }

  /// Web's landing prompt: "Work with <assistant>" once one is chosen — the Agent Role when one is.
  private var placeholder: String {
    guard let agent = form.current.agent else { return String(localized: "create.composer.placeholder", bundle: .lody) }
    let name = form.activeRole?.role.name ?? agent.name
    return String.localizedStringWithFormat(String(localized: "create.composer.placeholderAgent", bundle: .lody), name)
  }

  private static func json(_ value: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }

  private func changed(prefs: Bool = true) {
    render()
    if prefs, let value = form.prefs { onPrefs?(value) }
    onSelection?(form)
  }

  /// The last options read failed; the host reads again when the runtime comes back.
  var optionsFailed: Bool { form.current.failed }

  func load(background: Bool = false) {
    guard !sending else { return }
    if !background {
      form.current.loading = true
      render()
    }
    optionsTask?.cancel()
    optionsTask = Task { [weak self] in
      do {
        if let self, self.form.current.options == nil, let cached = await self.loadCachedOptions?() {
          guard !Task.isCancelled else { return }
          self.form.applyCachedOptions(cached)
          self.changed(prefs: false)
        }
        guard let options = try await self?.loadOptions?() else { return }
        guard let self, !Task.isCancelled else { return }
        self.form.applyOptions(options)
        self.changed(prefs: false)
      } catch is CancellationError {
        return
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.form.failOptions()
        self.changed(prefs: false)
      }
    }
  }

  /// Multi-repository projects are read once per page; a failure simply leaves them out.
  private func loadGroups() {
    groupsTask?.cancel()
    groupsTask = Task { [weak self] in
      guard let groups = try? await self?.loadProjectGroups?(), let self, !Task.isCancelled else { return }
      self.form.applyGroups(groups)
      self.render()
    }
  }

  /// Roles are read once per page; a failure simply leaves the Role row out.
  private func loadAgentRoles() {
    rolesTask?.cancel()
    rolesTask = Task { [weak self] in
      guard let roles = try? await self?.loadRoles?(), let self, !Task.isCancelled else { return }
      self.form.roles = roles
      self.render()
    }
  }

  private func push(_ controller: UIViewController) {
    navigationController?.pushViewController(controller, animated: true)
  }

  private func pickProject() {
    let machine = form.current.machine
    let machineId = machine?.id ?? form.current.machineId
    let picker = CreateProjectPickerController(
      projects: form.availableProjects, machineNames: form.machineNames, selectedId: form.current.projectId,
      machineName: form.machineNames[machineId] ?? machine?.name,
      loadRepositories: loadRepositories, browse: browseProject)
    picker.onPick = { [weak self, weak picker] project in
      guard let self else { return }
      picker?.navigationController?.popViewController(animated: true)
      self.apply(project)
    }
    push(picker)
  }

  private func apply(_ project: CreateProject) {
    let changedProject = project.id != form.current.projectId
    form.selectProject(project)
    if changedProject {
      branchTask?.cancel()
      branchPicker = nil
      fetchBranches()
    }
    changed(prefs: false)
  }

  /// A local project belongs to one computer: picking another moves to that computer's most
  /// recent project, or to a chat there when it has none. Chats and GitHub projects just switch.
  private func pickMachine(_ id: String) {
    let page = form.current
    guard page.local, let current = form.projects.first(where: { $0.id == page.projectId }), current.machineId != id else {
      form.selectMachine(id)
      return changed()
    }
    if let next = form.projects.first(where: { $0.machineId == id && !CreateProjectPicker.isGithub($0.id) }) {
      apply(next)
    } else {
      form.selectProject(nil)
      form.selectMachine(id)
      branchTask?.cancel()
      branchPicker = nil
      changed()
    }
  }

  private func pickMachine() {
    let page = form.current
    push(CreateChoiceController(
      title: String(localized: "create.row.selectMachine", bundle: .lody), header: String(localized: "create.label.machine", bundle: .lody),
      placeholder: String(localized: "create.picker.machine.placeholder", bundle: .lody),
      options: page.machines.map { ($0.id, $0.name, "") }, selected: page.machine?.id
    ) { [weak self] id in
      self?.form.selectMachine(id)
      self?.changed()
    })
  }

  private func pickAgent() {
    let page = form.current
    push(CreateChoiceController(
      title: String(localized: "create.row.selectAgent", bundle: .lody), header: String(localized: "create.label.agent", bundle: .lody),
      placeholder: String(localized: "create.picker.agent.placeholder", bundle: .lody),
      options: page.agents.map { ($0.key, $0.name, $0.machineName) }, selected: page.agentKey,
      marks: Dictionary(page.agents.map { ($0.key, LodyAgentIcon.mark(cliType: $0.cliType, agentType: $0.agentType)) }, uniquingKeysWith: { first, _ in first })
    ) { [weak self] key in
      self?.form.selectAgent(key)
      self?.changed()
    })
  }

  private func pickModel() {
    let page = form.current
    guard let capability = page.capability else { return }
    let title = CreateModelOptions.hasTabs(capability)
      ? (page.agent?.name ?? String(localized: "model.title", bundle: .lody))
      : String(localized: "create.row.selectModel", bundle: .lody)
    let controller = CreateModelController(capability: capability, choice: page.choice)
    controller.title = title
    controller.choiceForModel = { [weak self] modelId in
      guard let self else { return ModelChoice(modelId: modelId) }
      return CreateLogic.rememberedModelChoice(
        self.form.prefs, agentKey: self.form.current.agentKey, capability: capability, modelId: modelId)
    }
    controller.onChange = { [weak self] choice in
      self?.form.updateChoice(choice)
      self?.changed()
    }
    push(controller)
  }

  func fetchBranches() {
    guard form.current.github, !form.current.branchesLoading, let loadBranches else { return }
    if !form.current.branchesStale && form.current.branches != nil && (form.current.branches?.nextPage == nil || form.deferUnresolved) { return }
    let projectId = form.current.projectId
    let repo = String(projectId.dropFirst(7))
    let page = form.current.branchesStale ? 1 : (form.current.branches?.nextPage ?? 1)
    form.current.branchesLoading = true
    form.current.branchesFailed = false
    render()
    updateBranchPicker()
    branchTask?.cancel()
    branchTask = Task { [weak self] in
      if page == 1, let cached = await self?.loadCachedBranches?(repo) {
        guard let self, !Task.isCancelled, self.form.current.projectId == projectId else { return }
        self.form.applyCachedBranches(cached)
        self.form.current.branchesLoading = true
        self.changed(prefs: false)
        self.updateBranchPicker()
      }
      do {
        let value = try await loadBranches(repo, page)
        guard let self, !Task.isCancelled, self.form.current.projectId == projectId else { return }
        self.form.applyBranches(value, replacing: page == 1)
        if let branches = self.form.current.branches { self.onBranches?(repo, branches) }
      } catch {
        guard let self, !Task.isCancelled, self.form.current.projectId == projectId else { return }
        self.form.current.branchesLoading = false
        self.form.current.branchesFailed = true
      }
      self?.changed(prefs: false)
      self?.updateBranchPicker()
    }
  }

  private func updateBranchPicker() {
    branchPicker?.update(form.current, cachedOnly: form.deferUnresolved)
  }

  private func pickBranch() {
    let projectId = form.current.projectId
    let picker = CreateBranchController(repo: String(projectId.dropFirst(7)))
    picker.onMore = { [weak self] in self?.fetchBranches() }
    picker.onPick = { [weak self] name in
      guard let self, self.form.current.projectId == projectId,
        self.form.current.branches?.names.contains(name) == true else { return }
      self.form.selectBranch(name)
      self.changed()
    }
    branchPicker = picker
    updateBranchPicker()
    push(picker)
  }

  func composerOptionChanged(_ body: [String: Any]) {
    let page = form.current
    if let permission = body["permissionId"] as? String {
      form.updateChoice(CreateLogic.withPermissionMode(page.capability, page.choice, value: permission))
    } else if let fast = body["fast"] as? Bool {
      form.updateChoice(CreateLogic.withFastMode(page.capability, page.choice, enabled: fast))
    } else {
      let modelId = (body["modelId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      if modelId != page.choice.modelId {
        form.selectModel(modelId)
      } else {
        var next = page.choice
        next.effort = (body["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        form.updateChoice(next)
      }
    }
    changed()
  }

  @discardableResult
  func submit(_ payload: [String: Any]) -> Bool {
    let text = payload["text"] as? String ?? ""
    let attachments = payload["attachments"] as? [Any] ?? []
    let draft = form.current.options.flatMap { form.draft(sessionId: $0.sessionId) }
    guard !sending, form.canSend, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty,
      draft != nil || form.deferUnresolved
    else {
      restore()
      return false
    }
    if !form.deferUnresolved && form.current.github && form.current.branch.trimmingCharacters(in: .whitespaces).isEmpty {
      restore()
      message(String(localized: "create.toast.branchRequired", bundle: .lody), kind: .warning)
      return false
    }
    form.updateChoice(form.current.choice)
    if draft != nil { form.recordRecent() }
    if let value = form.prefs { onPrefs?(value) }
    sending = true
    renderComposer()
    onSubmit?(draft, payload)
    return true
  }

  func submissionFailed() {
    sending = false
    restore()
    renderComposer()
  }

  private func restore() {
    restoreToken += 1
    if let restoreDraft { restoreDraft(restoreToken) } else { composer.restoreDraft(token: restoreToken) }
  }

  func message(_ text: String, kind: LodyToastKind = .error) {
    if let showMessage { return showMessage(text, kind) }
    let alert = UIAlertController(title: text, message: nil, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
    present(alert, animated: true)
  }
}
