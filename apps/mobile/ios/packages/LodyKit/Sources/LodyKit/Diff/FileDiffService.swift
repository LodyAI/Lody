import LodyCore
import UIKit

struct FileDiffRequest: Equatable {
  var sessionId: String
  var entryId: String?
  var path: String
}

@MainActor
struct FileDiffService {
  var diff: @MainActor (FileDiffRequest) async throws -> RuntimeContract.DiffResult
  var changes: @MainActor (_ sessionId: String) async throws -> RuntimeContract.WorkspaceChanges
  var preview: @MainActor (_ sessionId: String, _ path: String, _ from: UIViewController) async throws -> Void
  var readStyle: @MainActor () async -> DiffDocumentStyle?
  var writeStyle: @MainActor (DiffDocumentStyle) -> Void

  nonisolated private static let styleKey = "diffStyle"

  static let live = FileDiffService(
    diff: { request in
      let runtime = try runtime(request.sessionId)
      if let entryId = request.entryId {
        return try await runtime.perform(
          RuntimeContract.Calls.TurnDiff.self, .init(sessionId: request.sessionId, entryId: entryId, path: request.path)
        )
      }
      return try await runtime.perform(RuntimeContract.Calls.FileDiff.self, .init(sessionId: request.sessionId, path: request.path))
    },
    changes: { sessionId in
      try await runtime(sessionId).perform(RuntimeContract.Calls.WorkspaceChanges.self, .init(sessionId: sessionId))
    },
    preview: { sessionId, path, controller in
      let json = try await FilePreview.read(sessionId: sessionId, path: path, runtime: try runtime(sessionId))
      let file = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] ?? [:]
      guard file["status"] as? String == "ok", let handle = file["handle"] as? String else {
        throw FilePreviewFailure(message: file["message"] as? String ?? String(localized: "diff.toast.previewFailed", bundle: .lody))
      }
      try ContentPreview.present(handle: handle, from: controller)
    },
    readStyle: {
      await withCheckedContinuation { continuation in
        LocalStore.queue.async {
          let value = (try? LocalStore.shared.read(styleKey)) ?? nil
          continuation.resume(returning: value.flatMap(DiffDocumentStyle.init(rawValue:)))
        }
      }
    },
    writeStyle: { style in
      let generation = LocalStore.shared.generation
      LocalStore.queue.async { try? LocalStore.shared.write(styleKey, style.rawValue, generation: generation) }
    }
  )

  private static func runtime(_ sessionId: String) throws -> DataRuntime {
    guard let runtime = DataRuntime.current, runtime.sessionId == sessionId else {
      throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    return runtime
  }
}

enum FilePathText {
  static func basename(_ path: String) -> String { parts(path).last ?? path }
  static func dirname(_ path: String) -> String { parts(path).dropLast().joined(separator: "/") }
  private static func parts(_ path: String) -> [String] {
    path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
  }
}
