import LodyCore
import UIKit

@MainActor
final class AgentRoleEditorController: LodyFormController {
  var saved: (() -> Void)?
  private let workspace: SettingsWorkspace
  private let scope: SettingsScope
  private let role: AgentRole?
  private let agents: [AgentRoleAgent]
  private let service: AgentRoleService
  private let readOnly: Bool
  private let id: String
  private var target: AgentRoleAgent?
  private var busy = false
  private var uncertain = false
  private var failure = ""
  private var deleteFailed = false
  private var observer: NSObjectProtocol?
  private lazy var name = LodyFormField(
    id: "role-name", label: String(localized: "settings.remote.name", bundle: .lody), text: role?.name, limit: 60
  )
  private lazy var summary = LodyFormField(
    id: "role-description", label: text("description"), text: role?.description, limit: 140
  )
  private lazy var prompt = LodyFormTextView(
    id: "role-prompt", label: text("prompt"), text: role?.promptPrefix, limit: 32000, minHeight: 120
  )
  private lazy var shared = LodyFormToggle(id: "role-shared", title: text("workspace"), isOn: role?.visibility == .workspace)
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
    super.init(nibName: nil, bundle: nil)
    title = text("edit")
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
    let hints = [role.flatMap { AgentRoleSections.readOnlyHint($0, userId: workspace.userId) }, text("configurationHint"), text("visibilityHint")]
    stack.addArrangedSubview(LodyFormGroup(
      footer: hints.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " "),
      name, summary, targetContent(), shared
    ))
    stack.addArrangedSubview(errorView)
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

  private func targetContent() -> UIView {
    guard let role else { return LodyFormRow(label: text("target"), content: targetButton, picker: true) }
    let label = LodyFormGroup.caption(color: .lodyInk, size: 15)
    label.textAlignment = .right
    label.text = role.targets.map { "\($0.machineName) · \($0.agentName)" }.joined(separator: "\n")
    label.accessibilityIdentifier = "role-targets"
    return LodyFormRow(label: text("target"), content: label)
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
    targetButton.isEnabled = editable
    deleteButton.isEnabled = editable
    targetButton.setTitle(target.map { "\($0.machineName) · \($0.name)" } ?? text("target"), for: .normal)
    targetButton.accessibilityLabel = targetButton.title(for: .normal)
    errorLabel.text = failure
    errorView.isHidden = failure.isEmpty
    stack.removeArrangedSubview(errorView)
    stack.insertArrangedSubview(errorView, at: deleteFailed ? stack.arrangedSubviews.count - 1 : 1)
    cancelItem.isEnabled = !busy
    saveItem.isEnabled = editable && valid
  }

  private func pickTarget() {
    let picker = AgentRoleTargetController(agents: agents) { [weak self] agent in
      self?.target = agent
      self?.render()
    }
    LodyShell.shared.pushNative(picker, title: text("target"), from: self)
  }

  private func confirmDelete() {
    guard let role else { return }
    let alert = UIAlertController(title: text("delete"), message: String.localizedStringWithFormat(String(localized: "settings.roles.deleteHint", bundle: .lody), String(describing: role.name)), preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
    alert.addAction(UIAlertAction(title: String(localized: "common.delete", bundle: .lody), style: .destructive) { [weak self] _ in
      self?.mutate(remove: true)
    })
    present(alert, animated: true)
  }

  private func mutate(remove: Bool = false) {
    guard !busy, !readOnly, !uncertain, valid, scopeValid else { return }
    let request: AgentRoleRequest
    if remove, let role {
      request = .delete(role)
    } else {
      let fields = RuntimeContract.AgentRolesParamsSaveFields(
        name: name.text ?? "", description: summary.text ?? "", promptPrefix: prompt.text,
        visibility: shared.toggle.isOn ? .workspace : .private
      )
      let destination = target.map { RuntimeContract.AgentRolesParamsSaveTarget(machineId: $0.machineId, agentConfigId: $0.id) }
      request = .save(id: id, base: role, fields: fields, target: destination)
    }
    busy = true
    failure = ""
    render()
    Task { [weak self, service] in
      do {
        _ = try await service(request)
        guard let self else { return }
        self.busy = false
        self.saved?()
        self.closeForm()
      } catch {
        guard let self else { return }
        let result = AgentRoleSections.failure(error)
        self.busy = false
        self.deleteFailed = remove
        self.failure = result.message
        self.uncertain = result.uncertain
        self.render()
      }
    }
  }

  private func text(_ key: String) -> String {
    AgentRoleSections.text(key)
  }
}

@MainActor
final class AgentRoleTargetController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let agents: [AgentRoleAgent]
  private let picked: (AgentRoleAgent) -> Void

  init(agents: [AgentRoleAgent], picked: @escaping (AgentRoleAgent) -> Void) {
    self.agents = agents
    self.picked = picked
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", let self, let index = (body["id"] as? String).flatMap(Int.init),
            self.agents.indices.contains(index) else { return }
      self.picked(self.agents[index])
      self.navigationController?.popViewController(animated: true)
    }
    view.addSubview(list)
    var section = LodyListSection()
    section.id = "agents"
    section.rows = agents.enumerated().map { index, agent in
      var row = LodyListRow()
      row.id = String(index)
      row.title = agent.name
      row.subtitle = agent.machineName
      row.action = true
      return row
    }
    list.setSections([section])
  }
}
