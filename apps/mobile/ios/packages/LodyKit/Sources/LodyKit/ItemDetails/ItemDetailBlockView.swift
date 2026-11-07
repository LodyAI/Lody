import LodyCore
import UIKit

@MainActor
enum ItemDetailBlockView {
  static func make(_ value: RuntimeContract.JSONValue) -> UIView {
    let data = try! JSONEncoder().encode(value)
    let block: Block
    do { block = try JSONDecoder().decode(Block.self, from: data) }
    catch { return text(error.localizedDescription + "\n" + json(value), color: .systemRed) }
    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 6
    switch block.type {
    case "diff":
      if let path = block.path { stack.addArrangedSubview(text(path, color: .secondaryLabel, monospaced: false)) }
      let diff = LodyInlineDiffView(frame: .zero)
      let height = diff.heightAnchor.constraint(equalToConstant: 44)
      height.isActive = true
      diff.onRender = { [weak height] body in height?.constant = max(44, body["contentHeight"] as! Double) }
      diff.setPath(block.path ?? "")
      diff.setOldText(block.oldText ?? "")
      diff.setNewText(block.newText ?? "")
      stack.addArrangedSubview(diff)
    case "terminal_command":
      stack.addArrangedSubview(text("$ " + ([block.command ?? ""] + (block.args ?? [])).joined(separator: " ")))
      if let cwd = block.cwd { stack.addArrangedSubview(text(cwd, color: .secondaryLabel, monospaced: false)) }
    case "terminal_output":
      stack.backgroundColor = .secondarySystemBackground
      stack.layer.cornerRadius = 12
      stack.isLayoutMarginsRelativeArrangement = true
      stack.directionalLayoutMargins = .init(top: 12, leading: 12, bottom: 12, trailing: 12)
      if let code = block.exitStatus?.exitCode, code != 0 {
        stack.addArrangedSubview(text(String.localizedStringWithFormat(String(localized: "detail.exitCode", bundle: .lody), String(describing: code)), color: .systemRed, monospaced: false))
      }
      stack.addArrangedSubview(text(block.output ?? ""))
    default:
      stack.addArrangedSubview(text(json(value)))
    }
    return stack
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

  static func json(_ value: RuntimeContract.JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try! encoder.encode(value), as: UTF8.self)
  }

  private struct Block: Decodable {
    var type: String
    var path: String?
    var oldText: String?
    var newText: String?
    var command: String?
    var args: [String]?
    var cwd: String?
    var output: String?
    var exitStatus: ExitStatus?
    struct ExitStatus: Decodable { var exitCode: Int? }
  }
}
