import Foundation

struct SessionPermission: Equatable, Sendable {
  struct Option: Decodable, Equatable, Sendable {
    let optionId: String
    let name: String
    let kind: String?
  }

  struct Question: Decodable, Equatable, Sendable {
    struct Option: Decodable, Equatable, Sendable {
      let label: String
      let description: String?
      let preview: String?
    }
    let id: String?
    let header: String
    let question: String
    let options: [Option]
    let multiSelect: Bool
    let allowCustomAnswer: Bool?
    let isSecret: Bool?
  }

  struct Questions: Decodable, Equatable, Sendable {
    let questions: [Question]
    let allowCustomAnswer: Bool

    func key(at index: Int) -> String {
      let question = questions[index]
      let candidates: [(String?, [String?])] = [
        (question.id, questions.map(\.id)),
        (question.question, questions.map(\.question)),
        (question.header, questions.map(\.header)),
      ]
      for (candidate, values) in candidates {
        if let value = candidate, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           values.filter({ $0 == value }).count == 1 { return value }
      }
      return String(index)
    }

    func allowsText(at index: Int) -> Bool {
      let question = questions[index]
      return question.options.isEmpty || (question.allowCustomAnswer ?? allowCustomAnswer)
    }
  }

  let entryId: String
  let itemId: String
  let requestId: String
  let kind: String
  let title: String
  let path: String?
  let options: [Option]?
  let questionMeta: Questions?
  /// A plan approval whose plan the transcript shows (a carried plan or the turn's own
  /// `proposed_plan`). Web answers it below the plan, so it is not presented over it.
  var showsPlan = false

  /// The request itself; `showsPlan` only decides how it is first offered.
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.entryId == rhs.entryId && lhs.itemId == rhs.itemId && lhs.requestId == rhs.requestId && lhs.kind == rhs.kind
      && lhs.title == rhs.title && lhs.path == rhs.path && lhs.options == rhs.options && lhs.questionMeta == rhs.questionMeta
  }

  // Decode only pending tool requests. Other transcript items keep their own schemas.
  static func first(in entries: [[String: Any]]) throws -> Self? {
    for entry in entries {
      for item in entry["items"] as? [[String: Any]] ?? [] {
        guard item["type"] as? String == "tool_call",
              let permission = item["permission"] as? [String: Any], permission["pending"] as? Bool == true else { continue }
        var result = try target(entryId: entry["id"] as? String, item: item, permission: permission)
        if result.kind == "switch_mode" {
          func hasText(_ value: Any?) -> Bool {
            !((value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          }
          result.showsPlan = hasText(item["plan"]) || (entry["items"] as? [[String: Any]] ?? []).contains {
            $0["type"] as? String == "proposed_plan" && ["delta", "completed"].contains($0["status"] as? String ?? "") && hasText($0["markdown"])
          }
        }
        return result
      }
    }
    return nil
  }

  static func target(entryId: String?, item: [String: Any], permission: [String: Any]) throws -> Self {
    guard let entryId, let itemId = item["itemId"] as? String,
          let requestId = permission["requestId"] as? String, !requestId.isEmpty,
          let kind = item["kind"] as? String, let title = item["title"] as? String else {
      throw CocoaError(.coderReadCorrupt)
    }
    func decode<T: Decodable>(_ type: T.Type, _ key: String) throws -> T? {
      guard let value = permission[key] else { return nil }
      return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    let questions = try decode(Questions.self, "questionMeta")
    if let questions, questions.questions.isEmpty { throw CocoaError(.coderReadCorrupt) }
    return Self(
      entryId: entryId, itemId: itemId, requestId: requestId,
      kind: permission["kind"] as? String == "ask_user_question" ? "ask_user_question" : kind,
      title: title, path: item["path"] as? String, options: try decode([Option].self, "options"), questionMeta: questions
    )
  }
}

// Owned by one session controller, so leaving the session naturally releases the gate.
struct SessionPermissionGate {
  private(set) var open = false
  private(set) var dismissed = false
  private var answered: Set<String> = []
  private var presented = false

  var canPrompt: Bool { !open && !dismissed }

  // The catalog waiting hint can lag an answer; only use it before the first presentation.
  func shouldOpen(_ requestId: String? = nil) -> Bool {
    canPrompt && (requestId.map { !answered.contains($0) } ?? !presented)
  }

  mutating func opened() {
    open = true
    presented = true
  }
  mutating func closed(answer: String? = nil, cancelled: Bool = false) {
    open = false
    dismissed = dismissed || cancelled
    if let answer { answered.insert(answer) }
  }
}
