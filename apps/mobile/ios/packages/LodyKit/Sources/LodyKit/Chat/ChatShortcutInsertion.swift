import Foundation
import LodyCore

/// A piece of composer text: plain text, or a reference chip that shows `text` and sends `token`
/// (nil: it sends its text).
struct ChatComposerSegment: Equatable {
  var text: String
  var token: String?
  var reference = false
}

/// A Role as its chip shows it: emoji and name (web `applyAgentRoleEmojiChip`).
struct ChatRoleLabel: Equatable {
  let emoji: String
  let name: String
  var text: String { [emoji, name].filter { !$0.isEmpty }.joined(separator: " ") }
}

/// Choosing a prompt shortcut writes its body into the composer, as web's
/// `prepareShortcutSelection`: the prompt text, with each of its references as a chip carrying
/// the token the runtime expands at send (files `@path`, skills `$name`, Roles `@role:<id>`
/// shown as emoji + name, issues and pull requests `#number`).
enum ChatShortcutInsertion {
  static func segments(
    prompt: String, mentions: [RuntimeContract.PromptShortcutMention], role: (String) -> ChatRoleLabel?
  ) -> [ChatComposerSegment] {
    let text = prompt as NSString
    var result: [ChatComposerSegment] = []
    var cursor = 0
    for mention in mentions.sorted(by: { $0.start < $1.start }) {
      // Offsets are UTF-16, as web's string indices; skip anything out of order or bounds.
      guard mention.start >= cursor, mention.end > mention.start, mention.end <= text.length else { continue }
      if mention.start > cursor {
        result.append(ChatComposerSegment(text: text.substring(with: NSRange(location: cursor, length: mention.start - cursor))))
      }
      let label = text.substring(with: NSRange(location: mention.start, length: mention.end - mention.start))
      result.append(chip(mention.target, label: label, role: role))
      cursor = mention.end
    }
    if cursor < text.length { result.append(ChatComposerSegment(text: text.substring(from: cursor))) }
    return result
  }

  private static func chip(_ target: RuntimeContract.PromptShortcutTarget, label: String, role: (String) -> ChatRoleLabel?) -> ChatComposerSegment {
    switch target {
    case .file(let file):
      return ChatComposerSegment(text: "@" + file.path, reference: true)
    case .skill:
      let name = label.hasPrefix("$") ? label : "$" + label
      return ChatComposerSegment(text: name, reference: true)
    case .agentRole(let value):
      let token = "@role:" + value.agentRoleId
      let shown = role(value.agentRoleId)?.text ?? label
      return ChatComposerSegment(text: shown, token: token, reference: true)
    case .issue(let issue):
      return ChatComposerSegment(text: "#\(issue.number)", reference: true)
    case .pullRequest(let pull):
      return ChatComposerSegment(text: "#\(pull.number)", reference: true)
    }
  }

}
