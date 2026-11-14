import LodyCore
import UIKit

/// A tool step's detail, formatted as web's expanded tool card (`ToolCallCard.renderDetail` and
/// `tool-call-detail.tsx`): what the step did and got back, in order, as sections of one sheet.
/// A command reads as a shell line, output as what the program printed (with a non-zero exit as
/// the one coloured fact), JSON or a fenced snapshot as verbatim mono text, and prose as Markdown.
/// A diff is its own surface, so it closes the sheet before it and opens a new one after.
@MainActor
enum ItemDetailBlockView {
  static func views(blocks values: [RuntimeContract.JSONValue], rawOutput: RuntimeContract.DetailValue?, kind: String?, title: String?) -> [UIView] {
    let decoded = values.map { value in (value, try? JSONDecoder().decode(Block.self, from: JSONEncoder().encode(value))) }
    let hasDiff = decoded.contains { $0.1?.type == "diff" }
    let hasTerminal = decoded.contains { ["terminal_command", "terminal_output"].contains($0.1?.type ?? "") }
    // Beside a diff, terminal output only repeats the edit.
    let blocks = decoded.filter { !hasDiff || !["terminal", "terminal_output"].contains($0.1?.type ?? "") }
    let commands: [String] = blocks.compactMap { _, block in
      guard let block, block.type == "terminal_command" else { return nil }
      return command(block)
    }
    let shell = isCommand(kind: kind, hasCommand: !commands.isEmpty)

    // An execute step's one-line text block is its description: the row already shows it.
    var titleIndex: Int?
    if kind == "execute", hasTerminal {
      titleIndex = blocks.firstIndex { _, block in
        guard block?.type == "content", block?.content?.type == "text" else { return false }
        let text = (block?.content?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && !text.contains("\n") && text.count <= 96 && !isEcho(text, commands: commands)
      }
    }

    var views: [UIView] = []
    var sections: [UIView] = []
    func flush() {
      guard !sections.isEmpty else { return }
      views.append(sheet(sections))
      sections = []
    }
    var index = 0
    while index < blocks.count {
      defer { index += 1 }
      if index == titleIndex { continue }
      let (value, decodedBlock) = blocks[index]
      guard let block = decodedBlock else {
        sections.append(section(verbatim(json(value))))
        continue
      }
      switch block.type {
      case "terminal_command", "terminal_output":
        var outputs: [Block] = block.type == "terminal_output" ? [block] : []
        var next = index + 1
        while next < blocks.count {
          let candidate = blocks[next].1
          if next == titleIndex || candidate?.type == "terminal" { next += 1; continue }
          guard let candidate, candidate.type == "terminal_output" else { break }
          outputs.append(candidate)
          next += 1
        }
        if block.type == "terminal_command" { sections.append(commandSection(command(block), shell: shell)) }
        if let output = outputSection(outputs) { sections.append(output) }
        index = next - 1
      case "terminal":
        if !hasTerminal { sections.append(section(caption(String(localized: "detail.terminalStreaming", bundle: .lody)))) }
      case "diff":
        flush()
        views.append(diff(block))
      case "content":
        guard let content = block.content else { continue }
        guard content.type == "text" else {
          sections.append(section(contentText(content) ?? verbatim(json(value))))
          continue
        }
        let text = content.text ?? ""
        if isEcho(text, commands: commands) { continue }
        // Tool input arrives as serialized JSON text: data, never Markdown.
        let machine = jsonText(text) ?? fencedText(text)
        if machine == nil, kind == "execute" {
          // A shell step's plain text is what the program printed.
          if let output = outputSection([Block(type: "terminal_output", output: text)]) { sections.append(output) }
        } else if machine != nil || isToolSearch(title) {
          sections.append(section(verbatim(machine ?? text)))
        } else {
          sections.append(section(markdown(text)))
        }
      default:
        sections.append(section(verbatim(json(value))))
      }
    }
    if let rawOutput { sections.append(section(verbatim(display(rawOutput.value)))) }
    flush()
    return views
  }

  // MARK: Surfaces

  /// The conversation's inset material, its sections divided by hairlines, never above the first.
  private static func sheet(_ sections: [UIView]) -> UIView {
    let stack = UIStackView()
    stack.axis = .vertical
    stack.backgroundColor = .lodyInset
    stack.layer.cornerRadius = 12
    stack.layer.cornerCurve = .continuous
    stack.clipsToBounds = true
    for (offset, section) in sections.enumerated() {
      if offset > 0 {
        let rule = UIView()
        rule.backgroundColor = .separator
        rule.heightAnchor.constraint(equalToConstant: 1 / max(1, UITraitCollection.current.displayScale)).isActive = true
        stack.addArrangedSubview(rule)
      }
      stack.addArrangedSubview(section)
    }
    return stack
  }

  private static func section(_ content: UIView) -> UIView {
    let stack = UIStackView(arrangedSubviews: [content])
    stack.axis = .vertical
    stack.spacing = 4
    stack.isLayoutMarginsRelativeArrangement = true
    stack.directionalLayoutMargins = .init(top: 10, leading: 12, bottom: 10, trailing: 12)
    return stack
  }

  private static func commandSection(_ command: String, shell: Bool) -> UIView {
    let line = NSMutableAttributedString()
    let font = UIFont.lodySFMono(ofSize: 13)
    // A search's stored "command" is its pattern, not a shell line, so it gets no prompt.
    if shell { line.append(NSAttributedString(string: "$ ", attributes: [.font: font, .foregroundColor: UIColor.tertiaryLabel])) }
    line.append(NSAttributedString(string: command, attributes: [.font: font, .foregroundColor: UIColor.label]))
    let view = text("")
    view.attributedText = line
    return section(view)
  }

  /// What the program printed. A non-zero exit is the one fact worth a colour.
  private static func outputSection(_ outputs: [Block]) -> UIView? {
    let output = outputs.compactMap(\.output).joined().replacingOccurrences(of: ansiPattern, with: "", options: .regularExpression)
    let code = outputs.last?.exitStatus?.exitCode
    let failed = code.map { $0 != 0 } ?? false
    guard !output.isEmpty || failed else { return nil }
    var parts: [UIView] = []
    if !output.isEmpty, outputs.contains(where: { $0.truncated == true }) {
      parts.append(caption(String(localized: "detail.earlierOutputHidden", bundle: .lody)))
    }
    if !output.isEmpty { parts.append(verbatim(output)) }
    if let code, failed {
      let exit = text(String.localizedStringWithFormat(String(localized: "detail.exitCode", bundle: .lody), String(describing: code)), color: .systemRed)
      exit.font = .lodySFMono(ofSize: 12)
      parts.append(exit)
    }
    let stack = UIStackView(arrangedSubviews: parts)
    stack.axis = .vertical
    stack.spacing = 4
    return section(stack)
  }

  private static func diff(_ block: Block) -> UIView {
    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 6
    if let path = block.path { stack.addArrangedSubview(text(path, color: .secondaryLabel, monospaced: false)) }
    let diff = LodyInlineDiffView(frame: .zero)
    let height = diff.heightAnchor.constraint(equalToConstant: 44)
    height.isActive = true
    diff.onRender = { [weak height] body in height?.constant = max(44, body["contentHeight"] as! Double) }
    diff.setPath(block.path ?? "")
    diff.setOldText(block.oldText ?? "")
    diff.setNewText(block.newText ?? "")
    stack.addArrangedSubview(diff)
    return stack
  }

  private static func verbatim(_ string: String) -> UITextView { text(string, color: .secondaryLabel) }

  private static func caption(_ string: String) -> UITextView {
    let view = text(string, color: .tertiaryLabel, monospaced: false)
    view.font = .preferredFont(forTextStyle: .caption1)
    return view
  }

  /// Prose a tool returned (a fetch summary, an MCP reply), with its line breaks kept.
  private static func markdown(_ string: String) -> UITextView {
    let view = text(string, monospaced: false)
    let base = UIFont.preferredFont(forTextStyle: .subheadline)
    view.font = base
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    if var parsed = try? AttributedString(markdown: string, options: options) {
      // UIKit does not draw presentation intents, so emphasis and code spans become fonts.
      for run in parsed.runs {
        let intent = run.inlinePresentationIntent ?? []
        var font = base
        if intent.contains(.code) {
          font = .lodySFMono(ofSize: base.pointSize)
        } else {
          var traits: UIFontDescriptor.SymbolicTraits = []
          if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
          if intent.contains(.emphasized) { traits.insert(.traitItalic) }
          if !traits.isEmpty, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) { font = UIFont(descriptor: descriptor, size: 0) }
        }
        parsed[run.range].font = font
      }
      parsed.foregroundColor = UIColor.label
      view.attributedText = NSAttributedString(parsed)
    }
    view.dataDetectorTypes = [.link]
    return view
  }

  /// Non-text MCP content: name what it points at rather than dumping its JSON.
  private static func contentText(_ content: Block.Content) -> UITextView? {
    let lines = [content.name ?? content.title, content.uri ?? content.resource?.uri, content.resource?.text].compactMap { $0 }.filter { !$0.isEmpty }
    guard !lines.isEmpty else { return nil }
    let view = verbatim(lines.joined(separator: "\n"))
    view.dataDetectorTypes = [.link]
    return view
  }

  static func text(_ string: String, color: UIColor = .label, monospaced: Bool = true) -> UITextView {
    let view = UITextView()
    view.text = string
    view.font = monospaced ? .lodySFMono(ofSize: 13) : .preferredFont(forTextStyle: .footnote)
    view.adjustsFontForContentSizeCategory = true
    view.textColor = color
    view.backgroundColor = .clear
    view.isEditable = false
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    return view
  }

  // MARK: Text rules (web `tool-call-command.ts`, `tool-call-json-text.ts`)

  static func json(_ value: RuntimeContract.JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try! encoder.encode(value), as: UTF8.self)
  }

  /// A string result is shown as the text it is, not as a quoted JSON string full of `\n`.
  private static func display(_ value: RuntimeContract.JSONValue) -> String {
    if case .string(let string) = value { return jsonText(string) ?? string }
    return json(value)
  }

  /// The text untouched when it is a JSON object or array; re-serializing could rewrite numbers.
  private static func jsonText(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("{") || trimmed.hasPrefix("["),
          let object = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)),
          object is [Any] || object is [String: Any] else { return nil }
    return trimmed
  }

  /// The body of a text result that is exactly one fenced block (a terminal snapshot, an excerpt).
  private static func fencedText(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let expression = try? NSRegularExpression(pattern: "^```[^\\n`]*\\n([\\s\\S]*?)\\n?```$"),
          let match = expression.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let range = Range(match.range(at: 1), in: trimmed) else { return nil }
    return String(trimmed[range])
  }

  private static func isCommand(kind: String?, hasCommand: Bool) -> Bool {
    switch kind {
    case "execute", "bash": true
    case "read", "edit", "write", "delete", "move", "search", "fetch", "think", "switch_mode": false
    default: hasCommand
    }
  }

  /// ToolSearch returns a machine-readable reference, not prose from the agent.
  private static func isToolSearch(_ title: String?) -> Bool {
    title?.replacingOccurrences(of: "[\\s_-]+", with: "", options: .regularExpression).lowercased() == "toolsearch"
  }

  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }

  private static let shellWrapper = "^(?:/(?:usr/)?(?:local/)?bin/)?(?:bash|sh|zsh|dash|fish)$"
  private static let scriptFlag = "^-(?:l?c|cl)$"
  private static let safeWord = "^[\\w@%+=:,./~-]+$"
  private static let ansiPattern = "\u{1B}\\[[0-9;?]*[ -/]*[@-~]"

  /// The command a reader would have typed: a shell wrapper's script, else argv quoted for a shell.
  private static func command(_ block: Block) -> String {
    let command = block.command ?? ""
    let args = block.args ?? []
    if matches(command, shellWrapper) {
      if args.count == 2, matches(args[0], scriptFlag) { return args[1] }
      if args.count == 3, args[0] == "-l", args[1] == "-c" { return args[2] }
    }
    guard !args.isEmpty else { return command }
    let quoted = args.map { word in
      if word.isEmpty { return "''" }
      if matches(word, safeWord) { return word }
      return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
    return ([command] + quoted).filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// Whether a text block only restates the step's command.
  private static func isEcho(_ text: String, commands: [String]) -> Bool {
    func collapse(_ value: String) -> String {
      value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    var visible = fencedText(text) ?? text
    let trimmed = visible.trimmingCharacters(in: .whitespacesAndNewlines)
    if matches(trimmed, "^`[^`]+`$") { visible = String(trimmed.dropFirst().dropLast()) }
    // A provider can link a path inside the echo; the reader sees the link label.
    visible = visible.replacingOccurrences(of: "\\[([^\\]\\n]+)\\]\\((?:<[^>\\n]+>|[^)\\n]+)\\)", with: "$1", options: .regularExpression)
    let echoed = collapse(visible)
    return !echoed.isEmpty && commands.contains { collapse($0) == echoed }
  }

  fileprivate struct Block: Decodable {
    var type: String
    var path: String?
    var oldText: String?
    var newText: String?
    var command: String?
    var args: [String]?
    var output: String?
    var truncated: Bool?
    var exitStatus: ExitStatus?
    var content: Content?
    struct ExitStatus: Decodable { var exitCode: Int? }
    struct Content: Decodable {
      var type: String
      var text: String?
      var name: String?
      var title: String?
      var uri: String?
      var resource: Resource?
      struct Resource: Decodable { var uri: String?; var text: String? }
    }

    init(type: String, output: String) {
      self.type = type
      self.output = output
    }
  }
}
