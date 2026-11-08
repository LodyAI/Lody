import Foundation
import LodyCore

typealias ScheduleItem = RuntimeContract.ScheduleItem
typealias ScheduleRule = RuntimeContract.ScheduleRule
typealias ScheduleAction = RuntimeContract.ScheduleCommandParamsAction

/// Schedule I/O through the runtime's `schedules` / `scheduleDetail` / `scheduleCommand` calls, plus
/// the creation options the editor picks computers, agents, models and modes from. Injected so the
/// offline Home fixture scripts every outcome.
@MainActor
struct ScheduleService {
  var list: (_ workspaceId: String) async throws -> RuntimeContract.SchedulesResult
  var detail: (_ workspaceId: String, _ scheduleId: String) async throws -> RuntimeContract.ScheduleDetail
  var command: (_ params: RuntimeContract.ScheduleCommandParams) async throws -> RuntimeContract.ScheduleCommandResult
  var options: (_ workspaceId: String) async throws -> CreationOptions

  /// The offline Home fixture scripts schedules; everything else reads the live runtime.
  static var live: ScheduleService { NativeHomeFixture.active ? ScheduleFixture.shared.service : cloud }

  static var cloud: ScheduleService {
    ScheduleService(
      list: { workspaceId in
        try await ScheduleService.runtime(workspaceId).workspaceCall(RuntimeContract.Calls.Schedules.self) { workspace, _ in
          RuntimeContract.SchedulesParams(workspaceId: workspace)
        }
      },
      detail: { workspaceId, scheduleId in
        try await ScheduleService.runtime(workspaceId).workspaceCall(RuntimeContract.Calls.ScheduleDetail.self) { workspace, _ in
          RuntimeContract.ScheduleDetailParams(workspaceId: workspace, scheduleId: scheduleId)
        }
      },
      command: { params in
        try await ScheduleService.runtime(params.workspaceId).workspaceCall(RuntimeContract.Calls.ScheduleCommand.self) { workspace, _ in
          var scoped = params
          scoped.workspaceId = workspace
          return scoped
        }
      },
      options: { workspaceId in try await CreateSessionService.live.options(workspaceId, nil) }
    )
  }

  private static func runtime(_ workspaceId: String) throws -> DataRuntime {
    guard let runtime = DataRuntime.current, runtime.workspace == workspaceId else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return runtime
  }

  /// A fresh idempotency key for one user intent (`[A-Za-z0-9_-]`, at most 50 characters).
  static func requestId() -> String { UUID().uuidString.lowercased() }
}

/// Runtime schedule failures in words. The runtime throws its codes as the error message, which
/// `DataRuntime.perform` reports as `command_failed: <code>`.
enum ScheduleFailure {
  static let codes: Set<String> = [
    "schedule_not_found", "schedule_not_owner", "schedule_machine_unsupported", "schedule_prompt_invalid",
    "schedule_trigger_invalid", "schedule_title_invalid", "schedule_message_read_only", "schedule_deleted",
    "schedule_conflict", "schedule_invalid", "schedule_write_unknown", "metadata_not_ready", "workspace_changed",
  ]

  static func code(_ error: Error, write: Bool) -> String? {
    let text = (error as NSError).localizedDescription
    let parts = text.components(separatedBy: ": ")
    if let tail = parts.last, codes.contains(tail) { return tail }
    // A write whose reply never came back may or may not have applied.
    if write, let head = parts.first, ["send_timeout", "runtime_replaced"].contains(head) { return "schedule_write_unknown" }
    return nil
  }

  /// `true` when the write may have applied: the user must check before retrying.
  static func unknown(_ error: Error) -> Bool { code(error, write: true) == "schedule_write_unknown" }

  static func message(_ error: Error, write: Bool) -> String {
    guard let code = code(error, write: write) else {
      return String(localized: String.LocalizationValue(write ? "schedules.saveError" : "schedules.loadError"), bundle: .lody)
    }
    return String(localized: String.LocalizationValue("schedules.error." + code), bundle: .lody)
  }
}
