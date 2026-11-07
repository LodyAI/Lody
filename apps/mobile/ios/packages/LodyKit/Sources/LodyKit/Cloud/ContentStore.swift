import Foundation

struct StoredContent {
  let data: Data
  let kind: String
  let path: String
  let session: String
  let mimeType: String?
}

// The runtime stores file bodies here; native views resolve handles on the main actor.
@MainActor
final class ContentStore {
  static let shared = ContentStore(limit: 32 * 1024 * 1024)
  private let limit: Int
  private var entries: [String: StoredContent] = [:]
  private var order: [String] = []
  private(set) var totalBytes = 0

  init(limit: Int) { self.limit = limit }

  @discardableResult
  func put(_ content: StoredContent) -> String {
    let handle = UUID().uuidString
    entries[handle] = content
    order.append(handle)
    totalBytes += content.data.count
    while totalBytes > limit, order.count > 1, let oldest = order.first {
      remove(oldest)
    }
    return handle
  }

  func get(_ handle: String) -> StoredContent? {
    guard let content = entries[handle] else { return nil }
    if let index = order.firstIndex(of: handle) {
      order.remove(at: index)
      order.append(handle)
    }
    return content
  }

  func clear(session: String) {
    for (handle, content) in entries where content.session == session { remove(handle) }
  }

  func clearAll() {
    entries.removeAll(); order.removeAll(); totalBytes = 0
  }

  private func remove(_ handle: String) {
    guard let content = entries.removeValue(forKey: handle) else { return }
    totalBytes -= content.data.count
    order.removeAll { $0 == handle }
  }

  static func classify(path: String, binary: Bool, mimeType: String?) -> String {
    if binary { return mimeType?.hasPrefix("image/") == true ? "image" : "binary" }
    let ext = (path as NSString).pathExtension.lowercased()
    return ["md", "mdx", "markdown"].contains(ext) ? "markdown" : "text"
  }
}
