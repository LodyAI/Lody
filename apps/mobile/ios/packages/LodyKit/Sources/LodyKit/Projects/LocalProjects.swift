import LodyCore
import Foundation

typealias HistoryTarget = RuntimeContract.HistoryTarget
typealias HistoryRequest = RuntimeContract.HistoryRequest
typealias HistoryResult = RuntimeContract.LocalProjectsResultHistory
typealias DirectoryListing = RuntimeContract.LocalProjectsResultDirectory
typealias DirectoryMachine = RuntimeContract.LocalProjectsResultMachinesMachinesItem

struct LocalProjectsRequest: Encodable {
  var workspaceId: String
  var browserId: String
  var action: String
  var machineId: String?
  var path: String?
  var cursor: String?
  var history: HistoryRequest?
}

enum HistoryResponse: Sendable {
  case targets([HistoryTarget])
  case result(HistoryResult)
}

@MainActor
enum LocalProjects {
  static func call<Value: Decodable>(_ request: LocalProjectsRequest, as value: Value.Type) async throws -> Value {
    try await DataRuntime.settingsCall(
      RuntimeContract.Calls.LocalProjects.self, request, as: value, timeout: request.action == "history" ? nil : 45
    ) { result -> any Encodable in
      switch result {
      case .cancelled(let value): return value
      case .machines(let value): return value
      case .targets(let value): return value.targets
      case .history(let value): return value
      case .directory(let value): return value
      case .project(let value): return value.project
      }
    }
  }

  static func history(workspaceId: String, browserId: String, _ request: HistoryRequest) async throws -> HistoryResponse {
    let body = LocalProjectsRequest(workspaceId: workspaceId, browserId: browserId, action: "history", history: request)
    if case .targets = request { return .targets(try await call(body, as: [HistoryTarget].self)) }
    return .result(try await call(body, as: HistoryResult.self))
  }

  static func cancel(workspaceId: String, browserId: String) {
    Task {
      _ = try? await call(
        LocalProjectsRequest(workspaceId: workspaceId, browserId: browserId, action: "cancel"),
        as: RuntimeContract.LocalProjectsResultCancelled.self
      )
    }
  }

  static func browserId(_ prefix: String) -> String { "\(prefix)-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)" }
}
