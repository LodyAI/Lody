import LodyCore
import SwiftUI
import UIKit

/// A Role's editor (web `agent-role-form` on mobile): the emoji and name lead, then what it is,
/// where it runs, who sees it and its instructions. Saves show in the list at once and roll back
/// if the write fails.
@MainActor
final class AgentRoleEditorController: LodyFormController {
  /// The Role as it will read once saved, or nil for a delete; shown in the list immediately.
  var willChange: ((_ id: String, _ role: AgentRole?) -> Void)?
  var saved: ((AgentRoleSnapshot) -> Void)?
  var failed: (() -> Void)?
  private let workspace: SettingsWorkspace
  private let scope: SettingsScope
  private let role: AgentRole?
  private let agents: [AgentRoleAgent]
  private let service: AgentRoleService
  private let readOnly: Bool
  private let id: String
  private var target: AgentRoleAgent?
  private var emoji: String
  private var busy = false
  private var uncertain = false
  private var failure = ""
  private var observer: NSObjectProtocol?
  private let emojiButton = UIButton(type: .system)
  private let emojiHint = UILabel()
  private lazy var name = LodyFormField(
    id: "role-name", label: String(localized: "settings.remote.name", bundle: .lody), text: role?.name, limit: 60
  )
  private lazy var summary = LodyFormField(
    id: "role-description", label: text("description"), text: role?.description, limit: 140
  )
  private lazy var prompt = LodyFormTextView(
    id: "role-prompt", label: text("prompt"), text: role?.promptPrefix, limit: 32000, minHeight: 180
  )
  private lazy var shared = LodyFormToggle(id: "role-shared", title: text("workspace"), isOn: role?.visibility == .workspace)
  private lazy var machineButton = LodyFormButton.make(id: "role-machine", title: "") { [weak self] in self?.pickMachine() }
  private lazy var targetButton = LodyFormButton.make(id: "role-target", title: "") { [weak self] in self?.pickTarget() }
  private lazy var deleteButton = LodyFormButton.make(id: "role-delete", title: text("delete"), destructive: true) {
    [weak self] in self?.confirmDelete()
  }
  private let errorLabel = LodyFormGroup.caption(color: .systemRed, size: 15)
  private lazy var errorView = LodyFormGroup.inset(errorLabel)
  private lazy var cancelItem = Self.barButton(symbol: "xmark", label: String(localized: "common.cancel", bundle: .lody)) { [weak self] in
    self?.closeForm()
  }
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: String(localized: "common.save", bundle: .lody), prominent: true) {
    [weak self] in self?.mutate()
  }

  init(workspace: SettingsWorkspace, scope: SettingsScope, role: AgentRole?, agents: [AgentRoleAgent], service: @escaping AgentRoleService) {
    self.workspace = workspace
    self.scope = scope
    self.role = role
    self.agents = agents
    self.service = service
    readOnly = role.map { !AgentRoleSections.editable($0, userId: workspace.userId) } ?? false
    id = role?.id ?? UUID().uuidString.lowercased()
    target = agents.first
    emoji = role?.emoji ?? AgentRoleSections.defaultEmoji
    super.init(nibName: nil, bundle: nil)
    title = text(role == nil ? "add" : "edit")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    name.clearButtonMode = .whileEditing
    name.changed = { [weak self] in self?.render() }
    errorLabel.accessibilityIdentifier = "role-error"
    errorLabel.numberOfLines = 0
    stack.addArrangedSubview(emojiHeader())
    if let hint = role.flatMap({ AgentRoleSections.readOnlyHint($0, userId: workspace.userId) }) {
      let label = LodyFormGroup.caption()
      label.text = hint
      label.numberOfLines = 0
      label.textAlignment = .center
      stack.addArrangedSubview(LodyFormGroup.inset(label))
    }
    stack.addArrangedSubview(errorView)
    stack.addArrangedSubview(LodyFormGroup(name, summary))
    stack.addArrangedSubview(LodyFormGroup(
      header: text("target"), footer: role == nil ? text("configurationHint") : nil, targetContent()
    ))
    stack.addArrangedSubview(LodyFormGroup(footer: text("visibilityHint"), shared))
    stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), footer: text("effectHint"), prompt))
    if role != nil, !readOnly { stack.addArrangedSubview(LodyFormGroup(deleteButton)) }
    observer = NotificationCenter.default.addObserver(forName: scope.change, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkScope() }
    }
    render()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    header?.leftBarButtonItems = [cancelItem]
    header?.rightBarButtonItems = readOnly ? [] : [saveItem]
    render()
  }

  private func emojiHeader() -> UIView {
    var configuration = UIButton.Configuration.filled()
    configuration.baseBackgroundColor = .lodyOpaqueCard
    configuration.cornerStyle = .capsule
    configuration.contentInsets = .zero
    emojiButton.configuration = configuration
    emojiButton.accessibilityIdentifier = "role-emoji"
    emojiButton.accessibilityHint = text("emojiHint")
    emojiButton.addAction(UIAction { [weak self] _ in self?.pickEmoji() }, for: .touchUpInside)
    emojiButton.translatesAutoresizingMaskIntoConstraints = false
    emojiHint.font = .preferredFont(forTextStyle: .footnote)
    emojiHint.adjustsFontForContentSizeCategory = true
    emojiHint.textColor = .secondaryLabel
    emojiHint.text = text("emojiHint")
    emojiHint.isAccessibilityElement = false
    let column = UIStackView(arrangedSubviews: [emojiButton, emojiHint])
    column.axis = .vertical
    column.alignment = .center
    column.spacing = 8
    column.isLayoutMarginsRelativeArrangement = true
    column.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 0, bottom: 4, trailing: 0)
    NSLayoutConstraint.activate([
      emojiButton.widthAnchor.constraint(equalToConstant: 88),
      emojiButton.heightAnchor.constraint(equalToConstant: 88),
    ])
    return column
  }

  private func targetContent() -> UIView {
    guard let role else {
      // New chat's order: the computer first, then one of its Agent configs.
      let rows = UIStackView(arrangedSubviews: [
        LodyFormRow(label: String(localized: "create.label.machine", bundle: .lody), content: machineButton, picker: true),
        LodyFormGroup.hairline(),
        LodyFormRow(label: text("agent"), content: targetButton, picker: true),
      ])
      rows.axis = .vertical
      rows.spacing = 0
      return rows
    }
    let rows = UIStackView()
    rows.axis = .vertical
    rows.spacing = 0
    for (index, item) in role.targets.enumerated() {
      let title = UILabel()
      title.font = .preferredFont(forTextStyle: .body)
      title.adjustsFontForContentSizeCategory = true
      title.text = item.agentName
      let detail = UILabel()
      detail.font = .preferredFont(forTextStyle: .footnote)
      detail.adjustsFontForContentSizeCategory = true
      detail.textColor = .secondaryLabel
      detail.text = item.state == .configured ? item.machineName : "\(item.machineName) · \(text(item.state.rawValue))"
      let text = UIStackView(arrangedSubviews: [title, detail])
      text.axis = .vertical
      text.spacing = 2
      let icon = UIImageView(image: UIImage(systemName: item.state == .configured ? "desktopcomputer" : "exclamationmark.triangle"))
      icon.tintColor = item.state == .configured ? .secondaryLabel : .systemOrange
      icon.contentMode = .scaleAspectFit
      icon.setContentHuggingPriority(.required, for: .horizontal)
      let row = UIStackView(arrangedSubviews: [icon, text])
      row.spacing = 12
      row.alignment = .center
      row.isLayoutMarginsRelativeArrangement = true
      row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: LodyFormGroup.margin, bottom: 10, trailing: LodyFormGroup.margin)
      row.isAccessibilityElement = true
      row.accessibilityLabel = "\(item.agentName), \(detail.text ?? "")"
      if index > 0 { rows.addArrangedSubview(LodyFormGroup.hairline()) }
      rows.addArrangedSubview(row)
    }
    rows.accessibilityIdentifier = "role-targets"
    return rows
  }

  private var scopeValid: Bool { scope.current().key == workspace.key }
  private var valid: Bool { !name.trimmed.isEmpty && (role != nil || target != nil) }

  private func checkScope() {
    if !scopeValid { closeForm() }
  }

  private func render() {
    guard isViewLoaded else { return }
    let editable = !readOnly && !busy && !uncertain && scopeValid
    name.isEnabled = editable
    summary.isEnabled = editable
    prompt.isEditable = editable
    shared.toggle.isEnabled = editable
    machineButton.isEnabled = editable
    targetButton.isEnabled = editable
    deleteButton.isEnabled = editable
    emojiButton.isEnabled = editable
    emojiHint.isHidden = !editable
    var configuration = emojiButton.configuration
    configuration?.attributedTitle = AttributedString(emoji, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 44)]))
    emojiButton.configuration = configuration
    emojiButton.accessibilityLabel = String.localizedStringWithFormat(text("emojiLabel"), emoji)
    machineButton.setTitle(target?.machineName ?? String(localized: "create.row.selectMachine", bundle: .lody), for: .normal)
    machineButton.accessibilityLabel = machineButton.title(for: .normal)
    targetButton.setTitle(target?.name ?? String(localized: "create.row.selectAgent", bundle: .lody), for: .normal)
    targetButton.accessibilityLabel = targetButton.title(for: .normal)
    errorLabel.text = failure
    errorView.isHidden = failure.isEmpty
    cancelItem.isEnabled = !busy
    saveItem.isEnabled = editable && valid
    isModalInPresentation = busy
  }

  private func pickEmoji() {
    let picker = AgentRoleEmojiPicker(selected: emoji) { [weak self] value in
      guard let self else { return }
      self.emoji = value
      self.render()
    }
    LodyShell.shared.presentNative(picker, title: text("emoji"), detents: [0.5, 1])
  }

  /// Computers that offer at least one Agent config, in the listing's order.
  private var machines: [(id: String, name: String)] {
    var seen = Set<String>()
    return agents.compactMap { seen.insert($0.machineId).inserted ? ($0.machineId, $0.machineName) : nil }
  }

  private func pickMachine() {
    let picker = CreateChoiceController(
      title: String(localized: "create.row.selectMachine", bundle: .lody), header: String(localized: "create.label.machine", bundle: .lody),
      placeholder: String(localized: "create.picker.machine.placeholder", bundle: .lody),
      options: machines.map { ($0.id, $0.name, "") }, selected: target?.machineId
    ) { [weak self] id in
      guard let self, id != self.target?.machineId else { return }
      self.target = self.agents.first { $0.machineId == id }
      self.render()
    }
    LodyShell.shared.pushNative(picker, title: picker.title ?? "", from: self)
  }

  private func pickTarget() {
    guard let machineId = target?.machineId else { return pickMachine() }
    let choices = agents.filter { $0.machineId == machineId }
    let picker = CreateChoiceController(
      title: String(localized: "create.row.selectAgent", bundle: .lody), header: String(localized: "create.label.agent", bundle: .lody),
      placeholder: String(localized: "create.picker.agent.placeholder", bundle: .lody),
      options: choices.map { ($0.id, $0.name, "") }, selected: target?.id,
      marks: Dictionary(choices.map { ($0.id, LodyAgentIcon.mark(cliType: $0.cliType, agentType: $0.agentType)) }, uniquingKeysWith: { first, _ in first })
    ) { [weak self] id in
      guard let self, let agent = choices.first(where: { $0.id == id }) else { return }
      self.target = agent
      self.render()
    }
    LodyShell.shared.pushNative(picker, title: picker.title ?? "", from: self)
  }

  private func confirmDelete() {
    guard let role else { return }
    SettingsPage.confirm(
      from: self, title: text("delete"),
      message: String.localizedStringWithFormat(String(localized: "settings.roles.deleteHint", bundle: .lody), String(describing: role.name)),
      action: String(localized: "common.delete", bundle: .lody), destructive: true
    ) { [weak self] in self?.mutate(remove: true) }
  }

  private func provisional(_ fields: RuntimeContract.AgentRolesParamsSaveFields) -> AgentRole {
    let visibility: RuntimeContract.AgentRoleItemVisibility = fields.visibility == .workspace ? .workspace : .private
    let targets = role?.targets ?? target.map {
      [RuntimeContract.AgentRoleItemTargetsItem(
        machineId: $0.machineId, agentConfigId: $0.id, machineName: $0.machineName, agentName: $0.name, state: .configured
      )]
    } ?? []
    return AgentRole(
      id: id, ownerUserId: workspace.userId, visibility: visibility, name: fields.name.trimmingCharacters(in: .whitespacesAndNewlines),
      description: fields.description, promptPrefix: fields.promptPrefix, emoji: fields.emoji ?? emoji,
      revision: role?.revision ?? 0, updatedAt: LodyRelativeTime.now(), targets: targets
    )
  }

  private func mutate(remove: Bool = false) {
    guard !busy, !readOnly, !uncertain, valid, scopeValid else { return }
    let request: AgentRoleRequest
    let preview: AgentRole?
    if remove, let role {
      request = .delete(role)
      preview = nil
    } else {
      let fields = RuntimeContract.AgentRolesParamsSaveFields(
        name: name.text ?? "", description: summary.text ?? "", promptPrefix: prompt.text,
        visibility: shared.toggle.isOn ? .workspace : .private, emoji: emoji
      )
      let destination = target.map { RuntimeContract.AgentRolesParamsSaveTarget(machineId: $0.machineId, agentConfigId: $0.id) }
      request = .save(id: id, base: role, fields: fields, target: destination)
      preview = provisional(fields)
    }
    busy = true
    failure = ""
    render()
    willChange?(id, preview)
    Task { [weak self, service] in
      do {
        let snapshot = try await service(request)
        guard let self else { return }
        self.busy = false
        self.saved?(snapshot)
        self.closeForm()
      } catch {
        guard let self else { return }
        let result = AgentRoleSections.failure(error)
        self.busy = false
        self.failure = result.message
        self.uncertain = result.uncertain
        self.failed?()
        self.render()
      }
    }
  }

  private func text(_ key: String) -> String {
    AgentRoleSections.text(key)
  }
}

/// A grid of common Role glyphs plus a field for any other emoji.
@MainActor
final class AgentRoleEmojiPicker: UIHostingController<AgentRoleEmojiGrid> {
  init(selected: String, picked: @escaping (String) -> Void) {
    super.init(rootView: AgentRoleEmojiGrid(selected: selected) { _ in })
    rootView = AgentRoleEmojiGrid(selected: selected) { [weak self] value in
      picked(value)
      self?.dismiss(animated: true)
    }
  }

  @available(*, unavailable)
  @MainActor required dynamic init?(coder: NSCoder) { fatalError() }
}

struct AgentRoleEmojiGrid: View {
  static let choices = [
    "🪼", "🤖", "🧠", "🛠️", "🔍", "🧪", "📝", "🎨", "🚀", "🐛", "🔒", "📦",
    "🧭", "📊", "💡", "⚙️", "🧹", "🔧", "🧩", "📚", "🗂️", "🌐", "📱", "🖥️",
    "☁️", "🗄️", "🔥", "✅", "🎯", "🧑‍💻", "👀", "✍️", "🦉", "🐙", "🦊", "🐝",
  ]
  let selected: String
  let picked: (String) -> Void
  @State private var custom = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
          ForEach(Self.choices, id: \.self) { glyph in
            Button { picked(glyph) } label: {
              Text(glyph)
                .font(.system(size: 30))
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(
                  RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(glyph == selected ? Color(uiColor: .tertiarySystemFill) : Color.clear)
                )
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(glyph == selected ? .isSelected : [])
          }
        }
        HStack(spacing: 12) {
          TextField(String(localized: "settings.roles.emojiCustom", bundle: .lody), text: $custom)
            .textFieldStyle(.roundedBorder)
            .submitLabel(.done)
            .onSubmit(useCustom)
          Button(String(localized: "settings.roles.emojiUse", bundle: .lody), action: useCustom)
            .buttonStyle(.borderedProminent)
            .disabled(Self.glyph(custom) == nil)
        }
      }
      .padding(20)
    }
  }

  private func useCustom() {
    if let glyph = Self.glyph(custom) { picked(glyph) }
  }

  /// Web `normalizeAgentRoleEmoji`: the first grapheme, without whitespace or control characters.
  static func glyph(_ value: String) -> String? {
    let cleaned = value.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.controlCharacters.contains($0) }
    guard let first = String(String.UnicodeScalarView(cleaned)).first else { return nil }
    return String(first)
  }
}
