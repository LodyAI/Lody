import LodyCore
import UIKit

@MainActor
final class AgentProviderAdvanced: UIStackView {
  var changed: (() -> Void)?
  private(set) var detail: ProviderDetail?
  private var option: AgentProviderCatalogItem?
  private var presets: [ProviderPreset] = []
  private var presetChanged = false
  private var modeID: String?
  private var endpointValue: String?
  private var runtimePatch: [String: ProviderJSON] = [:]
  private var titleValues: [String: ProviderJSON] = [:]
  private var titleChanged = false
  private var codexSupported = false
  private var codexMode = "chatgpt"
  private let profileID = UUID().uuidString.lowercased()
  private let codexChoice = UIButton(type: .system)
  private let codexEndpoint = LodyFormField(id: "provider-codex-endpoint", label: AgentProviderSections.text("endpoint"), text: "https://api.openai.com/v1", limit: 2048)
  private var codexGroup: LodyFormGroup!
  private let unavailable = LodyFormGroup.caption()
  private let extensionRows = UIStackView()
  private var extensionChoices: [ProviderOperationResult.ExtensionPath] = []
  private let credential = LodyFormField(id: "provider-credential", label: AgentProviderSections.text("apiKey"), text: "", limit: 32000)
  private let endpoint = LodyFormField(id: "provider-endpoint", label: AgentProviderSections.text("endpoint"), text: "", limit: 2048)
  private let descriptionField = LodyFormField(id: "provider-description", label: AgentProviderSections.text("description"), text: "", limit: 4096)
  private let runtimePath = LodyFormField(id: "provider-runtime-path", label: AgentProviderSections.text("runtimePath"), text: "", limit: 4096)
  private let credentialMode = UIButton(type: .system)
  private let endpointChoice = UIButton(type: .system)
  private let titleRows = UIStackView()
  private let environment = AgentProviderEnvironment()
  private var credentialsGroup: LodyFormGroup!
  private var runtimeGroup: LodyFormGroup!
  private var titleGroup: LodyFormGroup!
  private var capabilities = ProviderCapabilities()

  init() {
    super.init(frame: .zero)
    axis = .vertical
    spacing = LodyDesign.Rail.groupGap
    credential.isSecureTextEntry = true
    for field in [credential, endpoint, runtimePath] {
      field.autocapitalizationType = .none
      field.autocorrectionType = .no
      field.clearButtonMode = .whileEditing
    }
    credential.changed = { [weak self] in self?.changed?() }
    endpoint.changed = { [weak self] in self?.presetChanged = true; self?.endpointValue = self?.endpoint.trimmed; self?.changed?() }
    descriptionField.changed = { [weak self] in self?.changed?() }
    environment.changed = { [weak self] in self?.changed?() }
    runtimePath.changed = { [weak self] in
      guard let self, let key = self.runtimeKey else { return }
      self.runtimePatch[key] = self.runtimePath.trimmed.isEmpty ? .null : .string(self.runtimePath.trimmed)
      self.changed?()
    }
    credentialMode.accessibilityIdentifier = "provider-credential-mode"
    credentialMode.showsMenuAsPrimaryAction = true
    endpointChoice.accessibilityIdentifier = "provider-endpoint-choice"
    endpointChoice.showsMenuAsPrimaryAction = true
    titleRows.axis = .vertical
    titleRows.spacing = 8
    credentialsGroup = LodyFormGroup(header: text("credentials"), footer: text("credentialWriteOnly"),
                                    credentialMode, credential, endpointChoice, endpoint)
    runtimeGroup = LodyFormGroup(header: text("runtime"), footer: text("runtimeHint"), runtimePath)
    titleGroup = LodyFormGroup(header: text("titleGeneration"), footer: text("titleHint"), titleRows)
    addArrangedSubview(LodyFormGroup(descriptionField))
    addArrangedSubview(credentialsGroup)
    codexChoice.showsMenuAsPrimaryAction = true
    codexChoice.accessibilityIdentifier = "provider-codex-mode"
    codexEndpoint.autocapitalizationType = .none
    codexEndpoint.autocorrectionType = .no
    codexGroup = LodyFormGroup(header: text("credentials"), footer: text("codexCredentials"), codexChoice, codexEndpoint)
    addArrangedSubview(codexGroup)
    extensionRows.axis = .vertical
    addArrangedSubview(extensionRows)
    addArrangedSubview(runtimeGroup)
    addArrangedSubview(titleGroup)
    addArrangedSubview(environment)
    unavailable.accessibilityIdentifier = "provider-unavailable-actions"
    addArrangedSubview(LodyFormGroup.inset(unavailable))
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  private func text(_ key: String) -> String { AgentProviderSections.text(key) }
  private var preset: ProviderPreset? { presets.first { $0.id == option?.presetId } }
  private var mode: ProviderPreset.Mode? { preset?.modes.first { $0.id == modeID } ?? preset?.modes.first }
  private var isDeepSeek: Bool { option?.cliType == "builtin" && option?.agentType == "deepseek" }
  private var runtimeKey: String? {
    guard option?.cliType == "builtin", preset == nil else { return nil }
    return ["codex": "codexPath", "claude": "claudeCodeExecutable", "kimi": "kimiPath", "grok": "grokPath", "devin": "devinPath", "pi": "piPath"][option?.agentType ?? ""]
  }

  func configure(machine: AgentProviderMachine) { codexSupported = machine.supportsCodexProfiles == true }

  func select(_ option: AgentProviderCatalogItem?, presets: [ProviderPreset]) {
    let different = self.option?.id != option?.id
    self.option = option
    self.presets = presets
    if different {
      credential.text = ""
      modeID = preset?.modes.first?.id
      endpointValue = nil
      runtimePatch = [:]
    }
    render()
  }

  func load(_ detail: ProviderDetail) {
    self.detail = detail
    runtimePatch.removeAll()
    titleChanged = false
    titleValues.removeAll()
    descriptionField.text = detail.description
    capabilities = detail.capabilities
    codexSupported = detail.supportsCodexProfiles
    if case .object(let profile) = detail.codexAuth {
      if case .string(let mode) = profile["mode"] { codexMode = mode }
      if case .string(let url) = profile["baseUrl"] { codexEndpoint.text = url }
    }
    if case .object(let generation) = detail.titleGeneration, case .object(let values) = generation["configOptionValues"] { titleValues = values }
    if let current = detail.endpoints.first?.value {
      endpointValue = current
      modeID = preset?.modes.first(where: { $0.endpoint == current || $0.endpoints.contains(where: { $0.url == current }) })?.id ?? preset?.modes.first(where: { $0.customEndpoint })?.id ?? modeID
    }
    presetChanged = false
    environment.configure(keys: detail.env.map(\.key), protectedKeys: protectedKeys)
    render()
  }

  func updateCapabilities(_ capabilities: ProviderCapabilities) {
    self.capabilities = capabilities
    renderTitle()
  }

  private var protectedKeys: Set<String> {
    if let preset { return Set(preset.protectedEnvKeys).union([preset.tokenEnvKey]) }
    if isDeepSeek { return ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] }
    return []
  }

  private func render() {
    let reason = detail?.unavailableActions.contains(where: { $0.reason == "machine_capability_missing" }) == true ? "sorbetCapabilityMissing" : "sorbetUnavailable"
    unavailable.text = option?.agentType == "sorbet" ? text(reason) : nil
    unavailable.isHidden = option?.agentType != "sorbet"
    codexGroup.isHidden = option?.agentType != "codex" || option?.cliType != "builtin" || !codexSupported
    codexChoice.setTitle(codexMode == "chatgpt" ? "ChatGPT" : text("customAPI"), for: .normal)
    codexChoice.menu = UIMenu(children: ["chatgpt", "api-key"].map { mode in
      UIAction(title: mode == "chatgpt" ? "ChatGPT" : text("customAPI"), state: mode == codexMode ? .on : .off) { [weak self] _ in
        self?.codexMode = mode
        self?.render()
      }
    })
    codexEndpoint.isHidden = codexMode != "api-key"
    extensionRows.isHidden = option?.agentType != "pi"

    credentialsGroup.isHidden = preset == nil && !isDeepSeek
    credentialMode.isHidden = (preset?.modes.count ?? 0) < 2
    credentialMode.setTitle(mode?.name, for: .normal)
    credentialMode.menu = UIMenu(children: (preset?.modes ?? []).map { next in
      UIAction(title: next.name, state: next.id == mode?.id ? .on : .off) { [weak self] _ in
        self?.presetChanged = true
        self?.modeID = next.id
        self?.endpointValue = nil
        self?.credential.text = ""
        self?.render()
        self?.changed?()
      }
    })
    endpointChoice.isHidden = (mode?.endpoints.isEmpty ?? true)
    endpointChoice.setTitle(text("chooseEndpoint"), for: .normal)
    endpointChoice.menu = UIMenu(children: (mode?.endpoints ?? []).map { next in
      UIAction(title: next.name) { [weak self] _ in
        self?.presetChanged = true
        self?.endpointValue = next.url
        self?.endpoint.text = next.url
        self?.changed?()
      }
    })
    endpoint.isHidden = !isDeepSeek && mode?.customEndpoint != true
    let endpointKey = isDeepSeek ? "DEEPSEEK_BASE_URL" : "ANTHROPIC_BASE_URL"
    endpoint.text = endpointValue ?? detail?.endpoints.first { $0.key == endpointKey }?.value ?? mode?.endpoint ?? mode?.endpoints.first?.url ?? ""
    runtimeGroup.isHidden = runtimeKey == nil
    if let runtimeKey {
      if case .string(let path) = runtimePatch[runtimeKey] ?? detail?.runtimeOverrides[runtimeKey] { runtimePath.text = path }
      else { runtimePath.text = "" }
    }
    environment.configure(keys: detail?.env.map(\.key) ?? [], protectedKeys: protectedKeys)
    renderTitle()
  }

  private func renderTitle() {
    titleRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
    titleGroup.isHidden = preset != nil || capabilities.sessionTitle
    var options = capabilities.options
    if !capabilities.models.isEmpty && !options.contains(where: { $0.id == "model" }) {
      options.insert(.init(id: "model", name: text("model"), type: "select", choices: capabilities.models), at: 0)
    }
    if !capabilities.modes.isEmpty && !options.contains(where: { $0.id == "mode" }) {
      options.append(.init(id: "mode", name: text("mode"), type: "select", choices: capabilities.modes))
    }
    for option in options {
      let button = UIButton(type: .system)
      button.showsMenuAsPrimaryAction = true
      button.accessibilityIdentifier = "provider-title:\(option.id)"
      let value = titleValues[option.id] ?? option.value
      var choices = option.choices.map { ($0.id, $0.name, ProviderJSON.string($0.id)) }
      if option.type == "boolean" { choices = [("true", text("enabled"), .bool(true)), ("false", text("disabled"), .bool(false))] }
      let label = choices.first { $0.2 == value }?.1 ?? text("default")
      button.setTitle(label, for: .normal)
      let reset = UIAction(title: text("default"), state: titleValues[option.id] == nil ? .on : .off) { [weak self] _ in
        self?.titleValues.removeValue(forKey: option.id)
        self?.titleChanged = true
        self?.renderTitle()
        self?.changed?()
      }
      button.menu = UIMenu(children: [reset] + choices.map { choice in
        UIAction(title: choice.1, state: choice.2 == titleValues[option.id] ? .on : .off) { [weak self] _ in
          self?.titleValues[option.id] = choice.2
          self?.titleChanged = true
          self?.renderTitle()
          self?.changed?()
        }
      })
      titleRows.addArrangedSubview(LodyFormRow(label: option.name, content: button))
    }
  }

  var isValid: Bool {
    if detail == nil, preset != nil || isDeepSeek, (credential.text ?? "").isEmpty { return false }
    if let prefix = mode?.tokenPrefix, let token = credential.text, !token.isEmpty { return token.hasPrefix(prefix) }
    return true
  }

  func setEditable(_ editable: Bool) {
    for field in [descriptionField, credential, endpoint, runtimePath] { field.isEnabled = editable }
    for button in [credentialMode, endpointChoice] { button.isEnabled = editable }
    titleRows.isUserInteractionEnabled = editable
    environment.setEditable(editable)
    codexChoice.isEnabled = editable && detail == nil
    codexEndpoint.isEnabled = editable && detail == nil
    extensionRows.isUserInteractionEnabled = editable
  }

  func apply(to fields: inout AgentProviderFields) {
    fields.detailRevision = detail?.revision
    if detail == nil, codexSupported, option?.cliType == "builtin", option?.agentType == "codex" {
      var profile: [String: ProviderJSON] = ["mode": .string(codexMode), "profileId": .string(profileID)]
      if codexMode == "api-key" { profile["baseUrl"] = .string(codexEndpoint.trimmed) }
      fields.codexAuth = .object(profile)
    }
    if descriptionField.text != detail?.description { fields.description = descriptionField.text ?? "" }
    var patch = environment.patch.filter { !protectedKeys.contains($0.key) }
    if let preset {
      if detail == nil || presetChanged || !(credential.text ?? "").isEmpty || detail?.presetId != preset.id {
        fields.presetId = preset.id
        fields.presetModeId = mode?.id
        fields.presetEndpoint = endpoint.trimmed.isEmpty ? nil : endpoint.trimmed
      }
      if let token = credential.text, !token.isEmpty { patch.updateValue(token, forKey: preset.tokenEnvKey) }
    } else if isDeepSeek {
      if let token = credential.text, !token.isEmpty { patch.updateValue(token, forKey: "DEEPSEEK_API_KEY") }
      if endpointValue != nil { patch.updateValue(endpoint.trimmed.isEmpty ? nil : endpoint.trimmed, forKey: "DEEPSEEK_BASE_URL") }
    }
    if !patch.isEmpty { fields.envPatch = patch }
    if !runtimePatch.isEmpty {
      let remove = runtimePatch.filter { $0.value == .null }.keys.sorted().map { ProviderJSON.string($0) }
      fields.runtimeOverrides = .object(["action": .string("merge"), "value": .object(runtimePatch.filter { $0.value != .null }), "remove": .array(remove)])
    }
    if titleChanged { fields.titleGeneration = .object(["action": .string("set"), "value": .object(["configOptionValues": .object(titleValues)])]) }
  }

  func showExtensions(_ choices: [ProviderOperationResult.ExtensionPath]) {
    extensionChoices = choices
    extensionRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
    var selected: [ProviderJSON] = []
    if case .array(let paths) = runtimePatch["piExtensions"] ?? detail?.runtimeOverrides["piExtensions"] { selected = paths }
    for choice in choices {
      let button = UIButton(type: .system)
      let enabled = selected.contains(.string(choice.path))
      button.setTitle((enabled ? "✓ " : "") + choice.name, for: .normal)
      button.accessibilityIdentifier = "provider-extension:\(choice.path)"
      button.addAction(UIAction { [weak self] _ in
        guard let self else { return }
        var next = selected.filter { $0 != .string(choice.path) }
        if !enabled { next.append(.string(choice.path)) }
        self.runtimePatch["piExtensions"] = .array(next)
        self.showExtensions(self.extensionChoices)
        self.changed?()
      }, for: .touchUpInside)
      extensionRows.addArrangedSubview(LodyFormGroup(button))
    }
  }

  func clearSecrets() {
    credential.text = ""
    environment.clearSecrets()
  }
}
