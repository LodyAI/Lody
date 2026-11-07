import LodyCore
import Foundation

enum ProjectHistoryMode {
  case projects
  case agents(HistoryTarget)
  case sessions(HistoryTarget)
}

enum ProjectHistoryOperation: String {
  case load, `import`, resolve
}

struct ProjectHistoryState {
  var mode: ProjectHistoryMode
  var busy = true
  var operation = ProjectHistoryOperation.load
  var targets: [HistoryTarget] = []
  var result: HistoryResult?
  var selected: [String] = []
  var error = ""
  var notice = ""

  var target: HistoryTarget? {
    if case .sessions(let target) = mode { return target }
    return nil
  }

  var available: [String] {
    (result?.sessions ?? []).filter { $0.status != .imported && $0.status != .syncConflict }.map(\.acpSessionId)
  }

  var allSelected: Bool { !available.isEmpty && available.allSatisfy(selected.contains) }
}

enum ProjectHistorySections {
  static func projectId(_ target: HistoryTarget) -> String { "history-project:\(json([target.machineId, target.localProjectId]))" }

  static func targetId(_ target: HistoryTarget) -> String {
    "history-target:\(json([target.machineId, target.localProjectId, target.provider.cliType.rawValue, target.provider.agentType]))"
  }

  static func sessionId(_ acpSessionId: String) -> String { "history-session:\(acpSessionId)" }

  static func make(_ state: ProjectHistoryState, now: Double = LodyRelativeTime.now()) -> [LodyListSection] {
    switch state.mode {
    case .sessions(let target): sessions(state, target, now: now)
    case .agents(let project): help(state, project: true) + [agents(state, project)] + empty(state)
    case .projects: help(state, project: false) + projects(state) + empty(state)
    }
  }

  private static func busyText(_ state: ProjectHistoryState) -> String {
    switch state.operation {
    case .load: text(state.target == nil ? "loadingProjects" : "loadingSessions")
    case .import: text("importing")
    case .resolve: text("replacing")
    }
  }

  private static func sessions(_ state: ProjectHistoryState, _ target: HistoryTarget, now: Double) -> [LodyListSection] {
    let info = [target.machineName, target.rootPath, state.busy ? busyText(state) : state.notice, state.error]
      .filter { !$0.isEmpty }.joined(separator: "\n")
    var footer = ""
    if !state.busy, state.error.isEmpty, let result = state.result {
      footer = text(result.sessions.isEmpty ? "emptySessions" : "importHint")
    }
    let rows = (state.result?.sessions ?? []).map { session in
      let chosen = state.selected.contains(session.acpSessionId)
      var value = chosen ? text("selected") : ""
      if session.status == .imported { value = text("imported") }
      if session.status == .syncConflict { value = text("conflict") }
      var item = LodyListRow.item(
        sessionId(session.acpSessionId), session.title.isEmpty ? text("untitled") : session.title,
        subtitle: session.updatedAt.flatMap { updated in timestamp(updated).map { LodyRelativeTime.text($0, now: now) } } ?? "",
        value: value, image: chosen ? "checkmark.circle.fill" : "bubble.left.and.bubble.right",
        action: !state.busy && session.status != .imported
      )
      item.imageTint = "blue"
      return item
    }
    return [
      .group("history-info", header: target.projectName, footer: info, []),
      .group("history-sessions", footer: footer, rows),
    ]
  }

  private static func help(_ state: ProjectHistoryState, project: Bool) -> [LodyListSection] {
    guard !project || state.busy || !state.error.isEmpty else { return [] }
    var footer = state.error
    if footer.isEmpty { footer = state.busy ? busyText(state) : text("hint") }
    return [.group("history-help", footer: footer, [])]
  }

  private static func agents(_ state: ProjectHistoryState, _ project: HistoryTarget) -> LodyListSection {
    let rows = state.targets
      .filter { $0.machineId == project.machineId && $0.localProjectId == project.localProjectId }
      .map { target in
        var item = LodyListRow.item(
          targetId(target), RemoteSettingsSections.agentName(target.provider.agentType),
          subtitle: text("provider.\(target.provider.cliType.rawValue)"), image: "bubble.left.and.bubble.right",
          imageAsset: RemoteSettingsSections.agentIcon(target.provider.agentType), action: !state.busy,
          disclosure: true, navigates: true
        )
        item.imageTint = "blue"
        return item
      }
    return .group("history-agents", header: text("chooseAgent"), footer: "\(project.machineName)\n\(project.rootPath)", rows)
  }

  private static func projects(_ state: ProjectHistoryState) -> [LodyListSection] {
    var machines: [String] = []
    var groups: [String: [String: [HistoryTarget]]] = [:]
    var order: [String: [String]] = [:]
    for target in state.targets {
      if groups[target.machineId] == nil {
        machines.append(target.machineId)
        groups[target.machineId] = [:]
      }
      if groups[target.machineId]?[target.localProjectId] == nil { order[target.machineId, default: []].append(target.localProjectId) }
      groups[target.machineId]?[target.localProjectId, default: []].append(target)
    }
    return machines.map { machineId in
      let projects = (order[machineId] ?? []).compactMap { groups[machineId]?[$0] }
        .sorted { $0[0].projectName.localizedCompare($1[0].projectName) == .orderedAscending }
      let rows = projects.map { agents in
        let target = agents[0]
        var item = LodyListRow.item(
          projectId(target), target.projectName, subtitle: target.rootPath,
          value: String.localizedStringWithFormat(String(localized: "settings.history.agentCount", bundle: .lody), agents.count),
          image: "folder", action: !state.busy, disclosure: true, navigates: true
        )
        item.imageTint = "blue"
        return item
      }
      return .group(machineId, header: projects.first?.first?.machineName ?? "", rows)
    }
  }

  private static func empty(_ state: ProjectHistoryState) -> [LodyListSection] {
    guard !state.busy, state.error.isEmpty, state.targets.isEmpty else { return [] }
    return [.group("history-empty", footer: text("emptyTargets"), [])]
  }

  private static func timestamp(_ value: String) -> Double? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date.timeIntervalSince1970 * 1000 }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value).map { $0.timeIntervalSince1970 * 1000 }
  }

  private static func json(_ values: [String]) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    return (try? encoder.encode(values)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }

  static func text(_ key: String) -> String { String(localized: String.LocalizationValue("settings.history." + key), bundle: .lody) }
}
