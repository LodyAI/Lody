import Foundation
import LodyCore
import UIKit

/// Scripted schedules for the offline Home fixture (`--ui-verify-home`): every row state the list
/// words, an unsupported rule, a teammate's schedule, an outdated computer and a scheduled message.
/// Commands mutate the in-memory list so UI checks observe pause, resume, run, create and delete.
@MainActor
final class ScheduleFixture {
  static let shared = ScheduleFixture()

  private let hour: Double = 3_600_000
  private lazy var now = LodyRelativeTime.now()
  private lazy var items: [ScheduleItem] = seed()
  private var prompts: [String: String] = [:]
  private var drafts: [String: RuntimeContract.ScheduleDraft] = [:]
  private(set) var runs: [String] = []

  // Explicit UI-verification gates: no timers, and no production cache logic in the fixture.
  private var held: Set<String> = []
  private var pending: [String: [CheckedContinuation<Void, Error>]] = [:]
  private var signals: [String: UIView] = [:]

  func control(_ action: String) {
    guard LodyUIVerify.enabled, NativeHomeFixture.active else { return }
    let parts = action.split(separator: "-", maxSplits: 1).map(String.init)
    guard parts.count == 2, ["list", "detail", "options", "command"].contains(parts[1]) else { return }
    let key = parts[1]
    if parts[0] == "hold" {
      held.insert(key)
      signal(key, "armed")
    } else if parts[0] == "fail" || parts[0] == "release" {
      held.remove(key)
      let requests = pending.removeValue(forKey: key) ?? []
      for request in requests {
        if parts[0] == "fail" { request.resume(throwing: Self.failure("schedule_conflict")) }
        else { request.resume() }
      }
      signal(key, parts[0] == "fail" ? "failed" : "released")
    }
  }

  private func signal(_ key: String, _ state: String) {
    let view = signals[key] ?? UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    view.isAccessibilityElement = true
    view.accessibilityIdentifier = "schedule-fixture-" + key
    view.accessibilityLabel = "Schedule fixture " + key
    view.accessibilityValue = state
    if view.superview == nil { LodyShell.shared.presenter?.view.window?.addSubview(view) }
    signals[key] = view
  }

  private func gate(_ key: String) async throws {
    guard held.contains(key) else { return }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      pending[key, default: []].append(continuation)
      signal(key, "pending")
    }
  }

  var service: ScheduleService {
    ScheduleService(
      list: { [unowned self] _ in
        try await self.gate("list")
        return RuntimeContract.SchedulesResult(items: self.items, deviceTimeZone: "UTC", machineTimeZones: ["ui": "Asia/Shanghai", "mini": "UTC"],
          ownedMachineIds: ["mini", "ui"])
      },
      detail: { [unowned self] _, scheduleId in
        try await self.gate("detail")
        guard let item = self.items.first(where: { $0.scheduleId == scheduleId }) else { throw Self.failure("schedule_not_found") }
        let draft = self.drafts[scheduleId]
        return RuntimeContract.ScheduleDetail(
          item: item, prompt: self.prompts[scheduleId] ?? "Summarise yesterday's commits and flag anything risky.",
          modelId: draft?.modelId, modeId: draft?.modeId, project: draft?.project
        )
      },
      command: { [unowned self] params in
        try await self.gate("command")
        return try self.apply(params)
      },
      options: { [unowned self] _ in
        try await self.gate("options")
        return Self.options
      }
    )
  }

  private func apply(_ params: RuntimeContract.ScheduleCommandParams) throws -> RuntimeContract.ScheduleCommandResult {
    let id = params.scheduleId
    if params.action == .create || params.action == .edit {
      guard let draft = params.draft else { throw Self.failure("schedule_invalid") }
      guard draft.machineId != "mini" else { throw Self.failure("schedule_machine_unsupported") }
      let agent = Self.options.agents.first { $0.id == draft.agentConfigId && $0.machineId == draft.machineId }
      var item = items.first { $0.scheduleId == id } ?? ScheduleItem(
        scheduleId: id, title: "", ownerId: "ui", isOwner: true, machineId: draft.machineId, machineSupported: true,
        agentConfigId: draft.agentConfigId, enabled: true, scheduledMessage: false, rule: draft.rule,
        destination: .newSession, state: .init(group: .running, kind: .notScheduled), createdAt: now, updatedAt: now
      )
      item.title = draft.title
      item.machineId = draft.machineId
      item.machineName = agent?.machineName
      item.agentConfigId = draft.agentConfigId
      item.agentName = agent?.name
      item.rule = draft.rule
      if item.destination != .existingSession { item.destination = draft.destination == .ownSession ? .ownSession : .newSession }
      item.state = Self.state(for: draft.rule, enabled: item.enabled, now: now)
      item.updatedAt = now + 1
      prompts[id] = draft.prompt
      drafts[id] = draft
      items.removeAll { $0.scheduleId == id }
      items.insert(item, at: 0)
      return .init(scheduleId: id)
    }
    guard let index = items.firstIndex(where: { $0.scheduleId == id }) else { throw Self.failure("schedule_not_found") }
    switch params.action {
    case .pause:
      items[index].enabled = false
      items[index].state = .init(group: .paused, kind: .paused)
    case .resume:
      guard items[index].machineSupported else { throw Self.failure("schedule_machine_unsupported") }
      items[index].enabled = true
      items[index].state = Self.state(for: items[index].rule, enabled: true, now: now)
    case .run:
      guard items[index].machineSupported else { throw Self.failure("schedule_machine_unsupported") }
      runs.append(id)
    case .delete:
      items.remove(at: index)
    case .create, .edit:
      break
    }
    return .init(scheduleId: id)
  }

  private static func state(for rule: ScheduleRule, enabled: Bool, now: Double) -> RuntimeContract.ScheduleState {
    if !enabled { return .init(group: .paused, kind: .paused) }
    if rule.kind == .manual { return .init(group: .running, kind: .manual) }
    return .init(group: .running, kind: .runsAt, at: now + 2 * 3_600_000)
  }

  private static func failure(_ code: String) -> NSError { DataRuntime.failure("command_failed", code) }

  private func seed() -> [ScheduleItem] {
    func item(
      _ id: String, _ title: String, rule: ScheduleRule, state: RuntimeContract.ScheduleState, machine: String = "ui",
      owner: Bool = true, supported: Bool = true, enabled: Bool = true, message: Bool = false, last: String? = nil
    ) -> ScheduleItem {
      ScheduleItem(
        scheduleId: id, title: title, ownerId: owner ? "ui" : "teammate", isOwner: owner, machineId: machine,
        machineName: machine == "ui" ? "Fixture Mac" : "Mac mini", machineSupported: supported, agentConfigId: "fixture-agent",
        agentName: "Fixture Agent", agentType: "claude", enabled: enabled, scheduledMessage: message, rule: rule,
        destination: message ? .existingSession : .newSession, destinationSessionId: message ? "ui-design" : nil,
        state: state, lastRunAt: last == nil ? nil : now - hour, lastSessionId: last, createdAt: now - 48 * hour, updatedAt: now - hour
      )
    }
    return [
      item("daily-review", "Daily review", rule: .init(kind: .weekdays, hour: 9, minute: 0, timeZone: "Asia/Shanghai"),
        state: .init(group: .running, kind: .runsAt, at: now + 3 * hour), last: "ui-design"),
      item("weekly-digest", "Weekly digest", rule: .init(kind: .weekly, hour: 17, minute: 30, weekdays: [1, 5], timeZone: "Asia/Shanghai"),
        state: .init(group: .paused, kind: .paused), enabled: false),
      item("release-check", "Release check", rule: .init(kind: .manual), state: .init(group: .running, kind: .manual, at: now - hour), last: "ui-design"),
      item("nightly-build", "Nightly build", rule: .init(kind: .daily, hour: 2, minute: 0, timeZone: "Asia/Shanghai"),
        state: .init(group: .attention, kind: .blocked, blockedCode: "CAPACITY_EXHAUSTED")),
      item("launch-once", "Launch announcement", rule: .init(kind: .once, at: now - 24 * hour),
        state: .init(group: .ended, kind: .done, at: now - 24 * hour)),
      item("legacy-cron", "Legacy cron", rule: .init(kind: .unsupported, summary: "*/7 9-17 * * 1-5 (Asia/Shanghai)"),
        state: .init(group: .running, kind: .runsAt, at: now + hour)),
      item("team-sync", "Team sync notes", rule: .init(kind: .hours, every: 4, timeZone: "UTC"),
        state: .init(group: .running, kind: .runsAt, at: now + hour), owner: false),
      item("old-mini", "Old computer cleanup", rule: .init(kind: .monthly, hour: 8, minute: 0, days: [1, 15], timeZone: "UTC"),
        state: .init(group: .running, kind: .runsAt, at: now + 30 * hour), machine: "mini", supported: false),
      item("follow-up", "Ping the reviewers again", rule: .init(kind: .once, at: now + 5 * hour),
        state: .init(group: .running, kind: .sendsAt, at: now + 5 * hour), message: true),
    ]
  }

  static let options = CreationOptions(
    availability: "live", sessionId: "schedule-fixture",
    agents: [
      CreationAgent(id: "fixture-agent", name: "Fixture Agent", machineId: "ui", machineName: "Fixture Mac", cliType: "acp", agentType: "claude"),
      CreationAgent(id: "fixture-codex", name: "Fixture Codex", machineId: "ui", machineName: "Fixture Mac", cliType: "acp", agentType: "codex"),
      CreationAgent(id: "fixture-agent", name: "Fixture Agent", machineId: "mini", machineName: "Mac mini", cliType: "acp", agentType: "claude"),
    ],
    capabilities: [
      Capability(machineId: "ui", agentConfigId: "fixture-agent", cliType: "acp", agentType: "claude",
        models: [CapabilityChoice(id: "opus", name: "Opus"), CapabilityChoice(id: "sonnet", name: "Sonnet")],
        modes: [CapabilityChoice(id: "default", name: "Default"), CapabilityChoice(id: "plan", name: "Plan")]),
      Capability(machineId: "ui", agentConfigId: "fixture-codex", cliType: "acp", agentType: "codex",
        models: [CapabilityChoice(id: "gpt", name: "GPT")], modes: []),
    ]
  )
}
