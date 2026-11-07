import UIKit

@MainActor
final class RemoteSettingEditorController: LodyFormController {
  var saved: (() -> Void)?
  private let item: RemoteSetting
  private let workspaceId: String
  private let service: RemoteSettingsService
  private var busy = false
  private lazy var name = LodyFormField(id: "setting-name", label: text("name"), text: item.name, limit: 200)
  private lazy var prompt = LodyFormTextView(
    id: "setting-prompt", label: text("prompt"), text: item.prompt ?? "", limit: 32000, minHeight: 176
  )
  private lazy var enabled = LodyFormToggle(id: "setting-enabled", title: text("default"), isOn: item.enabledByDefault == true)
  private let failure = LodyFormGroup.caption(color: .systemRed, size: 15)
  private lazy var deleteButton = LodyFormButton.make(
    id: "setting-delete", title: String(localized: "settings.mcp.delete", bundle: .lody), destructive: true
  ) { [weak self] in self?.confirmDelete() }
  private lazy var cancelItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in
    self?.closeForm()
  }
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: text("save"), prominent: true) { [weak self] in
    self?.save()
  }

  init(item: RemoteSetting, workspaceId: String, service: @escaping RemoteSettingsService) {
    self.item = item
    self.workspaceId = workspaceId
    self.service = service
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    name.clearButtonMode = .whileEditing
    name.returnKeyType = .done
    name.changed = { [weak self] in self?.render() }
    if item.kind == "machine" {
      stack.addArrangedSubview(LodyFormGroup(
        footer: text("machineHint"), name, LodyFormRow(label: text("machineId"), content: machineRow())
      ))
    } else {
      stack.addArrangedSubview(LodyFormGroup(name))
    }
    if item.kind == "mcp" {
      failure.accessibilityIdentifier = "setting-error"
      failure.accessibilityTraits = .staticText
      stack.addArrangedSubview(LodyFormGroup.inset(failure))
      showFailure("")
    }
    if item.kind == "agent" {
      stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), footer: text("agentHint"), prompt))
    }
    if item.kind == "mcp" {
      enabled.toggle.addAction(UIAction { [weak self] _ in self?.render() }, for: .valueChanged)
      let footer = item.configured == false ? String(localized: "settings.mcp.missingConnection", bundle: .lody) : text("mcpHint")
      stack.addArrangedSubview(LodyFormGroup(footer: footer, enabled))
      if !item.locked {
        stack.addArrangedSubview(LodyFormGroup(footer: String(localized: "settings.mcp.connectionEditing", bundle: .lody), deleteButton))
      }
    }
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItems = [cancelItem]
    header?.rightBarButtonItems = [saveItem]
    render()
  }

  private func machineRow() -> UIView {
    let id = UILabel()
    id.text = item.id
    id.font = LodyDesign.mono(13)
    id.textColor = .lodyInk
    id.textAlignment = .right
    id.lineBreakMode = .byTruncatingMiddle
    var configuration = UIButton.Configuration.plain()
    configuration.image = UIImage(systemName: "doc.on.doc")
    let copy = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      UIPasteboard.general.string = self.item.id
      LodyToastOverlay.shared.show(message: self.text("idCopied"), kind: "info")
    })
    copy.accessibilityLabel = text("copyId")
    copy.widthAnchor.constraint(equalToConstant: 44).isActive = true
    copy.heightAnchor.constraint(equalToConstant: 44).isActive = true
    let row = UIStackView(arrangedSubviews: [id, copy])
    row.alignment = .center
    row.spacing = 4
    return row
  }

  private func render() {
    guard isViewLoaded else { return }
    name.isEnabled = !busy
    prompt.isEditable = !busy
    enabled.toggle.isEnabled = !busy && !(item.configured == false && !enabled.toggle.isOn)
    deleteButton.isEnabled = !busy
    cancelItem.isEnabled = !busy
    saveItem.isEnabled = !busy && !name.trimmed.isEmpty
  }

  private func save() {
    guard !busy, !item.locked, !name.trimmed.isEmpty else { return }
    let edit = RemoteSettingEdit(
      item: item, name: name.text ?? "", prompt: item.kind == "agent" ? prompt.text : nil,
      enabledByDefault: item.kind == "mcp" ? enabled.toggle.isOn : nil
    )
    run(RemoteSettingsRequest(workspaceId: workspaceId, kind: item.kind, edit: edit))
  }

  private func confirmDelete() {
    guard !busy, !item.locked else { return }
    SettingsPage.confirm(
      from: self, title: String(localized: "settings.mcp.delete", bundle: .lody),
      message: String.localizedStringWithFormat(String(localized: "settings.mcp.deleteHint", bundle: .lody), String(describing: item.name)), action: String(localized: "common.delete", bundle: .lody),
      destructive: true
    ) { [weak self] in
      guard let self else { return }
      self.run(RemoteSettingsRequest(workspaceId: self.workspaceId, kind: "mcp", remove: self.item))
    }
  }

  private func run(_ request: RemoteSettingsRequest) {
    busy = true
    showFailure("")
    render()
    Task { [weak self, service] in
      let message: String?
      do {
        _ = try await service(request)
        message = nil
      } catch {
        message = (error as? SettingsError)?.description ?? String(localized: "settings.remote.saveFailed", bundle: .lody)
      }
      guard let self else { return }
      self.busy = false
      if let message {
        self.showFailure(message)
        if self.item.kind != "mcp" { LodyToastOverlay.shared.show(message: message, kind: "error") }
        self.render()
      } else {
        self.saved?()
        self.closeForm()
      }
    }
  }

  private func showFailure(_ message: String) {
    guard item.kind == "mcp" else { return }
    failure.text = message
    failure.accessibilityLabel = message
    failure.isHidden = message.isEmpty
    failure.superview?.isHidden = message.isEmpty
  }

  private func text(_ key: String) -> String { RemoteSettingsSections.remote(key) }
}
