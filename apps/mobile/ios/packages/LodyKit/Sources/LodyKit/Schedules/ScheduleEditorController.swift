import LodyCore
import UIKit

/// A schedule's page, pushed from the Schedules list (web `ScheduleDetailPage`): a new schedule, or
/// an existing one with its enable switch (Run for a manual task) and a More menu (Run now / Delete).
/// Fields: name, prompt, computer, Agent, model, mode, project, destination and the frequency menu
/// (never cron). Wall-clock rules use the computer's zone. A rule the menu cannot name stays read
/// only with Replace, and an untouched rule is sent back exactly as received so the runtime keeps
/// the stored trigger. Read only for teammates' schedules and scheduled messages (delete only);
/// an outdated computer allows only pause and delete.
@MainActor
final class ScheduleEditorController: LodyFormController {
  var changed: (() -> Void)?

  private let workspaceId: String
  private var item: ScheduleItem?
  private let zones: RuntimeContract.SchedulesResult?
  private let catalog: SessionCatalog
  private let service: ScheduleService
  private let scheduleId: String
  private var options: CreationOptions?
  private var detail: RuntimeContract.ScheduleDetail?
  private var loaded = false
  private var loadFailure: String?
  private var busy = false
  private var failure = ""
  /// A save whose outcome is unknown keeps its key so retrying the same draft is idempotent.
  private var pendingSave: (requestId: String, draft: RuntimeContract.ScheduleDraft)?

  private var machineId = ""
  private var agentId = ""
  private var modelId: String?
  private var modeId: String?
  private var project: RuntimeContract.ScheduleProject?
  private var destination = RuntimeContract.ScheduleDraftDestination.newSession
  private var rule = ScheduleRule(kind: .daily, hour: 9, minute: 0)
  private var originalRule: ScheduleRule?
  private var ruleTouched = false

  private lazy var nameField = LodyFormField(id: "schedule-name", label: text("name"), text: item?.title, limit: 200)
  private lazy var promptView = LodyFormTextView(id: "schedule-prompt", label: text("prompt"), text: "", limit: 32 * 1024, minHeight: 120)
  private lazy var promptLabel = LodyFormGroup.caption(color: .lodyInk, size: 15)
  private lazy var machineButton = picker("schedule-machine")
  private lazy var agentButton = picker("schedule-agent")
  private lazy var modelButton = picker("schedule-model")
  private lazy var modeButton = picker("schedule-mode")
  private lazy var projectButton = picker("schedule-project")
  private lazy var destinationButton = picker("schedule-destination")
  private lazy var frequencyButton = picker("schedule-frequency")
  private lazy var everyButton = picker("schedule-every")
  private lazy var daysButton = picker("schedule-days")
  private lazy var branchField = LodyFormField(id: "schedule-branch", label: text("branch"), text: nil, limit: 200)
  private let timePicker = UIDatePicker()
  private let oncePicker = UIDatePicker()
  private var weekdayButtons: [UIButton] = []
  private lazy var enabledToggle = LodyFormToggle(id: "schedule-enabled", title: text("enabled"), isOn: item?.enabled ?? true)
  private lazy var runButton = LodyFormButton.make(id: "schedule-run", title: text("runNow")) { [weak self] in self?.command(.run) }
  private lazy var replaceButton = LodyFormButton.make(id: "schedule-replace", title: text("repeat.replace")) { [weak self] in
    self?.replaceRule()
  }
  private lazy var deleteButton = LodyFormButton.make(id: "schedule-delete", title: text("delete"), destructive: true) { [weak self] in
    self?.confirmDelete()
  }
  private let errorLabel = LodyFormGroup.caption(color: .systemRed, size: 15)
  private let spinner = UIActivityIndicatorView(style: .medium)
  private lazy var saveItem = Self.barButton(symbol: "checkmark", label: text("save"), prominent: true) { [weak self] in self?.save() }
  private lazy var moreItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: nil)

  init(workspaceId: String, item: ScheduleItem?, zones: RuntimeContract.SchedulesResult?, catalog: SessionCatalog, service: ScheduleService) {
    self.workspaceId = workspaceId
    self.item = item
    self.zones = zones
    self.catalog = catalog
    self.service = service
    scheduleId = item?.scheduleId ?? UUID().uuidString.lowercased()
    super.init(nibName: nil, bundle: nil)
    title = item?.title ?? text("new")
    if let item {
      machineId = item.machineId
      agentId = item.agentConfigId
      rule = item.rule
      originalRule = item.rule
      destination = item.destination == .ownSession ? .ownSession : .newSession
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  // MARK: Access

  /// Teammates' schedules and scheduled messages are read only (an owner may still delete a message).
  private var readOnly: Bool { item.map { !$0.isOwner || $0.scheduledMessage } ?? false }
  /// A schedule posting into a picked chat follows that chat; only web edits it.
  private var chatBound: Bool { item?.destination == .existingSession }
  private var locked: Bool { readOnly || chatBound || busy || !loaded }
  private var supported: Bool { item?.machineSupported ?? true }
  private var isNew: Bool { item == nil }
  private var zone: TimeZone { ScheduleFormat.machineZone(machineId, result: zones) }

  // MARK: Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    nameField.clearButtonMode = .whileEditing
    nameField.placeholder = text("namePlaceholder")
    nameField.changed = { [weak self] in self?.edited() }
    promptView.changed = { [weak self] in self?.edited() }
    branchField.changed = { [weak self] in
      guard let self, self.project?.kind == .github else { return }
      self.project?.branch = self.branchField.trimmed
      self.edited()
    }
    promptLabel.accessibilityIdentifier = "schedule-prompt-text"
    errorLabel.accessibilityIdentifier = "schedule-error"
    enabledToggle.toggle.addAction(UIAction { [weak self] _ in self?.toggled() }, for: .valueChanged)
    for picker in [timePicker, oncePicker] {
      picker.preferredDatePickerStyle = .compact
      picker.addAction(UIAction { [weak self, weak picker] _ in
        guard let picker else { return }
        self?.pickedTime(picker)
      }, for: .valueChanged)
    }
    timePicker.datePickerMode = .time
    timePicker.accessibilityIdentifier = "schedule-time"
    oncePicker.datePickerMode = .dateAndTime
    oncePicker.accessibilityIdentifier = "schedule-once"
    let names = DateFormatter().weekdaySymbols ?? []
    weekdayButtons = ScheduleFormat.weekdayInitials.enumerated().map { day, initial in
      let button = UIButton(configuration: .plain(), primaryAction: UIAction { [weak self] _ in self?.toggleWeekday(day) })
      button.configuration?.title = initial
      button.configuration?.cornerStyle = .capsule
      button.accessibilityIdentifier = "schedule-weekday-\(day)"
      button.accessibilityLabel = names.indices.contains(day) ? names[day] : initial
      NSLayoutConstraint.activate([button.widthAnchor.constraint(equalToConstant: 40), button.heightAnchor.constraint(equalToConstant: 44)])
      return button
    }
    spinner.hidesWhenStopped = true
    load()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    render()
  }

  private func load() {
    loadFailure = nil
    spinner.startAnimating()
    rebuild()
    Task { [weak self, service = service, workspaceId = workspaceId, scheduleId = scheduleId, isNew = isNew] in
      var options: CreationOptions?
      var detail: RuntimeContract.ScheduleDetail?
      var failure: String?
      do {
        if !isNew { detail = try await service.detail(workspaceId, scheduleId) }
      } catch {
        failure = ScheduleFailure.message(error, write: false)
      }
      // Choices are optional for a read-only page; the item still names its computer and Agent.
      options = try? await service.options(workspaceId)
      if isNew, options == nil, failure == nil { failure = self?.text("loadOptionsError") }
      guard let self else { return }
      self.spinner.stopAnimating()
      if let failure {
        self.loadFailure = failure
        self.rebuild()
        return
      }
      self.options = options
      self.apply(detail)
    }
  }

  private func apply(_ detail: RuntimeContract.ScheduleDetail?) {
    self.detail = detail
    if let detail {
      item = detail.item
      machineId = detail.item.machineId
      agentId = detail.item.agentConfigId
      rule = detail.item.rule
      originalRule = detail.item.rule
      modelId = detail.modelId
      modeId = detail.modeId
      project = detail.project
      promptView.text = detail.prompt
      promptLabel.text = detail.prompt
      enabledToggle.toggle.isOn = detail.item.enabled
    } else if isNew {
      machineId = machines.first?.id ?? ""
      agentId = agents.first?.id ?? ""
      rule = ScheduleRule(kind: .daily, hour: 9, minute: 0, timeZone: zone.identifier)
      ruleTouched = true
    }
    branchField.text = project?.branch
    loaded = true
    rebuild()
  }

  // MARK: Choices

  /// Owned computers with an Agent, in creation-options order (a schedule runs only on its owner's
  /// computer); a stored computer that went away stays listed.
  private var machines: [(id: String, name: String)] {
    let owned = zones.map { Set($0.ownedMachineIds) }
    var seen = Set<String>()
    var result: [(id: String, name: String)] = []
    for agent in options?.agents ?? []
    where owned?.contains(agent.machineId) != false && seen.insert(agent.machineId).inserted {
      result.append((agent.machineId, agent.machineName))
    }
    if let item, !seen.contains(item.machineId) { result.append((item.machineId, item.machineName ?? item.machineId)) }
    return result
  }

  private var agents: [CreationAgent] { (options?.agents ?? []).filter { $0.machineId == machineId } }
  private var agent: CreationAgent? { agents.first { $0.id == agentId } }

  private var capability: Capability? {
    guard let options else { return nil }
    return CreateLogic.capability(
      in: options.capabilities, machineId: machineId, configId: agentId, cliType: agent?.cliType ?? "", agentType: agent?.agentType ?? ""
    )
  }

  private var machineName: String {
    machines.first { $0.id == machineId }?.name ?? item?.machineName ?? ""
  }

  private var agentName: String { agent?.name ?? item?.agentName ?? "" }

  /// Chat only, the local projects on this computer, then the workspace's GitHub repositories.
  private var projectChoices: [(title: String, value: RuntimeContract.ScheduleProject)] {
    var result: [(title: String, value: RuntimeContract.ScheduleProject)] = []
    var repos = Set<String>()
    for entry in catalog.projects {
      if let range = entry.id.range(of: ":local:"), entry.machineId == machineId {
        let id = String(entry.id[range.upperBound...])
        result.append((entry.name.isEmpty ? id : entry.name, .init(kind: .local, localProjectId: id, name: entry.name)))
        continue
      }
      let repo = entry.repoFullName ?? (entry.id.hasPrefix("github:") ? String(entry.id.dropFirst(7)) : "")
      if !repo.isEmpty, repos.insert(repo).inserted {
        result.append((repo, .init(kind: .github, repoFullName: repo, branch: "main", name: repo)))
      }
    }
    if let project, !result.contains(where: { Self.same($0.value, project) }) {
      result.append((projectTitle(project), project))
    }
    return result
  }

  private static func same(_ a: RuntimeContract.ScheduleProject, _ b: RuntimeContract.ScheduleProject) -> Bool {
    a.kind == b.kind && a.localProjectId == b.localProjectId && a.repoFullName == b.repoFullName
  }

  private func projectTitle(_ value: RuntimeContract.ScheduleProject?) -> String {
    guard let value else { return text("chatOnly") }
    return value.name ?? value.repoFullName ?? value.localProjectId ?? ""
  }

  // MARK: Form

  private func picker(_ id: String) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.titleLineBreakMode = .byTruncatingMiddle
    let button = UIButton(configuration: configuration)
    button.showsMenuAsPrimaryAction = true
    button.accessibilityIdentifier = id
    return button
  }

  /// Rebuilds the groups; rows depend on the item, the frequency and the project.
  private func rebuild() {
    guard isViewLoaded else { return }
    for view in stack.arrangedSubviews {
      stack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
    stack.addArrangedSubview(LodyFormGroup.inset(errorLabel))
    if let loadFailure {
      errorLabel.text = loadFailure
      let retry = LodyFormButton.make(id: "schedule-retry", title: text("retry")) { [weak self] in self?.load() }
      stack.addArrangedSubview(LodyFormGroup(retry))
      render()
      return
    }
    if !loaded {
      spinner.translatesAutoresizingMaskIntoConstraints = false
      stack.addArrangedSubview(spinner)
      render()
      return
    }
    if let item, !isNew { stack.addArrangedSubview(statusGroup(item)) }
    stack.addArrangedSubview(LodyFormGroup(rows: [nameField]))
    if item?.scheduledMessage == true || readOnly {
      promptLabel.text = promptView.text
      stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), rows: [LodyFormGroup.inset(promptLabel, top: 12, bottom: 12)]))
    } else {
      stack.addArrangedSubview(LodyFormGroup(header: text("prompt"), rows: [promptView]))
    }
    if item?.scheduledMessage != true {
      stack.addArrangedSubview(LodyFormGroup(header: text("runWith"), footer: runFooter(), rows: runRows()))
      stack.addArrangedSubview(LodyFormGroup(header: text("repeat.label"), footer: frequencyFooter(), rows: frequencyRows()))
    }
    if let item, item.isOwner { stack.addArrangedSubview(LodyFormGroup(deleteButton)) }
    render()
  }

  private func statusGroup(_ item: ScheduleItem) -> UIView {
    let status = ScheduleFormat.state(item.state, zone: ScheduleFormat.zone(item, result: zones))
    let words = [status.label, status.detail].compactMap { $0 }.joined(separator: " · ")
    var rows: [UIView] = []
    if item.isOwner, !item.scheduledMessage {
      if item.rule.kind == .manual { rows.append(runButton) } else { rows.append(enabledToggle) }
    }
    return LodyFormGroup(footer: words, rows: rows)
  }

  private func runRows() -> [UIView] {
    var rows: [UIView] = [
      LodyFormRow(label: text("computer"), content: machineButton, picker: true),
      LodyFormRow(label: text("agent"), content: agentButton, picker: true),
      LodyFormRow(label: text("model"), content: modelButton, picker: true),
      LodyFormRow(label: text("mode"), content: modeButton, picker: true),
    ]
    if !chatBound {
      rows.append(LodyFormRow(label: text("project"), content: projectButton, picker: true))
      if project?.kind == .github { rows.append(branchField) }
    }
    rows.append(LodyFormRow(label: text("sendTo"), content: destinationButton, picker: !chatBound))
    return rows
  }

  private func runFooter() -> String? {
    var notes: [String] = []
    if !supported { notes.append(text("upgrade")) }
    if readOnly { notes.append(text("readOnly")) }
    if chatBound { notes.append(text("destination.existingSessionHint")) }
    if destination == .ownSession, !chatBound { notes.append(text("destination.ownSessionPendingHint")) }
    return notes.isEmpty ? nil : notes.joined(separator: " ")
  }

  private func frequencyRows() -> [UIView] {
    var rows: [UIView] = [LodyFormRow(label: text("repeat.label"), content: frequencyButton, picker: rule.kind != .unsupported)]
    switch rule.kind {
    case .daily, .weekdays:
      rows.append(LodyFormRow(label: text("repeat.at"), content: timePicker))
    case .weekly:
      let days = UIStackView(arrangedSubviews: weekdayButtons)
      days.distribution = .equalSpacing
      days.alignment = .center
      days.accessibilityLabel = text("repeat.on")
      rows.append(LodyFormGroup.inset(days, top: 4, bottom: 4))
      rows.append(LodyFormRow(label: text("repeat.at"), content: timePicker))
    case .monthly:
      rows.append(LodyFormRow(label: text("repeat.onDays"), content: daysButton, picker: true))
      rows.append(LodyFormRow(label: text("repeat.at"), content: timePicker))
    case .minutes, .hours:
      rows.append(LodyFormRow(label: text("repeat.every"), content: everyButton, picker: true))
    case .once:
      rows.append(LodyFormRow(label: text("repeat.runAt"), content: oncePicker))
    case .unsupported:
      if !readOnly { rows.append(replaceButton) }
    case .manual:
      break
    }
    return rows
  }

  private func frequencyFooter() -> String? {
    switch rule.kind {
    case .manual: return text("trigger.manualHelp")
    case .unsupported: return text("repeat.unsupportedHint")
    default:
      let clock = String(format: text("machineClock"), machineName.isEmpty ? text("computer") : machineName)
      return "\(clock) (\(zone.identifier))"
    }
  }

  /// Refreshes titles, menus and enablement without rebuilding rows.
  private func render() {
    guard isViewLoaded else { return }
    errorLabel.text = loadFailure ?? failure
    errorLabel.superview?.isHidden = errorLabel.text?.isEmpty ?? true
    let editable = !locked
    nameField.isEnabled = editable
    promptView.isEditable = editable
    branchField.isEnabled = editable
    timePicker.isEnabled = editable
    oncePicker.isEnabled = editable
    for button in [machineButton, agentButton, modelButton, modeButton, projectButton, destinationButton, frequencyButton, everyButton, daysButton] {
      button.isEnabled = editable
    }
    machineButton.configuration?.title = machineName
    machineButton.menu = menu(machines.map { ($0.name, $0.id == machineId, $0.id) }) { [weak self] id in self?.pickMachine(id) }
    agentButton.configuration?.title = agentName
    agentButton.menu = menu(agents.map { ($0.name, $0.id == agentId, $0.id) }) { [weak self] id in self?.pickAgent(id) }
    let models = capability?.models ?? []
    modelButton.configuration?.title = models.first { $0.id == modelId }?.name ?? modelId ?? text("defaultOption")
    modelButton.menu = menu([(text("defaultOption"), modelId == nil, "")] + models.map { ($0.name, $0.id == modelId, $0.id) }) {
      [weak self] id in
      self?.modelId = id.isEmpty ? nil : id
      self?.edited()
    }
    let modes = capability?.modes ?? []
    modeButton.configuration?.title = modes.first { $0.id == modeId }?.name ?? modeId ?? text("defaultOption")
    modeButton.menu = menu([(text("defaultOption"), modeId == nil, "")] + modes.map { ($0.name, $0.id == modeId, $0.id) }) {
      [weak self] id in
      self?.modeId = id.isEmpty ? nil : id
      self?.edited()
    }
    let projects = projectChoices
    projectButton.configuration?.title = projectTitle(project)
    projectButton.menu = menu([(text("chatOnly"), project == nil, "")] + projects.enumerated().map { index, choice in
      (choice.title, project.map { Self.same($0, choice.value) } ?? false, String(index))
    }) { [weak self] id in
      guard let self else { return }
      let choice = Int(id).flatMap { projects.indices.contains($0) ? projects[$0].value : nil }
      self.pickProject(choice)
    }
    destinationButton.configuration?.title = chatBound ? text("destination.existingSession") : destinationTitle(destination)
    destinationButton.menu = menu([RuntimeContract.ScheduleDraftDestination.newSession, .ownSession].map {
      (destinationTitle($0), $0 == destination, $0.rawValue)
    }) { [weak self] id in
      guard let self, let next = RuntimeContract.ScheduleDraftDestination(rawValue: id) else { return }
      self.destination = next
      self.edited(rebuild: true)
    }
    if chatBound { destinationButton.isEnabled = false }
    renderFrequency()
    renderHeader()
  }

  private func destinationTitle(_ value: RuntimeContract.ScheduleDraftDestination) -> String {
    text(value == .ownSession ? "destination.ownSession" : "destination.newSession")
  }

  private func menu(_ choices: [(String, Bool, String)], picked: @escaping (String) -> Void) -> UIMenu {
    UIMenu(options: .singleSelection, children: choices.map { title, on, id in
      UIAction(title: title, state: on ? .on : .off) { _ in picked(id) }
    })
  }

  private func renderFrequency() {
    frequencyButton.configuration?.title = Self.frequencyTitle(rule.kind)
    if rule.kind == .unsupported {
      frequencyButton.configuration?.title = ScheduleFormat.summary(rule, zone: zone)
      frequencyButton.isEnabled = false
    }
    let kinds: [RuntimeContract.ScheduleRuleKind] = [.manual, .daily, .weekdays, .weekly, .monthly, .hours, .minutes, .once]
    frequencyButton.menu = menu(kinds.map { (Self.frequencyTitle($0), $0 == rule.kind, $0.rawValue) }) { [weak self] id in
      guard let kind = RuntimeContract.ScheduleRuleKind(rawValue: id) else { return }
      self?.pickFrequency(kind)
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    timePicker.timeZone = zone
    oncePicker.timeZone = zone
    if let date = calendar.date(bySettingHour: rule.hour ?? 9, minute: rule.minute ?? 0, second: 0, of: Date()) {
      timePicker.date = date
    }
    oncePicker.minimumDate = Date()
    oncePicker.date = Date(timeIntervalSince1970: (rule.at ?? (LodyRelativeTime.now() + 3_600_000)) / 1000)
    let selectedDays = Set(rule.weekdays ?? [])
    for (day, button) in weekdayButtons.enumerated() {
      let on = selectedDays.contains(day)
      var configuration = on ? UIButton.Configuration.filled() : UIButton.Configuration.plain()
      configuration.title = button.configuration?.title
      configuration.cornerStyle = .capsule
      configuration.baseBackgroundColor = .lodyInk
      configuration.baseForegroundColor = on ? .lodyGround : .lodyInk
      button.configuration = configuration
      button.accessibilityTraits = on ? [.button, .selected] : [.button]
      button.isEnabled = !locked
    }
    let steps = rule.kind == .hours ? [1, 2, 3, 4, 6, 8, 12] : [5, 10, 15, 20, 30]
    let every = rule.every ?? steps[0]
    everyButton.configuration?.title = ScheduleFormat.summary(rule, zone: zone)
    everyButton.menu = menu(steps.map { step -> (String, Bool, String) in
      var sample = rule
      sample.every = step
      return (ScheduleFormat.summary(sample, zone: zone), step == every, String(step))
    }) { [weak self] id in
      guard let self, let step = Int(id) else { return }
      self.rule.every = step
      self.touchedRule()
    }
    let days = (rule.days ?? []).sorted()
    daysButton.configuration?.title = days.isEmpty ? text("requireMonthDay") : ScheduleFormat.list(days.map(String.init))
    // Built when opened and closed on tap, so each pick shows its checkmark next time.
    daysButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
      let current = Set(self?.rule.days ?? [])
      completion((1...31).map { day in
        UIAction(title: String(format: ScheduleFormat.text("repeat.dayOfMonthN"), String(day)), state: current.contains(day) ? .on : .off) {
          [weak self] _ in self?.toggleMonthDay(day)
        }
      })
    }])
  }

  private static func frequencyTitle(_ kind: RuntimeContract.ScheduleRuleKind) -> String {
    let keys: [RuntimeContract.ScheduleRuleKind: String] = [
      .manual: "trigger.manual", .daily: "repeat.daily", .weekdays: "repeat.weekdays", .weekly: "repeat.weekly",
      .monthly: "repeat.monthly", .hours: "repeat.hours", .minutes: "repeat.minutes", .once: "repeat.once",
      .unsupported: "repeat.custom",
    ]
    return ScheduleFormat.text(keys[kind] ?? "repeat.custom")
  }

  private func renderHeader() {
    guard let header else { return }
    header.rightBarButtonItems = barItems()
  }

  private func barItems() -> [UIBarButtonItem] {
    var items: [UIBarButtonItem] = []
    if !readOnly, !chatBound {
      saveItem.isEnabled = loaded && !busy && supported && draft() != nil
      items.append(saveItem)
    }
    guard let item, item.isOwner else { return items }
    var actions: [UIMenuElement] = []
    if !item.scheduledMessage {
      let run = UIAction(title: text("runNow"), image: UIImage(systemName: "play")) { [weak self] _ in self?.command(.run) }
      if !supported || busy { run.attributes = .disabled }
      actions.append(run)
    }
    actions.append(UIAction(title: text("delete"), image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
      self?.confirmDelete()
    })
    moreItem.menu = UIMenu(children: actions)
    moreItem.accessibilityLabel = text("more")
    moreItem.accessibilityIdentifier = "schedule-more"
    items.append(moreItem)
    return items
  }

  // MARK: Edits

  private func edited(rebuild structural: Bool = false) {
    failure = ""
    if structural { rebuild() } else { render() }
  }

  private func touchedRule() {
    ruleTouched = true
    edited()
  }

  private func pickMachine(_ id: String) {
    guard id != machineId else { return }
    machineId = id
    if !agents.contains(where: { $0.id == agentId }) { agentId = agents.first?.id ?? "" }
    clampRunConfig()
    if project?.kind == .local { project = nil }
    // Calendar rules keep their wall time on the new computer's clock.
    if rule.kind != .manual, rule.kind != .once, rule.kind != .unsupported {
      rule.timeZone = zone.identifier
      ruleTouched = true
    }
    edited(rebuild: true)
  }

  private func pickAgent(_ id: String) {
    agentId = id
    clampRunConfig()
    edited()
  }

  /// A model or mode the new Agent does not offer falls back to its default.
  private func clampRunConfig() {
    if let modelId, !(capability?.models ?? []).contains(where: { $0.id == modelId }) { self.modelId = nil }
    if let modeId, !(capability?.modes ?? []).contains(where: { $0.id == modeId }) { self.modeId = nil }
  }

  private func pickProject(_ value: RuntimeContract.ScheduleProject?) {
    project = value
    branchField.text = value?.branch
    edited(rebuild: true)
  }

  private func pickFrequency(_ kind: RuntimeContract.ScheduleRuleKind) {
    guard kind != rule.kind else { return }
    var next = ScheduleRule(kind: kind)
    switch kind {
    case .daily, .weekdays, .weekly, .monthly:
      next.hour = rule.hour ?? 9
      next.minute = rule.minute ?? 0
      next.timeZone = zone.identifier
      if kind == .weekly { next.weekdays = rule.weekdays ?? [1] }
      if kind == .monthly { next.days = rule.days ?? [1] }
    case .hours:
      next.every = 1
      next.timeZone = zone.identifier
    case .minutes:
      next.every = 30
      next.timeZone = zone.identifier
    case .once:
      next.at = rule.at ?? (LodyRelativeTime.now() + 3_600_000)
    case .manual, .unsupported:
      break
    }
    // Returning to the stored rule's kind restores it untouched.
    if let originalRule, originalRule.kind == kind {
      rule = originalRule
      ruleTouched = false
    } else {
      rule = next
      ruleTouched = true
    }
    edited(rebuild: true)
  }

  private func replaceRule() {
    rule = ScheduleRule(kind: .daily, hour: 9, minute: 0, timeZone: zone.identifier)
    ruleTouched = true
    edited(rebuild: true)
  }

  private func pickedTime(_ picker: UIDatePicker) {
    if picker === oncePicker {
      rule.at = (picker.date.timeIntervalSince1970 * 1000).rounded()
    } else {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      let parts = calendar.dateComponents([.hour, .minute], from: picker.date)
      rule.hour = parts.hour ?? 0
      rule.minute = parts.minute ?? 0
      rule.timeZone = zone.identifier
    }
    touchedRule()
  }

  private func toggleWeekday(_ day: Int) {
    var days = Set(rule.weekdays ?? [])
    if days.contains(day) { days.remove(day) } else { days.insert(day) }
    rule.weekdays = days.sorted()
    touchedRule()
  }

  private func toggleMonthDay(_ day: Int) {
    var days = Set(rule.days ?? [])
    if days.contains(day) { days.remove(day) } else { days.insert(day) }
    rule.days = days.sorted()
    touchedRule()
  }

  // MARK: Commands

  /// The draft to save, or nil while a required field is missing.
  private func draft() -> RuntimeContract.ScheduleDraft? {
    let prompt = promptView.text ?? ""
    guard !nameField.trimmed.isEmpty, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !machineId.isEmpty, agent != nil else { return nil }
    let sent = ruleTouched ? rule : (originalRule ?? rule)
    if sent.kind == .weekly, (sent.weekdays ?? []).isEmpty { return nil }
    if sent.kind == .monthly, (sent.days ?? []).isEmpty { return nil }
    if project?.kind == .github, (project?.branch ?? "").isEmpty { return nil }
    return RuntimeContract.ScheduleDraft(
      title: nameField.trimmed, prompt: prompt, machineId: machineId, agentConfigId: agentId, modelId: modelId, modeId: modeId,
      project: project, destination: destination, rule: sent
    )
  }

  private func save() {
    guard !busy, !locked, supported, let draft = draft() else { return }
    let requestId = pendingSave.flatMap { $0.draft == draft ? $0.requestId : nil } ?? ScheduleService.requestId()
    let params = RuntimeContract.ScheduleCommandParams(
      workspaceId: workspaceId, action: isNew ? .create : .edit, scheduleId: scheduleId, requestId: requestId, draft: draft
    )
    busy = true
    failure = ""
    render()
    view.endEditing(true)
    Task { [weak self, service = service] in
      do {
        _ = try await service.command(params)
        guard let self else { return }
        self.busy = false
        self.pendingSave = nil
        self.changed?()
        LodyShell.shared.close(from: self)
      } catch {
        guard let self else { return }
        self.busy = false
        self.pendingSave = ScheduleFailure.unknown(error) ? (requestId, draft) : nil
        self.failure = ScheduleFailure.message(error, write: true)
        self.render()
      }
    }
  }

  private func toggled() {
    command(enabledToggle.toggle.isOn ? .resume : .pause)
  }

  private func confirmDelete() {
    guard let item else { return }
    let alert = UIAlertController(
      title: String(format: text("deleteTitle"), item.title),
      message: text(item.scheduledMessage ? "deleteMessageHelp" : "deleteHelp"), preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: text("cancel"), style: .cancel))
    alert.addAction(UIAlertAction(title: text("delete"), style: .destructive) { [weak self] _ in self?.command(.delete) })
    present(alert, animated: true)
  }

  /// Pause, resume, run and delete act on the stored schedule at once, each with a fresh key.
  private func command(_ action: ScheduleAction) {
    guard let item, item.isOwner, !busy else { return }
    if action == .resume || action == .run, !supported {
      enabledToggle.toggle.isOn = item.enabled
      return
    }
    let params = RuntimeContract.ScheduleCommandParams(
      workspaceId: workspaceId, action: action, scheduleId: item.scheduleId, requestId: ScheduleService.requestId()
    )
    busy = true
    failure = ""
    render()
    Task { [weak self, service = service] in
      do {
        _ = try await service.command(params)
        guard let self else { return }
        self.busy = false
        self.changed?()
        switch action {
        case .delete:
          LodyShell.shared.close(from: self)
        case .run:
          LodyToastOverlay.shared.show(message: String(format: self.text("runStarted"), item.title), kind: .neutral)
          self.render()
        default:
          self.item?.enabled = action == .resume
          self.render()
        }
      } catch {
        guard let self else { return }
        self.busy = false
        self.enabledToggle.toggle.isOn = self.item?.enabled ?? true
        self.failure = ScheduleFailure.message(error, write: true)
        self.render()
      }
    }
  }

  private func text(_ key: String) -> String { ScheduleFormat.text(key) }
}
