import UIKit
import LodyCore

struct AgentProviderFields: Encodable, Sendable {
  var name: String
  var prompt: String
  var cliType: String
  var agentType: String
  var command: String
  var args: [String]
  var detailRevision: String?
  var description: String?
  var envPatch: [String: String?]?
  var runtimeOverrides: ProviderJSON?
  var titleGeneration: ProviderJSON?
  var codexAuth: ProviderJSON?
  var presetId: String?
  var presetModeId: String?
  var presetEndpoint: String?
}

@MainActor
final class AgentProviderEditorController: LodyFormController {
  var saved: ((AgentProviderSnapshot) -> Void)?
  /// The provisional row, shown in the list while the save is in flight.
  var willSave: ((AgentProviderItem) -> Void)?
  var saveFailed: (() -> Void)?
  var deleteRequested: ((AgentProviderItem) -> Void)?
  private let header = AgentProviderHeaderView()
  private let usage = AgentProviderUsageView()
  private var usageGroup: LodyFormGroup?
  private var actionsGroup: LodyFormGroup?
  private lazy var deleteButton = LodyFormButton.make(id: "provider-delete", title: text("delete"), destructive: true) { [weak self] in
    self?.confirmDelete()
  }
  private var deleteGroup: LodyFormGroup?
  private let machine: AgentProviderMachine
  private var item: AgentProviderItem?
  private let catalog: [AgentProviderCatalogItem]
  private let scope: SettingsActor
  private let scopeKey: String
  private let service: AgentProviderService
  private let details: ProviderDetailService
  private let presets: [ProviderPreset]
  private let advanced = AgentProviderAdvanced()
  private let testButton = UIButton(type: .system)
  private let authButton = UIButton(type: .system)
  private var operationButtons: [String: UIButton] = [:]
  private let operationStatus = LodyFormGroup.caption()
  private let operationSpinner = UIActivityIndicatorView(style: .medium)
  private var progressObserver: NSObjectProtocol?
  private var activeOperation: String?
  private var detailLoading = false
  private var detailFailed = false
  private let newID = UUID().uuidString.lowercased()
  private var selected: AgentProviderCatalogItem?
  private var busy = false
  private var invalid = false
  private var uncertain = false
  private let provider = UIButton(type: .system)
  private var commandGroup: LodyFormGroup?
  private lazy var name = LodyFormField(id: "provider-name", label: text("name"), text: item?.name ?? "", limit: 200)
  private lazy var prompt = LodyFormTextView(id: "provider-prompt", label: text("prompt"), text: item?.prompt ?? "", limit: 32000, minHeight: 160)
  private lazy var command = LodyFormField(id: "provider-command", label: text("command"), text: item?.command ?? "", limit: 4096)
  private lazy var args = LodyFormTextView(id: "provider-args", label: text("args"), text: (item?.args ?? []).joined(separator: "\n"), limit: 32000, minHeight: 88)
  private lazy var cancelItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in self?.closeForm() }
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: RemoteSettingsSections.remote("save"), prominent: true) { [weak self] in self?.save() }

  init(machine: AgentProviderMachine, item: AgentProviderItem?, catalog: [AgentProviderCatalogItem], scope: SettingsActor,
       service: @escaping AgentProviderService, details: ProviderDetailService = .cloud, presets: [ProviderPreset] = []) {
    self.machine = machine
    self.item = item
    self.catalog = catalog
    self.scope = scope
    scopeKey = scope.key
    self.service = service
    self.details = details
    self.presets = presets
    super.init(nibName: nil, bundle: nil)
    if let item {
      selected = catalog.first { $0.cliType == item.cliType && $0.agentType == item.agentType }
        ?? AgentProviderCatalogItem(id: item.agentType, name: RemoteSettingsSections.agentName(item.agentType), cliType: item.cliType, agentType: item.agentType)
    } else {
      selected = catalog.first
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    scope.watch(self) { [weak self] in
      guard let self else { return }
      self.invalid = self.scope.key != self.scopeKey
      self.render()
    }
    name.clearButtonMode = .whileEditing
    command.clearButtonMode = .whileEditing
    provider.accessibilityIdentifier = "provider-type"
    provider.showsMenuAsPrimaryAction = true
    provider.menu = UIMenu(children: catalog.map { option in
      UIAction(title: option.name, state: option.id == selected?.id ? .on : .off) { [weak self] _ in
        guard let self else { return }
        self.selected = option
        self.advanced.select(option, presets: self.presets)
        if self.name.trimmed.isEmpty { self.name.text = option.name }
        self.render()
      }
    })
    stack.addArrangedSubview(header)
    stack.addArrangedSubview(LodyFormGroup(LodyFormRow(label: text("provider"), content: provider, picker: true), name))
    let custom = LodyFormGroup(header: text("custom"), footer: text("argsHint"), command, args)
    commandGroup = custom
    stack.addArrangedSubview(custom)
    stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), footer: RemoteSettingsSections.remote("agentHint"), prompt))
    let usageGroup = LodyFormGroup(header: text("usage"), usage)
    self.usageGroup = usageGroup
    stack.addArrangedSubview(usageGroup)
    advanced.configure(machine: machine)
    advanced.select(selected, presets: presets)
    advanced.changed = { [weak self] in self?.render() }
    stack.addArrangedSubview(advanced)
    configureAction(testButton, title: text("saveAndTest"), symbol: "checkmark.seal")
    testButton.accessibilityIdentifier = "provider-test"
    testButton.addAction(UIAction { [weak self] _ in self?.save(probe: true) }, for: .touchUpInside)
    configureAction(authButton, title: text("signIn"), symbol: "person.badge.key")
    authButton.accessibilityIdentifier = "provider-sign-in"
    authButton.addAction(UIAction { [weak self] _ in self?.authenticate() }, for: .touchUpInside)
    var actionRows: [UIView] = [testButton, authButton]
    let symbols = ["binary-status": "shippingbox", "binary-install": "arrow.down.circle",
                   "pi-extension-scan": "puzzlepiece.extension", "rate-limits-refresh": "gauge.with.dots.needle.33percent"]
    for action in ["binary-status", "binary-install", "pi-extension-scan", "rate-limits-refresh"] {
      let button = UIButton(type: .system)
      configureAction(button, title: text(action), symbol: symbols[action] ?? "circle")
      button.accessibilityIdentifier = "provider-" + action
      button.addAction(UIAction { [weak self] _ in self?.operate(action) }, for: .touchUpInside)
      operationButtons[action] = button
      actionRows.append(button)
    }
    let actions = LodyFormGroup(header: text("actions"), footer: text("testPersists"), rows: actionRows)
    actionsGroup = actions
    stack.addArrangedSubview(actions)
    operationSpinner.hidesWhenStopped = true
    operationStatus.accessibilityIdentifier = "provider-operation-status"
    let status = UIStackView(arrangedSubviews: [operationSpinner, operationStatus])
    status.spacing = 8
    status.alignment = .center
    stack.addArrangedSubview(LodyFormGroup.inset(status))
    if item != nil, !isReadOnly {
      let group = LodyFormGroup(deleteButton)
      deleteGroup = group
      stack.addArrangedSubview(group)
    }
    progressObserver = NotificationCenter.default.addObserver(forName: .lodyProviderOperationProgress, object: nil, queue: .main) { [weak self] notification in
      guard let progress = notification.object as? RuntimeContract.AgentProviderOperationProgress else { return }
      let eventScope = notification.userInfo?["scopeKey"] as? String
      MainActor.assumeIsolated {
        guard let self, self.scope.key == self.scopeKey, eventScope == self.scopeKey,
              self.activeOperation == "binary-install", self.item?.id == progress.id,
              self.machine.id == progress.machineId else { return }
        var label = self.text("binary." + progress.status)
        if let percent = progress.percent, percent.isFinite { label += " · \(Int(min(100, max(0, percent))))%" }
        self.operationStatus.text = label
      }
    }
    if item == nil {
      let hint = LodyFormGroup.caption()
      hint.text = text("setupHint")
      hint.numberOfLines = 0
      stack.insertArrangedSubview(LodyFormGroup.inset(hint), at: 2)
    }
    name.changed = { [weak self] in self?.render() }
    command.changed = { [weak self] in self?.render() }
    render()
    if item != nil { loadDetail() }
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItems = [cancelItem]
    header?.rightBarButtonItems = isReadOnly ? [] : [saveItem]
    render()
  }

  private var isReadOnly: Bool { machine.readOnly || item?.readOnly == true }

  private func render() {
    guard isViewLoaded else { return }
    let editable = !busy && !detailLoading && !detailFailed && !invalid && !uncertain && !isReadOnly
    name.isEnabled = editable
    prompt.isEditable = editable
    command.isEnabled = editable
    args.isEditable = editable
    provider.isEnabled = editable && item == nil
    provider.setTitle(selected?.name ?? text("provider"), for: .normal)
    header.update(
      name: name.trimmed.isEmpty ? (selected?.name ?? text("provider")) : name.trimmed,
      detail: [selected?.name ?? "", machine.name.isEmpty ? machine.id : machine.name].filter { !$0.isEmpty }.joined(separator: " · "),
      asset: LodyAgentIcon.asset(cliType: selected?.cliType ?? "builtin", agentType: selected?.agentType ?? "") ?? "",
      custom: selected?.cliType == "custom", online: machine.online
    )
    let windows = usageWindows()
    usage.update(windows)
    usageGroup?.isHidden = windows.isEmpty
    deleteButton.isEnabled = !busy && !invalid && !uncertain
    provider.menu = UIMenu(children: catalog.map { option in
      UIAction(title: option.name, state: option.id == selected?.id ? .on : .off) { [weak self] _ in
        guard let self else { return }
        let prior = self.selected?.name
        self.selected = option
        self.advanced.select(option, presets: self.presets)
        if self.name.trimmed.isEmpty || self.name.trimmed == prior { self.name.text = option.name }
        self.render()
      }
    })
    advanced.setEditable(editable)
    authButton.isEnabled = editable && item != nil && advanced.detail?.supportsAuthentication == true
    setRow(authButton, hidden: item == nil || advanced.detail?.supportsAuthentication != true)
    setRow(testButton, hidden: isReadOnly)
    commandGroup?.isHidden = selected?.cliType != "custom"
    saveItem.isEnabled = editable && advanced.isValid && selected != nil && !name.trimmed.isEmpty
      && (selected?.cliType != "custom" || !command.trimmed.isEmpty)
    testButton.isEnabled = saveItem.isEnabled
    cancelItem.isEnabled = !busy
    isModalInPresentation = busy
    if invalid { advanced.clearSecrets() }
    if activeOperation != nil { operationSpinner.startAnimating() } else { operationSpinner.stopAnimating() }
    for (action, button) in operationButtons {
      // Unavailable or unsupported operations are left out rather than listed with a reason.
      var supported = advanced.detail?.unavailableActions.contains(where: { $0.action == action }) != true
      if action == "rate-limits-refresh" { supported = supported && item != nil && advanced.detail?.supportsRateLimitsRefresh != false }
      if action.hasPrefix("binary-") { supported = supported && ["builtin", "registry"].contains(selected?.cliType ?? "") }
      if action == "pi-extension-scan" {
        supported = supported && selected?.agentType == "pi" && (advanced.detail?.supportsPiExtensions ?? machine.supportsPiExtensions) == true
      }
      button.isEnabled = editable && machine.online
      setRow(button, hidden: !supported || isReadOnly)
    }
    actionsGroup?.isHidden = isReadOnly
    if invalid || uncertain || detailFailed {
      let notice = LodyFormGroup.caption(color: .systemRed, size: 15)
      notice.numberOfLines = 0
      var message = "scopeChanged"
      if uncertain { message = "writeFailed" }
      if detailFailed { message = "detailFailed" }
      notice.text = text(message)
      let container = LodyFormGroup.inset(notice)
      container.accessibilityIdentifier = "provider-editor-notice"
      // Under the header, where it is seen before any field it disables.
      if !stack.arrangedSubviews.contains(where: { $0.accessibilityIdentifier == "provider-editor-notice" }) {
        stack.insertArrangedSubview(container, at: min(1, stack.arrangedSubviews.count))
      }
    }
  }

  private func save(probe: Bool = false) {
    guard saveItem.isEnabled, scope.key == scopeKey, let selected else { return }
    busy = true
    render()
    let customArgs = (args.text ?? "") == (item?.args ?? []).joined(separator: "\n") ? item?.args ?? [] :
      ((args.text ?? "").isEmpty ? [] : (args.text ?? "").components(separatedBy: .newlines))
    var fields = AgentProviderFields(name: name.trimmed, prompt: prompt.text ?? "", cliType: selected.cliType,
                                     agentType: selected.agentType, command: selected.cliType == "custom" ? command.trimmed : "",
                                     args: selected.cliType == "custom" ? customArgs : [])
    advanced.apply(to: &fields)
    let request = AgentProviderRequest(workspaceId: scope.workspaceId, action: "save", machineId: machine.id,
                                       id: item?.id ?? newID, base: item, fields: fields)
    if !probe {
      willSave?(AgentProviderItem(id: request.id ?? newID, machineId: machine.id, name: fields.name, cliType: fields.cliType,
                                  agentType: fields.agentType, prompt: fields.prompt, readOnly: false,
                                  command: fields.command, args: fields.args))
    }
    Task { [weak self, service] in
      do {
        let next = try await service(request)
        guard let self, self.scope.key == self.scopeKey else { return }
        self.busy = false
        self.saved?(next)
        self.advanced.clearSecrets()
        if probe, let item = next.providers.first(where: { $0.id == request.id }) {
          self.item = item
          await self.runProbe()
        } else {
          self.closeForm()
        }
      } catch {
        guard let self else { return }
        self.busy = false
        // A lost reply may have saved or scheduled the provider. Reopen after a fresh list instead of replaying.
        self.uncertain = true
        self.saveFailed?()
        LodyToastOverlay.shared.show(message: self.text("writeFailed"), kind: .error)
        self.render()
      }
    }
  }

  private var target: ProviderTarget {
    ProviderTarget(workspaceId: scope.workspaceId, machineId: machine.id, id: item?.id ?? newID)
  }

  private func loadDetail() {
    detailLoading = true
    render()
    Task { [weak self, details, target] in
      do {
        let detail = try await details.detail(target)
        guard let self, self.scope.key == self.scopeKey else { return }
        self.detailLoading = false
        if let preset = self.presets.first(where: { $0.id == detail.presetId }) {
          self.selected = AgentProviderCatalogItem(id: preset.id, name: preset.name, cliType: preset.cliType, agentType: preset.agentType, presetId: preset.id)
          self.advanced.select(self.selected, presets: self.presets)
        }
        self.advanced.load(detail)
        self.render()
      } catch {
        guard let self, self.scope.key == self.scopeKey else { return }
        self.detailLoading = false
        self.detailFailed = true
        self.render()
      }
    }
  }

  private func runProbe() async {
    busy = true
    render()
    do {
      let result = try await details.probe(target)
      guard scope.key == scopeKey else { return }
      advanced.updateCapabilities(result.capabilities)
      busy = false
      var message = result.success ? "testPassed" : "testFailed"
      if result.authRequired { message = "authRequired" }
      LodyToastOverlay.shared.show(message: text(message), kind: result.success ? .success : .warning)
      loadDetail()
    } catch {
      guard scope.key == scopeKey else { return }
      busy = false
      LodyToastOverlay.shared.show(message: text("testFailed"), kind: .error)
      loadDetail()
    }
  }

  private func operate(_ action: String) {
    guard operationButtons[action]?.isEnabled == true, !busy, !detailLoading, !detailFailed, !uncertain, !invalid, !isReadOnly, scope.key == scopeKey else { return }
    busy = true
    activeOperation = action
    operationStatus.text = text(action == "binary-install" ? "installing" : "working")
    render()
    let request = ProviderOperationRequest(workspaceId: scope.workspaceId, machineId: machine.id, id: item?.id, action: action,
                                           cliType: item == nil && action.hasPrefix("binary-") ? selected?.cliType : nil,
                                           agentType: item == nil && action.hasPrefix("binary-") ? selected?.agentType : nil)
    Task { [weak self, details] in
      do {
        let result = try await details.operation(request)
        guard let self, self.scope.key == self.scopeKey else { return }
        self.busy = false
        self.activeOperation = nil
        if let extensions = result.extensions { self.advanced.showExtensions(extensions) }
        var message = result.success ? self.text("operationComplete") : self.text("operationFailed")
        if let status = result.status { message = self.text("binary.\(status)") }
        if let version = result.version { message += " · " + version }
        self.operationStatus.text = message
        self.render()
      } catch {
        guard let self, self.scope.key == self.scopeKey else { return }
        self.busy = false
        self.activeOperation = nil
        self.operationStatus.text = self.text("operationUnknown")
        self.render()
      }
    }
  }

  isolated deinit {
    if let progressObserver { NotificationCenter.default.removeObserver(progressObserver) }
  }

  private func authenticate() {
    guard let detail = advanced.detail, let item, !busy, scope.key == scopeKey else { return }
    let controller = AgentProviderAuthController(target: target, methods: detail.supportsMethodSelection ? detail.capabilities.authMethods : [], scope: scope, service: details)
    controller.authenticated = { [weak self] in
      guard let self else { return }
      self.operationStatus.text = self.text("auth.authenticated")
    }
    LodyShell.shared.presentNative(controller, title: item.name, detents: [1])
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || navigationController?.isBeingDismissed == true { advanced.clearSecrets() }
  }

  /// Hides a group row together with the hairline drawn after it.
  private func setRow(_ view: UIView, hidden: Bool) {
    view.isHidden = hidden
    guard let group = view.superview as? UIStackView, let index = group.arrangedSubviews.firstIndex(of: view),
          index + 1 < group.arrangedSubviews.count else { return }
    group.arrangedSubviews[index + 1].isHidden = hidden
  }

  private func configureAction(_ button: UIButton, title: String, symbol: String) {
    var configuration = UIButton.Configuration.plain()
    configuration.title = title
    configuration.image = UIImage(systemName: symbol)
    configuration.imagePadding = 12
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0)
    configuration.baseForegroundColor = .lodyInk
    button.configuration = configuration
    button.contentHorizontalAlignment = .leading
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
  }

  private func usageWindows() -> [LodyListVisualItem] {
    guard let item, let reported = RemoteSettingsContext.current().agentUsage[machine.id] else { return [] }
    let setting = RemoteSetting(kind: "agent", id: item.id, name: item.name, machineId: machine.id, detail: item.agentType)
    return RemoteSettingsSections.rings(setting, reported, now: LodyRelativeTime.now())
  }

  private func confirmDelete() {
    guard let item, !busy else { return }
    SettingsPage.confirm(from: self, title: text("delete"), message: String.localizedStringWithFormat(text("deleteConfirm"), item.name),
                         action: text("delete"), destructive: true) { [weak self] in
      guard let self, self.scope.key == self.scopeKey else { return }
      self.deleteRequested?(item)
      self.closeForm()
    }
  }

  private func text(_ key: String) -> String { AgentProviderSections.text(key) }
}

/// The editor's opening card: the provider's mark, its name and where it runs.
@MainActor
final class AgentProviderHeaderView: UIView {
  private let mark = UIImageView()
  private let markBackground = UIView()
  private let title = UILabel()
  private let detail = UILabel()
  private let dot = UIView()

  init() {
    super.init(frame: .zero)
    markBackground.backgroundColor = .lodyOpaqueCard
    markBackground.layer.cornerRadius = 16
    markBackground.layer.cornerCurve = .continuous
    mark.contentMode = .scaleAspectFit
    mark.tintColor = .label
    mark.translatesAutoresizingMaskIntoConstraints = false
    markBackground.addSubview(mark)
    title.font = .preferredFont(forTextStyle: .title3).withWeight(.semibold)
    title.adjustsFontForContentSizeCategory = true
    title.numberOfLines = 2
    detail.font = .preferredFont(forTextStyle: .subheadline)
    detail.textColor = .secondaryLabel
    detail.adjustsFontForContentSizeCategory = true
    detail.numberOfLines = 2
    dot.layer.cornerRadius = 4
    let detailRow = UIStackView(arrangedSubviews: [dot, detail])
    detailRow.spacing = 6
    detailRow.alignment = .center
    let text = UIStackView(arrangedSubviews: [title, detailRow])
    text.axis = .vertical
    text.spacing = 3
    let row = UIStackView(arrangedSubviews: [markBackground, text])
    row.spacing = 14
    row.alignment = .center
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      markBackground.widthAnchor.constraint(equalToConstant: 56),
      markBackground.heightAnchor.constraint(equalToConstant: 56),
      mark.centerXAnchor.constraint(equalTo: markBackground.centerXAnchor),
      mark.centerYAnchor.constraint(equalTo: markBackground.centerYAnchor),
      mark.widthAnchor.constraint(equalToConstant: 30),
      mark.heightAnchor.constraint(equalToConstant: 30),
      dot.widthAnchor.constraint(equalToConstant: 8),
      dot.heightAnchor.constraint(equalToConstant: 8),
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: LodyFormGroup.margin),
      row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -LodyFormGroup.margin),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 8),
      row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .header
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  func update(name: String, detail: String, asset: String, custom: Bool, online: Bool) {
    title.text = name
    self.detail.text = detail
    let image = asset.isEmpty ? nil : UIImage(named: asset, in: .main, compatibleWith: nil)
    mark.image = (image ?? UIImage(systemName: custom ? "terminal" : "sparkles"))?.withRenderingMode(.alwaysTemplate)
    dot.backgroundColor = online ? .systemGreen : .tertiaryLabel
    accessibilityLabel = [name, detail].joined(separator: ", ")
  }
}

/// One bar per subscription window: what is left, and when it resets.
@MainActor
final class AgentProviderUsageView: UIStackView {
  init() {
    super.init(frame: .zero)
    axis = .vertical
    spacing = 14
    isLayoutMarginsRelativeArrangement = true
    directionalLayoutMargins = NSDirectionalEdgeInsets(
      top: 12, leading: LodyFormGroup.margin, bottom: 12, trailing: LodyFormGroup.margin
    )
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  func update(_ windows: [LodyListVisualItem]) {
    arrangedSubviews.forEach { $0.removeFromSuperview() }
    for window in windows {
      let label = UILabel()
      label.font = .preferredFont(forTextStyle: .subheadline)
      label.text = window.label
      label.numberOfLines = 0
      let value = UILabel()
      value.font = .preferredFont(forTextStyle: .subheadline).withWeight(.medium)
      value.text = window.value
      value.setContentCompressionResistancePriority(.required, for: .horizontal)
      value.setContentHuggingPriority(.required, for: .horizontal)
      let heading = UIStackView(arrangedSubviews: [label, value])
      heading.spacing = 12
      let bar = UIProgressView(progressViewStyle: .default)
      bar.progressTintColor = window.tone == "warning" ? .systemOrange : .lodyAccent
      bar.trackTintColor = .tertiarySystemFill
      bar.progress = Float(max(0, min(1, 1 - window.fraction)))
      let caption = UILabel()
      caption.font = .preferredFont(forTextStyle: .caption1)
      caption.textColor = .secondaryLabel
      caption.numberOfLines = 0
      caption.text = [window.caption, window.detail].filter { !$0.isEmpty }.joined(separator: " · ")
      let block = UIStackView(arrangedSubviews: [heading, bar, caption])
      block.axis = .vertical
      block.spacing = 6
      block.isAccessibilityElement = true
      block.accessibilityLabel = window.accessibilityLabel
      addArrangedSubview(block)
    }
  }
}
