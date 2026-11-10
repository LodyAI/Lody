import UIKit

/// Environment values are write-only drafts, never loaded from a list or saved locally.
@MainActor
final class AgentProviderEnvironment: UIStackView {
  var changed: (() -> Void)?
  private(set) var patch: [String: String?] = [:]
  private var keys: [String] = []
  private var protectedKeys: Set<String> = []
  private var editable = true
  private let rows = UIStackView()
  private let key = LodyFormField(id: "provider-env-key", label: AgentProviderSections.text("envKey"), text: "", limit: 128)
  private let value = LodyFormField(id: "provider-env-value", label: AgentProviderSections.text("envValue"), text: "", limit: 32000)
  private let add = UIButton(type: .system)

  init() {
    super.init(frame: .zero)
    axis = .vertical
    spacing = 12
    rows.axis = .vertical
    rows.spacing = 12
    value.isSecureTextEntry = true
    value.textContentType = nil
    key.autocapitalizationType = .none
    key.autocorrectionType = .no
    value.autocapitalizationType = .none
    value.autocorrectionType = .no
    add.setTitle(AgentProviderSections.text("envAdd"), for: .normal)
    add.accessibilityIdentifier = "provider-env-add"
    add.addAction(UIAction { [weak self] _ in self?.insert() }, for: .touchUpInside)
    key.changed = { [weak self] in self?.refreshEnabled() }
    addArrangedSubview(rows)
    addArrangedSubview(LodyFormGroup(header: AgentProviderSections.text("environment"),
                                    footer: AgentProviderSections.text("envWriteOnly"), key, value, add))
    refreshEnabled()
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  func configure(keys: [String], protectedKeys: Set<String> = []) {
    self.keys = keys
    self.protectedKeys = protectedKeys
    rebuild()
  }

  func setEditable(_ editable: Bool) {
    self.editable = editable
    refreshEnabled()
    for case let group as LodyFormGroup in rows.arrangedSubviews {
      group.isUserInteractionEnabled = editable
      group.alpha = editable ? 1 : 0.6
    }
  }

  func clearSecrets() {
    patch.removeAll()
    key.text = ""
    value.text = ""
    rebuild()
  }

  private func refreshEnabled() {
    key.isEnabled = editable
    value.isEnabled = editable
    let candidate = key.trimmed
    add.isEnabled = editable && candidate.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil
      && !protectedKeys.contains(candidate) && !keys.contains(candidate) && !patch.keys.contains(candidate)
  }

  private func insert() {
    guard add.isEnabled else { return }
    patch.updateValue(value.text ?? "", forKey: key.trimmed)
    key.text = ""
    value.text = ""
    endEditing(true)
    rebuild()
    changed?()
  }

  private func rebuild() {
    rows.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for name in Set(keys).union(patch.keys).sorted() where !protectedKeys.contains(name) {
      let mode = UIButton(type: .system)
      mode.showsMenuAsPrimaryAction = true
      mode.accessibilityIdentifier = "provider-env-mode:\(name)"
      let field = LodyFormField(id: "provider-env:\(name)", label: AgentProviderSections.text("envValue"), text: (patch[name] ?? nil) ?? "", limit: 32000)
      field.isSecureTextEntry = true
      field.textContentType = nil
      field.autocapitalizationType = .none
      field.autocorrectionType = .no
      let action: String
      if let change = patch[name] { action = change == nil ? "envRemove" : "envReplace" }
      else { action = "envKeep" }
      mode.setTitle(AgentProviderSections.text(action), for: .normal)
      field.isHidden = action != "envReplace"
      field.changed = { [weak self, weak field] in
        self?.patch.updateValue(field?.text ?? "", forKey: name)
        self?.changed?()
      }
      mode.menu = UIMenu(children: ["envKeep", "envReplace", "envRemove"].map { choice in
        UIAction(title: AgentProviderSections.text(choice), state: choice == action ? .on : .off) { [weak self] _ in
          guard let self else { return }
          switch choice {
          case "envReplace": self.patch.updateValue("", forKey: name)
          case "envRemove":
            if self.keys.contains(name) { self.patch.updateValue(nil, forKey: name) }
            else { self.patch.removeValue(forKey: name) }
          default: self.patch.removeValue(forKey: name)
          }
          self.rebuild()
          self.changed?()
        }
      })
      rows.addArrangedSubview(LodyFormGroup(LodyFormRow(label: name, content: mode), field))
    }
    setEditable(editable)
  }
}
