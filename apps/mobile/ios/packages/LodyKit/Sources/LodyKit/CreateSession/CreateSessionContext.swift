import LodyCore
import LodyDesignSystem
import SwiftUI

// The new-session page's context and run configuration, after web's mobile new-chat page
// (`components/mobile/mobile-new-chat-sheet.tsx`, `mobile-inline-picker.tsx`,
// `mobile-run-config-sheet.tsx`), checked by driving its Storybook stories:
//
// - Computer and project are full-width cards with a pop-up indicator. Tapping one expands its
//   options in place right below it (an accordion, not a menu); one list is open at a time.
//   Computers without an online assistant are listed but disabled. The project list searches
//   every project and leads with No project (chat only), then recent projects, then More projects….
// - Below them: the worktree chip for local projects, or the branch picker for GitHub projects,
//   expanding inline with search.
// - The assistant is not on the page: it lives in the composer's run-config chip, whose sheet
//   holds Agent / Model / Reasoning / Mode rows that expand the same way. New sessions have no
//   Plan / Fast toggles.

// MARK: - Model

enum CreateGlyph: Equatable {
  case lody(LodyIcon)
  case repository(String)
  /// An agent mark from the app's asset catalog, drawn in its own colours.
  case asset(String)
  case symbol(String)
  /// An Agent Role's emoji.
  case emoji(String)
}

struct CreateOption: Identifiable, Equatable {
  var id: String
  var title: String
  var subtitle = ""
  var glyph: CreateGlyph?
  var selected = false
  var disabled = false
  /// Matched by search in addition to the title and subtitle.
  var searchText = ""
}

struct CreatePicker: Identifiable, Equatable {
  var id: String
  var glyph: CreateGlyph
  var title: String
  var placeholder = false
  var loading = false
  /// Empty: the line is not a choice here.
  var options: [CreateOption] = []
  /// Search runs over these instead of `options` when present (every project, not just recent).
  var searchOptions: [CreateOption]?
  var searchPlaceholder = ""
  /// A run-config switch (web's Plan / Fast) instead of a list; picks report "on" / "off".
  var toggle: Bool?
  var searchable: Bool { searchOptions != nil || options.count > 8 }
}

struct CreatePanel: Equatable {
  var cards: [CreatePicker] = []
  /// Local projects: the worktree chip's state; nil hides it.
  var worktree: Bool?
  var branch: CreatePicker?
  var note = ""
  var noteWarning = false
  /// The note reads "Tap to retry": tapping it reads the creation options again.
  var noteRetry = false
}

enum CreateSessionContext {
  static let chatOption = "chat"
  static let moreOption = "more"
  static let loadMoreOption = "load-more"
  static let recentLimit = 5

  private static func text(_ key: String) -> String { String(localized: String.LocalizationValue(key), bundle: .lody) }

  static func panel(_ form: CreateSessionForm) -> CreatePanel {
    let page = form.current
    var panel = CreatePanel()

    // Computer: every known computer; ones without an online assistant are disabled, as web.
    let machines = allMachines(form)
    let online = onlineMachines(form)
    let machineName = page.machine?.name ?? form.machineNames[page.machineId]
    let selectedMachine = page.machine?.id ?? (page.machineId.isEmpty ? nil : page.machineId)
    var machineOptions: [CreateOption] = []
    if !form.locked && machines.count > 1 {
      machineOptions = machines.map { machine in
        let offline = online.map { !$0.contains(machine.id) } ?? false
        return CreateOption(
          id: machine.id, title: machine.name, subtitle: offline ? text("create.context.offline") : "",
          glyph: machineGlyph(form, machine.id, name: machine.name), selected: machine.id == selectedMachine, disabled: offline)
      }
    }
    panel.cards.append(CreatePicker(
      id: "machine", glyph: selectedMachine.map { machineGlyph(form, $0, name: machineName ?? "") } ?? .lody(.machine),
      title: machineName ?? text(page.loading ? "common.reading" : "create.row.selectMachine"),
      placeholder: machineName == nil, loading: page.loading && machineName == nil, options: machineOptions,
      searchPlaceholder: text("create.context.searchMachines")
    ))

    // Project, or chat only.
    let project = form.projects.first { $0.id == page.projectId }
    var projectTitle = text("create.context.chat")
    if !page.chat { projectTitle = project?.name ?? text("create.row.selectProject") }
    panel.cards.append(CreatePicker(
      id: "project",
      glyph: page.chat ? .symbol("circle.slash") : projectGlyph(page.projectId),
      title: projectTitle,
      placeholder: !page.chat && project == nil,
      options: form.locked ? [] : projectOptions(form, recent: true),
      searchOptions: form.locked ? nil : projectOptions(form, recent: false),
      searchPlaceholder: text("create.context.searchProjects")
    ))

    if page.local { panel.worktree = page.worktree }
    if page.github { panel.branch = branchPicker(form) }

    if form.deferUnresolved && page.options == nil {
      panel.note = text("native.share.deferred")
    } else if !form.deferUnresolved, let message = page.unavailableMessage {
      panel.note = message
      panel.noteWarning = true
      panel.noteRetry = page.retriesOptions
    } else if page.failed {
      panel.note = text("create.machineConfig.retry")
      panel.noteRetry = true
    }
    return panel
  }

  private static func branchPicker(_ form: CreateSessionForm) -> CreatePicker {
    let page = form.current
    var title = page.branch
    var placeholder = false
    if title.isEmpty {
      placeholder = true
      if page.branchesLoading { title = text("create.context.branchLoading") }
      else if page.branchesFailed { title = text("create.branch.unavailable") }
      else { title = text("create.branch.placeholder") }
    }
    let names = (page.branches?.names ?? []).map { CreateOption(id: $0, title: $0, selected: $0 == page.branch) }
    var options = names
    if page.branches?.nextPage != nil && !form.deferUnresolved {
      options.append(CreateOption(
        id: loadMoreOption, title: text(page.branchesLoading ? "common.reading" : "create.context.loadMore"), glyph: .symbol("ellipsis")))
    }
    return CreatePicker(
      id: "branch", glyph: .lody(.branch), title: title, placeholder: placeholder,
      loading: page.branchesLoading && page.branch.isEmpty, options: options, searchOptions: names,
      searchPlaceholder: text("create.context.searchBranches"))
  }

  /// The SF Symbol for a computer, like the system draws Apple devices: a Mac laptop or desktop
  /// by its name, a PC for Windows, a server for Linux; the generic computer when unknown.
  static func machineGlyph(_ form: CreateSessionForm, _ id: String, name: String) -> CreateGlyph {
    let lower = name.lowercased()
    switch form.machineOs[id] {
    case "darwin":
      if lower.contains("macbook") || lower.contains("powerbook") { return .symbol("laptopcomputer") }
      if lower.contains("mini") { return .symbol("macmini") }
      if lower.contains("studio") { return .symbol("macstudio") }
      if lower.contains("mac pro") { return .symbol("macpro.gen3") }
      return lower.contains("imac") ? .symbol("desktopcomputer") : .symbol("laptopcomputer")
    case "win32":
      return .symbol("pc")
    case "linux":
      return .symbol("server.rack")
    default:
      return .symbol("desktopcomputer")
    }
  }

  private static func projectGlyph(_ id: String) -> CreateGlyph {
    if id.hasPrefix(CreateSessionSelection.groupPrefix) { return .lody(.projectGroup) }
    return CreateProjectPicker.isGithub(id) ? .repository(String(id.dropFirst("github:".count))) : .lody(.folder)
  }

  /// A project row's second line: GitHub, the folder, or how many repositories a group holds.
  private static func projectSubtitle(_ form: CreateSessionForm, _ project: CreateProject) -> String {
    if let members = form.groupMembers[project.id] {
      return String.localizedStringWithFormat(String(localized: "create.context.groupMembers", bundle: .lody), members)
    }
    return CreateProjectPicker.isGithub(project.id) ? "GitHub" : abbreviated(project.rootPath)
  }

  /// No project first; then recent projects usable on the chosen computer (its local projects
  /// and any GitHub project) and More projects…, or for search every usable project.
  private static func projectOptions(_ form: CreateSessionForm, recent: Bool) -> [CreateOption] {
    let chat = CreateOption(id: chatOption, title: text("create.context.chat"), glyph: .symbol("circle.slash"), selected: form.current.chat)
    let shown = recent ? recentProjects(form) : form.availableProjects
    var options = [chat] + shown.map { project in
      CreateOption(
        id: project.id, title: project.name,
        subtitle: projectSubtitle(form, project),
        glyph: projectGlyph(project.id), selected: !form.current.chat && project.id == form.current.projectId,
        searchText: project.rootPath)
    }
    if recent { options.append(CreateOption(id: moreOption, title: text("create.context.moreProjects"), glyph: .symbol("ellipsis"))) }
    return options
  }

  private static func abbreviated(_ path: String) -> String {
    path.replacingOccurrences(of: #"^/(Users|home)/[^/]+"#, with: "~", options: .regularExpression)
  }

  /// Preserve the selected project only while it remains usable on this computer.
  static func recentProjects(_ form: CreateSessionForm) -> [CreateProject] {
    let available = form.availableProjects
    var recent = Array(available.prefix(recentLimit))
    if !form.current.chat, let current = available.first(where: { $0.id == form.current.projectId }), !recent.contains(where: { $0.id == current.id }) {
      recent.insert(current, at: 0)
    }
    return recent
  }

  /// Computers with assistants online plus every computer the workspace knows.
  static func allMachines(_ form: CreateSessionForm) -> [(id: String, name: String)] {
    var seen = Set<String>()
    let known = form.machineNames.sorted { $0.value.localizedCompare($1.value) == .orderedAscending }.map { (id: $0.key, name: $0.value) }
    return (form.current.machines + known).filter { seen.insert($0.id).inserted }
  }

  /// Computers with an assistant online, read from the full options snapshot (covering every
  /// computer); nil while unknown, so nothing is disabled on a guess.
  private static func onlineMachines(_ form: CreateSessionForm) -> Set<String>? {
    guard form.current.options != nil else { return nil }
    return Set(form.current.machines.map(\.id))
  }

  // MARK: Run configuration

  static func runConfig(_ form: CreateSessionForm) -> [CreatePicker] {
    let page = form.current
    var rows: [CreatePicker] = []
    // Role sits above Agent because a Role answers every row under it (web). Shown whenever the
    // Roles are listed, even with none to pick: then it reads None.
    if form.roles != nil, !page.agents.isEmpty {
      let active = form.activeRole
      // An empty glyph keeps None's title in line with the Roles' emoji.
      let none = CreateOption(id: roleNoneOption, title: text("create.role.none"), glyph: .emoji(""), selected: active == nil)
      rows.append(CreatePicker(
        id: "role", glyph: active.map { CreateGlyph.emoji($0.glyph) } ?? .lody(.user), title: active?.role.name ?? text("create.role.none"),
        placeholder: active == nil,
        options: [none] + form.roleItems.map { item in
          CreateOption(
            id: item.role.id, title: item.role.name, subtitle: item.unavailable.map(text) ?? "",
            glyph: .emoji(item.glyph), selected: item.role.id == active?.role.id, disabled: item.unavailable != nil)
        }))
    }
    if !page.agents.isEmpty {
      rows.append(CreatePicker(
        id: "agent", glyph: agentGlyph(page.agent?.cliType, page.agent?.agentType), title: page.agent?.name ?? text("create.row.selectAgent"),
        placeholder: page.agent == nil,
        options: page.agents.map { CreateOption(id: $0.key, title: $0.name, glyph: agentGlyph($0.cliType, $0.agentType), selected: $0.key == page.agentKey) }))
    }
    guard let capability = page.capability else { return rows }
    if !capability.models.isEmpty {
      let current = capability.models.first { $0.id == page.choice.modelId }
      rows.append(CreatePicker(
        id: "model", glyph: .symbol("cpu"), title: current?.name ?? text("model.default"), placeholder: current == nil,
        options: capability.models.map { CreateOption(id: $0.id, title: $0.name, selected: $0.id == page.choice.modelId) },
        searchPlaceholder: text("create.context.searchModels")))
    }
    let efforts = CreateLogic.effortsFor(capability, modelId: page.choice.modelId)
    if !efforts.isEmpty {
      rows.append(CreatePicker(
        id: "effort", glyph: .symbol("brain"), title: page.choice.effort ?? text("model.default"), placeholder: page.choice.effort == nil,
        options: efforts.map { CreateOption(id: $0, title: $0, selected: $0 == page.choice.effort) }))
    }
    if let permission = CreateLogic.permissionMode(capability, page.choice), !permission.options.isEmpty {
      let current = permission.options.first { $0.id == permission.value }
      rows.append(CreatePicker(
        id: "permission", glyph: .symbol("checkmark.shield"), title: current?.name ?? text("model.default"), placeholder: current == nil,
        options: permission.options.map { CreateOption(id: $0.id, title: $0.name, subtitle: $0.description ?? "", selected: $0.id == permission.value) }))
    }
    return rows
  }

  /// Web's "Recently used" group atop the run-config menu: whole configurations a chat was
  /// started with on this computer, read like the chip (agent or Role · model · effort · mode).
  /// Picking one applies all of it.
  static func recents(_ form: CreateSessionForm) -> [CreateOption] {
    let page = form.current
    let roles = Dictionary(form.roleItems.map { ($0.role.id, $0) }, uniquingKeysWith: { first, _ in first })
    return form.recentRunConfigs.compactMap { item in
      let record = item.record
      guard let agent = page.agents.first(where: { $0.key == record.agentKey }) else { return nil }
      let capability = CreateLogic.capabilityFor(page.options, agent)
      let choice = record.choice
      let model = choice.modelId.map { id in capability?.models.first { $0.id == id }?.name ?? id }
      let mode = CreateLogic.permissionMode(capability, choice).flatMap { permission in
        permission.options.first { $0.id == permission.value }?.name
      }
      let role = record.agentRoleId.flatMap { roles[$0] }
      return CreateOption(
        id: item.key, title: role?.role.name ?? agent.name,
        subtitle: [model, choice.effort, mode].compactMap { $0 }.joined(separator: " · "),
        glyph: role.map { CreateGlyph.emoji($0.glyph) } ?? agentGlyph(agent.cliType, agent.agentType))
    }
  }

  static let recentRow = "recent"
  static let roleNoneOption = "__none__"
  static let toggleOn = "on"
  static let toggleOff = "off"

  private static let runConfigLabels = [
    "role": "create.runConfig.role",
    "agent": "create.runConfig.agent", "model": "create.runConfig.model",
    "effort": "create.runConfig.reasoning", "permission": "create.runConfig.mode",
    "plan": "create.runConfig.plan", "fast": "create.runConfig.fast",
  ]

  static func runConfigLabel(_ id: String) -> String { text(runConfigLabels[id] ?? "create.runConfig.mode") }

  private static func agentGlyph(_ cliType: String?, _ agentType: String?) -> CreateGlyph {
    switch LodyAgentIcon.mark(cliType: cliType, agentType: agentType) {
    case .asset(let name): .asset(name)
    case .terminal: .lody(.terminal)
    case .generic: .lody(.agent)
    }
  }
}

// MARK: - State

/// Drives the SwiftUI context panel and run-config sheet from the UIKit controller.
@MainActor
final class CreatePanelState: ObservableObject {
  @Published var panel = CreatePanel()
  @Published var runConfig: [CreatePicker] = []
  /// Recently used configurations atop the run-config sheet; empty hides the group.
  @Published var recents: [CreateOption] = []
  /// The one expanded list on the page, and separately in the sheet.
  @Published var open: String?
  @Published var openInSheet: String?
  var onPick: (String, String) -> Void = { _, _ in }
  var onWorktree: (Bool) -> Void = { _ in }
  var onRetry: () -> Void = {}
}

// MARK: - Page panel

struct CreateContextPanel: View {
  @ObservedObject var state: CreatePanelState

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: LodySpacing.sm) {
          Spacer(minLength: 0)
          ForEach(state.panel.cards) { picker in
            VStack(spacing: 0) {
              PickerFace(picker: picker, prominent: true) { toggle(picker.id) }
              list(picker)
            }
          }
          if state.panel.worktree != nil || state.panel.branch != nil { branchLine }
          if !state.panel.note.isEmpty {
            if state.panel.noteRetry {
              Button { state.onRetry() } label: {
                note.frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            } else {
              note
            }
          }
        }
        .padding(.horizontal, LodyLayout.screenPaddingX)
        .padding(.bottom, LodySpacing.md)
        .frame(minHeight: geometry.size.height, alignment: .bottom)
        .background {
          Color.clear.contentShape(Rectangle()).onTapGesture { state.open = nil }
        }
      }
      .scrollBounceBehavior(.basedOnSize)
      .defaultScrollAnchor(.bottom)
    }
  }

  private var note: some View {
    Text(state.panel.note)
      .lodyTextStyle(.footnote)
      .foregroundStyle(state.panel.noteWarning ? LodyColor.warningDefault : LodyColor.textTertiary)
      .padding(.horizontal, LodySpacing.xs)
  }

  private var branchLine: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: LodySpacing.md) {
        if let worktree = state.panel.worktree {
          Button { state.onWorktree(!worktree) } label: {
            HStack(spacing: LodySpacing.sm) {
              Image(systemName: worktree ? "checkmark.square.fill" : "square")
                .foregroundStyle(worktree ? LodyColor.accentDefault : LodyColor.iconTertiary)
              Text(String(localized: "create.context.worktree", bundle: .lody))
                .lodyTextStyle(.subhead)
                .foregroundStyle(LodyColor.textSecondary)
            }
            .padding(.horizontal, LodySpacing.xs)
            .frame(minHeight: LodySize.controlMd)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(worktree ? [.isButton, .isSelected] : .isButton)
        }
        if let branch = state.panel.branch {
          PickerFace(picker: branch, prominent: false) { toggle(branch.id) }
        }
        Spacer(minLength: 0)
      }
      if let branch = state.panel.branch { list(branch) }
    }
  }

  private func list(_ picker: CreatePicker) -> some View {
    CreateInlineOptions(picker: picker, expanded: state.open == picker.id) { id in
      if id != CreateSessionContext.loadMoreOption { state.open = nil }
      state.onPick(picker.id, id)
    }
  }

  private func toggle(_ id: String) { state.open = state.open == id ? nil : id }
}

/// Keep the measured list mounted so its height and the trigger's position interpolate in
/// the same layout transaction. Clipping prevents options appearing ahead of that movement.
private struct CreateInlineOptions: View {
  let picker: CreatePicker
  let expanded: Bool
  let onPick: (String) -> Void
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    OptionList(picker: picker, onPick: onPick)
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      .padding(.top, LodySpacing.xs)
      .modifier(CreateOptionsReveal(height: expanded ? contentHeight + LodySpacing.xs : 0))
      .animation(.smooth(duration: 0.22), value: expanded)
      .allowsHitTesting(expanded)
      .accessibilityHidden(!expanded)
  }
}

private struct CreateOptionsReveal: AnimatableModifier {
  nonisolated var height: CGFloat
  nonisolated var animatableData: CGFloat {
    get { height }
    set { height = newValue }
  }

  func body(content: Content) -> some View {
    content.frame(height: max(0, height), alignment: .top)
      .clipped()
      .transaction { $0.animation = nil }
  }
}

/// A picker's closed face: a filled full-width card (computer, project) or a plain line (branch).
private struct PickerFace: View {
  let picker: CreatePicker
  let prominent: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: LodySpacing.md) {
        if picker.loading { ProgressView().controlSize(.small) } else { GlyphView(glyph: picker.glyph, size: LodyIconSize.md) }
        Text(picker.title)
          .lodyTextStyle(.body)
          .foregroundStyle(picker.placeholder ? LodyColor.textTertiary : LodyColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: prominent ? .infinity : nil, alignment: .leading)
        if !picker.options.isEmpty {
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(LodyColor.iconTertiary)
        }
      }
      .padding(.horizontal, LodySpacing.xs)
      .frame(minHeight: prominent ? LodySize.controlLg : LodySize.controlMd)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(picker.options.isEmpty)
    .accessibilityValue(picker.title)
  }
}

/// The expanded options: optional search, then rows with a check on the selected one.
struct OptionList: View {
  let picker: CreatePicker
  var expandsToContent = false
  let onPick: (String) -> Void
  @State private var query = ""

  private var shown: [CreateOption] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !term.isEmpty else { return picker.options }
    return (picker.searchOptions ?? picker.options).filter {
      "\($0.title) \($0.subtitle) \($0.searchText)".lowercased().contains(term)
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if picker.searchable {
        HStack(spacing: LodySpacing.sm) {
          LodyIcon.search.image.resizable().renderingMode(.template)
            .frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
            .foregroundStyle(LodyColor.iconTertiary)
          TextField(picker.searchPlaceholder, text: $query)
            .lodyTextStyle(.body)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        .padding(.horizontal, LodySpacing.xs)
        .frame(minHeight: LodySize.controlMd)
      }
      if expandsToContent {
        VStack(spacing: 0) { optionRows }
      } else {
        ScrollView {
          LazyVStack(spacing: 0) { optionRows }
        }
        .frame(height: min(280, CGFloat(shown.count) * LodySize.listRow))
      }
    }
  }

  private var optionRows: some View {
    ForEach(shown) { option in
      Button { onPick(option.id) } label: { row(option) }
        .buttonStyle(.plain)
        .disabled(option.disabled)
    }
  }

  private func row(_ option: CreateOption) -> some View {
    HStack(spacing: LodySpacing.md) {
      if let glyph = option.glyph { GlyphView(glyph: glyph, size: LodyIconSize.md) }
      VStack(alignment: .leading, spacing: 0) {
        Text(option.title).lodyTextStyle(.body).lineLimit(1)
          .foregroundStyle(option.disabled ? LodyColor.textTertiary : LodyColor.textPrimary)
        if !option.subtitle.isEmpty {
          Text(option.subtitle).lodyTextStyle(.footnote).lineLimit(1).truncationMode(.middle)
            .foregroundStyle(LodyColor.textTertiary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if option.selected {
        LodyIcon.check.image.resizable().renderingMode(.template)
          .frame(width: LodyIconSize.sm, height: LodyIconSize.sm)
          .foregroundStyle(LodyColor.accentFg)
      }
    }
    .padding(.horizontal, LodySpacing.xs)
    .frame(minHeight: LodySize.listRow)
    .contentShape(Rectangle())
    .accessibilityAddTraits(option.selected ? [.isButton, .isSelected] : .isButton)
  }
}

struct GlyphView: View {
  let glyph: CreateGlyph
  let size: CGFloat

  var body: some View {
    switch glyph {
    case .repository(let name):
      RepositoryIcon(repository: name, size: size, opacity: 0.8)
    case .lody(let icon):
      icon.image.resizable().renderingMode(.template).frame(width: size, height: size).foregroundStyle(LodyColor.iconSecondary)
    case .asset(let name):
      Image(name, bundle: .main).resizable().scaledToFit().frame(width: size, height: size)
    case .symbol(let name):
      Image(systemName: name).font(.system(size: size * 0.8)).frame(width: size, height: size).foregroundStyle(LodyColor.iconSecondary)
    case .emoji(let glyph):
      Text(glyph).font(.system(size: size * 0.85)).frame(width: size, height: size).accessibilityHidden(true)
    }
  }
}

// MARK: - Run configuration sheet

/// Web's `MobileRunConfigSheet`: labelled rows whose value expands its options in place.
struct CreateRunConfigSheet: View {
  @ObservedObject var state: CreatePanelState
  var onHeightChange: (CGFloat) -> Void = { _ in }

  var body: some View {
    ScrollView {
      VStack(spacing: LodySpacing.md) {
        Text(String(localized: "create.runConfig.title", bundle: .lody))
          .lodyTextStyle(.headline)
          .foregroundStyle(LodyColor.textPrimary)
          .padding(.top, LodySpacing.xl)
        VStack(spacing: LodySpacing.sm) {
          if !state.recents.isEmpty { recentGroup }
          ForEach(state.runConfig) { row in
            VStack(spacing: LodySpacing.xs) {
              rowFace(row)
              if state.openInSheet == row.id {
                OptionList(picker: row, expandsToContent: true) { id in
                  state.openInSheet = nil
                  state.onPick(row.id, id)
                }
                .transition(.blurReplace)
              }
            }
          }
        }
        .padding(.horizontal, LodyLayout.screenPaddingX)
        .padding(.bottom, LodySpacing.lg)
        .animation(.smooth(duration: 0.3), value: state.openInSheet)
      }
      .onGeometryChange(for: CGFloat.self) { geometry in
        geometry.size.height
      } action: { height in
        onHeightChange(height)
      }
    }
    .background(LodyColor.bgBase)
  }

  /// Terminal "run it like this" rows: a pick applies the whole configuration and closes nothing
  /// else open, like web's group above Agent / Model / Reasoning.
  private var recentGroup: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(String(localized: "create.runConfig.recent", bundle: .lody))
        .lodyTextStyle(.footnote)
        .foregroundStyle(LodyColor.textTertiary)
        .padding(.bottom, LodySpacing.xs)
      OptionList(
        picker: CreatePicker(id: CreateSessionContext.recentRow, glyph: .symbol("clock"), title: "", options: state.recents),
        expandsToContent: true
      ) { id in
        state.openInSheet = nil
        state.onPick(CreateSessionContext.recentRow, id)
      }
      Divider().padding(.top, LodySpacing.xs)
    }
    .accessibilityIdentifier("run-config-recent")
  }

  @ViewBuilder
  private func rowFace(_ row: CreatePicker) -> some View {
    if let on = row.toggle {
      Toggle(isOn: Binding(get: { on }, set: { state.onPick(row.id, $0 ? CreateSessionContext.toggleOn : CreateSessionContext.toggleOff) })) {
        Text(CreateSessionContext.runConfigLabel(row.id))
          .lodyTextStyle(.subhead)
          .foregroundStyle(LodyColor.textSecondary)
      }
      .tint(LodyColor.accentDefault)
      .frame(minHeight: LodySize.controlMd)
      .padding(.vertical, LodySpacing.xs)
      .accessibilityIdentifier("run-config-" + row.id)
    } else {
      listFace(row)
    }
  }

  private func listFace(_ row: CreatePicker) -> some View {
    HStack(spacing: LodySpacing.md) {
      Text(CreateSessionContext.runConfigLabel(row.id))
        .lodyTextStyle(.subhead)
        .foregroundStyle(LodyColor.textSecondary)
        .frame(width: 96, alignment: .leading)
      Button { state.openInSheet = state.openInSheet == row.id ? nil : row.id } label: {
        HStack(spacing: LodySpacing.sm) {
          if row.id == "agent" || row.id == "permission" || (row.id == "role" && !row.placeholder) {
            GlyphView(glyph: row.glyph, size: LodyIconSize.sm)
          }
          Text(row.title).lodyTextStyle(.body).lineLimit(1)
            .foregroundStyle(row.placeholder ? LodyColor.textTertiary : LodyColor.textPrimary)
          Spacer(minLength: 0)
        }
        .frame(minHeight: LodySize.controlMd)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(row.options.isEmpty)
      .accessibilityLabel(CreateSessionContext.runConfigLabel(row.id))
      .accessibilityValue(row.title)
    }
    .padding(.vertical, LodySpacing.xs)
  }
}
