import MarkdownView
import UIKit

final class LodyInlineDiffView: UIView {
  var onRender: ([String: Any]) -> Void = { _ in }
  var onFail: ([String: Any]) -> Void = { _ in }
  private let renderer = InlineDiffRenderer()
  private var path = ""
  private var oldText: String?
  private var newText: String?
  private var renderScheduled = false
  private var lastHeight: CGFloat = 0

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    backgroundColor = .clear
    addSubview(renderer)
  }

  func setPath(_ value: String) { path = value; scheduleRender() }
  func setOldText(_ value: String?) { oldText = value; scheduleRender() }
  func setNewText(_ value: String?) { newText = value; scheduleRender() }

  private func scheduleRender() {
    guard !renderScheduled else { return }
    renderScheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.renderScheduled = false
      self?.render()
    }
  }

  private func render() {
    guard oldText != nil || newText != nil else { return }
    let old = oldText ?? ""
    let new = newText ?? ""
    let document = InlineDiffModel.build(old: old, new: new)
    let bytes = old.utf8.count + new.utf8.count
    renderer.render(document, path: path, highlight: bytes <= 256 * 1024)
    if bytes <= 256 * 1024 {
      applyHighlight(document)
    }
    reportHeight()
    setNeedsLayout()
  }

  private func applyHighlight(_ document: InlineDiffDocument) {
    let language = DiffLanguage.name(for: path)
    var theme = ChatMarkdownTheme.make(traits: traitCollection, secondary: false)
    theme.fonts.code = UIFont.lodySFMono(ofSize: 13)
    theme.colors.code = .label
    let lines = document.hunks.flatMap(\.lines)
    var texts: [NSAttributedString] = []
    texts.reserveCapacity(lines.count)
    for line in lines {
      let map = CodeHighlighter.current.highlight(key: nil, content: line.text, language: language, theme: theme)
      let attributed = NSMutableAttributedString(attributedString: map.apply(to: line.text.isEmpty ? " " : line.text, with: theme))
      for range in line.emphasis where range.location != NSNotFound && NSMaxRange(range) <= attributed.length {
        attributed.addAttribute(
          .backgroundColor,
          value: InlineDiffRenderer.emphasisTint(for: line.kind),
          range: range
        )
      }
      texts.append(attributed)
    }
    renderer.applyHighlighted(texts)
  }

  private func reportHeight() {
    renderer.layoutIfNeeded()
    let height = renderer.contentHeight
    guard abs(height - lastHeight) > 0.5 else { return }
    lastHeight = height
    onRender(["fileCount": 1, "contentHeight": Double(height)])
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    renderer.frame = bounds
    renderer.layoutIfNeeded()
    reportHeight()
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory
      || previous?.userInterfaceStyle != traitCollection.userInterfaceStyle
    {
      scheduleRender()
    }
  }
}
