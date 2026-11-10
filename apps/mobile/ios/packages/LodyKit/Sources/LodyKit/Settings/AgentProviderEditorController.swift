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
    stack.addArrangedSubview(LodyFormGroup(LodyFormRow(label: text("provider"), content: provider), name))
    let custom = LodyFormGroup(header: text("custom"), footer: text("argsHint"), command, args)
    commandGroup = custom
    stack.addArrangedSubview(custom)
    stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), footer: RemoteSettingsSections.remote("agentHint"), prompt))
    advanced.configure(machine: machine)
    advanced.select(selected, presets: presets)
    advanced.changed = { [weak self] in self?.render() }
    stack.addArrangedSubview(advanced)
    testButton.setTitle(text("saveAndTest"), for: .normal)
    testButton.accessibilityIdentifier = "provider-test"
    testButton.addAction(UIAction { [weak self] _ in self?.save(probe: true) }, for: .touchUpInside)
    authButton.setTitle(text("signIn"), for: .normal)
    authButton.accessibilityIdentifier = "provider-sign-in"
    authButton.addAction(UIAction { [weak self] _ in self?.authenticate() }, for: .touchUpInside)
    stack.addArrangedSubview(LodyFormGroup(footer: text("testPersists"), testButton, authButton))
    let operations = LodyFormGroup()
    for action in ["binary-status", "binary-install", "pi-extension-scan", "rate-limits-refresh"] {
      let button = UIButton(type: .system)
      button.accessibilityIdentifier = "provider-" + action
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
      button.addAction(UIAction { [weak self] _ in self?.operate(action) }, for: .touchUpInside)
      operationButtons[action] = button
      operations.addArrangedSubview(button)
    }
    operationSpinner.hidesWhenStopped = true
    operations.addArrangedSubview(operationSpinner)
    operationStatus.accessibilityIdentifier = "provider-operation-status"
    stack.addArrangedSubview(operations)
    stack.addArrangedSubview(LodyFormGroup.inset(operationStatus))
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
      stack.addArrangedSubview(LodyFormGroup.inset(hint))
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
    commandGroup?.isHidden = selected?.cliType != "custom"
    saveItem.isEnabled = editable && advanced.isValid && selected != nil && !name.trimmed.isEmpty
      && (selected?.cliType != "custom" || !command.trimmed.isEmpty)
    testButton.isEnabled = saveItem.isEnabled
    cancelItem.isEnabled = !busy
    isModalInPresentation = busy
    if invalid { advanced.clearSecrets() }
    if activeOperation != nil { operationSpinner.startAnimating() } else { operationSpinner.stopAnimating() }
    for (action, button) in operationButtons {
      let unavailable = advanced.detail?.unavailableActions.first(where: { $0.action == action })
      var supported = unavailable == nil
      if action == "rate-limits-refresh" { supported = supported && item != nil && advanced.detail?.supportsRateLimitsRefresh != false }
      if action.hasPrefix("binary-"), item == nil { supported = supported && ["builtin", "registry"].contains(selected?.cliType ?? "") }
      button.isEnabled = editable && supported
      button.isHidden = action == "pi-extension-scan" && (selected?.agentType != "pi" || (advanced.detail?.supportsPiExtensions ?? machine.supportsPiExtensions) != true)
      if let unavailable {
        button.setTitle(text(action) + " — " + text("unavailable." + unavailable.reason), for: .normal)
        button.titleLabel?.numberOfLines = 0
      } else { button.setTitle(text(action), for: .normal) }
    }
    if invalid || uncertain || detailFailed {
      let notice = LodyFormGroup.caption()
      var message = "scopeChanged"
      if uncertain { message = "writeFailed" }
      if detailFailed { message = "detailFailed" }
      notice.text = text(message)
      notice.accessibilityIdentifier = "provider-editor-notice"
      if !stack.arrangedSubviews.contains(where: { $0.accessibilityIdentifier == "provider-editor-notice" }) {
        stack.addArrangedSubview(notice)
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

  private func text(_ key: String) -> String { AgentProviderSections.text(key) }
}
