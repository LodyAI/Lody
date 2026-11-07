import Foundation

struct ChatMessageShare: Codable {
  struct Part: Codable {
    var text: String? = nil
    var image: ChatImage? = nil
  }
  let parts: [Part]
  let model: String
  var workspace = ""
  var session = ""

  var text: String { parts.compactMap(\.text).joined(separator: "\n\n") }

  static func content(in transcript: ChatTranscript, entryID: String) -> Self? {
    guard let entry = transcript.entries.first(where: { $0.id == entryID }),
      entry.role == "assistant", entry.finished, entry.holdOpen != true else { return nil }
    // Use the same projection as the conversation, including all final-result
    // blocks in a steered execution, but never its hidden process or tool logs.
    let entries: [ChatEntry]
    if let execution = entry.executionId {
      entries = transcript.entries.filter { $0.executionId == execution }
    } else { entries = [entry] }
    let parts = ChatTranscript(entries: entries).rows().filter { $0.entryID == entryID }.compactMap { row -> Part? in
      if row.kind == "text", !row.text.isEmpty { return Part(text: row.text) }
      if row.kind == "image", let image = row.image { return Part(image: image) }
      return nil
    }
    guard !parts.isEmpty else { return nil }
    let name = entry.modelInfo?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return Self(parts: parts, model: name.isEmpty ? (entry.modelInfo?.modelId ?? "") : name)
  }

  // A 1080 px-wide image, bounded before allocating its bitmap (about 52 MiB).
  static let width: CGFloat = 540
  static let maximumHeight: CGFloat = 6000
  static func accepts(height: CGFloat) -> Bool { height.isFinite && height > 0 && height <= maximumHeight }
}
