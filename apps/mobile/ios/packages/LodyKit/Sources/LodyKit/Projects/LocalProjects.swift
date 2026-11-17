import LodyCore
import Foundation

typealias DirectoryListing = RuntimeContract.LocalProjectsResultDirectory
typealias DirectoryMachine = RuntimeContract.LocalProjectsResultMachinesMachinesItem

struct LocalProjectsRequest: Encodable {
  var workspaceId: String
  var browserId: String
  var action: String
  var machineId: String?
  var path: String?
  var cursor: String?
}

@MainActor
enum LocalProjects {
  static func call<Value: Decodable>(_ request: LocalProjectsRequest, as value: Value.Type) async throws -> Value {
    try await DataRuntime.settingsCall(
      RuntimeContract.Calls.LocalProjects.self, request, as: value, timeout: 45
    ) { result -> any Encodable in
      switch result {
      case .cancelled(let value): return value
      case .machines(let value): return value
      case .directory(let value): return value
      case .project(let value): return value.project
      }
    }
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
