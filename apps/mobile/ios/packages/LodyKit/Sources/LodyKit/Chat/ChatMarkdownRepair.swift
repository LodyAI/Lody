import Foundation
import JavaScriptCore

/// Presentation only: the original source remains the persistence/copy authority.
/// One isolated bundled function, with no native callbacks or network capabilities.
final class ChatMarkdownRepair: @unchecked Sendable {
  static let shared = ChatMarkdownRepair()
  private let lock = NSLock()
  private let context: JSContext?
  private let function: JSValue?

  init(script: String? = nil) {
    let url = Bundle(for: ChatMarkdownRepair.self).url(forResource: "MarkdownRepair", withExtension: "js")
      ?? Bundle.main.url(forResource: "MarkdownRepair", withExtension: "js")
    let bundled = url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    let context = JSContext()
    if let source = script ?? bundled { context?.evaluateScript(source) }
    self.context = context
    function = context?.objectForKeyedSubscript("repairMarkdown")
  }

  func repair(_ source: String) -> String {
    lock.lock()
    defer { lock.unlock() }
    guard let context, let function, !function.isUndefined else { return source }
    context.exception = nil
    let result = function.call(withArguments: [source])
    guard context.exception == nil, let result, result.isString else { return source }
    return result.toString() ?? source
  }
}
