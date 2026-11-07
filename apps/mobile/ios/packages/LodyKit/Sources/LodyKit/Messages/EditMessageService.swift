import Foundation
import LodyCore

struct EditMessageScope: Encodable {
  let sessionId: String
  let expectedUserTurnId: String
  var action = "read"
  var id: String?
}

struct EditMessageDraft: Decodable {
  struct Attachment: Codable {
    let id: String
    let name: String
    let uri: String
    let kind: String
  }
  let state: String
  let text: String
  let attachments: [Attachment]
}

struct EditMessageSubmission: Codable {
  let id: String
  let text: String
  let attachments: [EditMessageDraft.Attachment]

  func payload(scope: EditMessageScope, originals: Set<String>) throws -> String {
    struct Request: Encodable {
      let action = "send"
      let sessionId: String
      let expectedUserTurnId: String
      let id: String
      let text: String
      let retainedIds: [String]
      let attachments: [EditMessageDraft.Attachment]
    }
    return String(decoding: try JSONEncoder().encode(Request(
      sessionId: scope.sessionId, expectedUserTurnId: scope.expectedUserTurnId, id: id, text: text,
      retainedIds: attachments.filter { originals.contains($0.id) }.map(\.id),
      attachments: attachments.filter { !originals.contains($0.id) }
    )), as: UTF8.self)
  }
}

@MainActor
struct EditMessageService {
  var prepare: @MainActor (EditMessageScope) async throws -> EditMessageDraft
  var send: @MainActor (EditMessageScope, EditMessageSubmission, Set<String>) async throws -> RuntimeContract.EditSessionResult
  var read: @MainActor (EditMessageScope) async throws -> RuntimeContract.EditSessionResult

  static let live = Self(
    prepare: { scope in
      let runtime = try Self.runtime(scope)
      let payload = String(decoding: try JSONEncoder().encode(scope), as: UTF8.self)
      let json: String = try await withCheckedThrowingContinuation {
        runtime.prepareSessionEdit(payload, sink: .continuation($0))
      }
      let draft = try JSONDecoder().decode(EditMessageDraft.self, from: Data(json.utf8))
      guard draft.state == "ready" else { throw CocoaError(.coderReadCorrupt) }
      return draft
    },
    send: { scope, submission, originals in
      let runtime = try Self.runtime(scope)
      let payload = try submission.payload(scope: scope, originals: originals)
      let json: String = try await withCheckedThrowingContinuation {
        runtime.sendTurn(payload, sink: .continuation($0), edit: true)
      }
      return try JSONDecoder().decode(RuntimeContract.EditSessionResult.self, from: Data(json.utf8))
    },
    read: { scope in
      let runtime = try Self.runtime(scope)
      let payload = String(decoding: try JSONEncoder().encode(scope), as: UTF8.self)
      let json: String = try await withCheckedThrowingContinuation {
        runtime.dispatchTurn(payload, sink: .continuation($0), billing: nil, edit: true)
      }
      return try JSONDecoder().decode(RuntimeContract.EditSessionResult.self, from: Data(json.utf8))
    }
  )

  private static func runtime(_ scope: EditMessageScope) throws -> DataRuntime {
    guard let runtime = DataRuntime.current, runtime.sessionId == scope.sessionId else { throw OutboxError.scopeExpired }
    return runtime
  }
}
