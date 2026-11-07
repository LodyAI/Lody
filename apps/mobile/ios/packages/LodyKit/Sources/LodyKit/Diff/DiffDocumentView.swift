import MarkdownView
import UIKit

enum DiffDocumentMode: Equatable {
  case diff(DiffDocumentStyle)
  case file(line: Int?)
}

final class DiffDocumentView: UIView, UICollectionViewDataSource, UICollectionViewDelegate {
  private struct Source {
    var text = ""
    var ranges: [NSRange] = []
    var highlighted: NSAttributedString?

    init(_ text: String = "") {
      self.text = DiffDocumentModel.normalized(text)
      ranges = DiffDocumentModel.lineRanges(self.text)
    }
  }

  static let highlightLimit = 256 * 1024

  private let layout = DiffDocumentLayout()
  let collectionView: UICollectionView
  var onRender: (() -> Void)?
  var onScroll: (() -> Void)?
  private(set) var path = ""
  private(set) var mode: DiffDocumentMode = .diff(.unified)
  private var rows: [InlineDiffLine] = []
  private var collapsed: [Range<Int>] = []
  private var items: [DiffDocumentItem] = []
  private var geometry = DiffDocumentGeometry(wrap: true, numberWidth: 0, sideWidth: 0, contentWidth: 0)
  private var paragraph = NSParagraphStyle()
  private var textWidth: CGFloat = 0
  private var laidOutWidth: CGFloat = -1
  private var old = Source()
  private var new = Source()
  private var highlightCount = 0
  private var generation = 0
  private var positioned = false

  override init(frame: CGRect) {
    collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(frame: frame)
    backgroundColor = .lodyOpaqueBackground
    collectionView.backgroundColor = .lodyOpaqueBackground
    collectionView.isDirectionalLockEnabled = true
    collectionView.alwaysBounceVertical = true
    collectionView.dataSource = self
    collectionView.delegate = self
    collectionView.register(DiffDocumentLineCell.self, forCellWithReuseIdentifier: DiffDocumentLineCell.reuse)
    collectionView.register(DiffDocumentGapCell.self, forCellWithReuseIdentifier: DiffDocumentGapCell.reuse)
    addSubview(collectionView)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: DiffDocumentView, _: UITraitCollection) in
      view.scheduleHighlight()
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var isFile: Bool {
    if case .file = mode { return true }
    return false
  }

  private var style: DiffDocumentStyle {
    if case .diff(let style) = mode { return style }
    return .unified
  }

  var selectedLine: Int? {
    if case .file(let line) = mode { return line }
    return nil
  }

  func show(path: String, old: String, new: String, mode: DiffDocumentMode) {
    generation += 1
    self.path = path
    self.mode = mode
    self.old = Source(isFile ? "" : old)
    self.new = Source(new)
    if isFile {
      rows = DiffDocumentModel.file(self.new.text)
      collapsed = []
    } else {
      rows = InlineDiffModel.rows(old: self.old.text, new: self.new.text)
      collapsed = DiffDocumentModel.hidden(rows)
    }
    highlightCount = 0
    positioned = false
    rebuild()
    scheduleHighlight()
  }

  func setStyle(_ style: DiffDocumentStyle) {
    guard case .diff(let current) = mode, current != style else { return }
    mode = .diff(style)
    rebuild()
  }

  private func rebuild() {
    if isFile {
      items = rows.map { .line($0) }
    } else {
      items = DiffDocumentModel.items(rows, hidden: collapsed, style: style)
    }
    laidOutWidth = -1
    setNeedsLayout()
    layoutIfNeeded()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    collectionView.frame = bounds
    let inset = collectionView.adjustedContentInset
    let width = collectionView.bounds.width - inset.left - inset.right
    if width > 0, width != laidOutWidth {
      relayout(width: width)
    }
    positionIfNeeded()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsLayout()
  }

  private func relayout(width: CGFloat) {
    laidOutWidth = width
    let split = !isFile && style == .split
    let maxNumber = rows.reduce(0) { max($0, $1.oldNumber ?? 0, $1.newNumber ?? 0) }
    var geometry = DiffDocumentGeometry(
      wrap: !isFile,
      numberWidth: DiffDocumentGeometry.numberWidth(maxNumber: maxNumber, minimumDigits: split ? 2 : 3),
      sideWidth: split ? floor(width / 2) : width,
      contentWidth: width
    )
    textWidth = 0
    if isFile {
      textWidth = rows.reduce(0) { max($0, geometry.width(of: $1.text)) }
      geometry.contentWidth = max(width, geometry.codeX + textWidth + InlineDiffMetrics.codeInset)
      geometry.sideWidth = geometry.contentWidth
    }
    self.geometry = geometry
    paragraph = DiffDocumentGeometry.paragraph(wrap: geometry.wrap, spaced: true)
    layout.update(heights: items.map(geometry.height(of:)), width: geometry.contentWidth)
    collectionView.alwaysBounceHorizontal = geometry.contentWidth > width
    collectionView.reloadData()
    onRender?()
  }

  private func positionIfNeeded() {
    guard !positioned, window != nil, collectionView.bounds.height > 0, laidOutWidth > 0 else { return }
    guard let line = selectedLine, let index = index(ofLine: line),
      let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
    else { return }
    positioned = true
    let inset = collectionView.adjustedContentInset
    let visible = collectionView.bounds.height - inset.top - inset.bottom
    let limit = max(-inset.top, layout.collectionViewContentSize.height + inset.bottom - collectionView.bounds.height)
    let y = min(max(frame.midY - inset.top - visible / 2, -inset.top), limit)
    collectionView.contentOffset = CGPoint(x: -inset.left, y: y)
  }

  private func index(ofLine line: Int) -> Int? {
    items.firstIndex {
      if case .line(let row) = $0 { return row.newNumber == line }
      return false
    }
  }

  private func scheduleHighlight() {
    guard old.text.utf8.count + new.text.utf8.count <= Self.highlightLimit else { return }
    let generation = generation
    DispatchQueue.main.async { [weak self] in
      guard let self, self.generation == generation else { return }
      self.highlight()
    }
  }

  private func highlight() {
    let language = DiffLanguage.name(for: path)
    var theme = ChatMarkdownTheme.make(traits: traitCollection, secondary: false)
    theme.fonts.code = InlineDiffMetrics.font()
    theme.colors.code = .label
    func run(_ text: String) -> (NSAttributedString?, Int) {
      guard !text.isEmpty else { return (nil, 0) }
      let map = CodeHighlighter.current.highlight(key: nil, content: text, language: language, theme: theme)
      return (map.apply(to: text, with: theme), map.count)
    }
    let next = run(new.text)
    new.highlighted = next.0
    highlightCount = next.1
    old.highlighted = run(old.text).0
    collectionView.reconfigureItems(at: collectionView.indexPathsForVisibleItems)
    onRender?()
  }

  private func text(for line: InlineDiffLine) -> NSAttributedString {
    let deleted = line.kind == .delete
    let source = deleted ? old : new
    let number = (deleted ? line.oldNumber : line.newNumber) ?? 0
    let result: NSMutableAttributedString
    if let highlighted = source.highlighted, source.ranges.indices.contains(number - 1),
      NSMaxRange(source.ranges[number - 1]) <= highlighted.length
    {
      result = NSMutableAttributedString(attributedString: highlighted.attributedSubstring(from: source.ranges[number - 1]))
    } else {
      result = NSMutableAttributedString(string: line.text, attributes: [.foregroundColor: UIColor.label])
    }
    let range = NSRange(location: 0, length: result.length)
    result.addAttributes([.font: InlineDiffMetrics.font(), .paragraphStyle: paragraph], range: range)
    for emphasis in line.emphasis where emphasis.location != NSNotFound && NSMaxRange(emphasis) <= result.length {
      result.addAttribute(.backgroundColor, value: InlineDiffRenderer.emphasisTint(for: line.kind), range: emphasis)
    }
    return result
  }

  private func side(_ line: InlineDiffLine, number: Int?) -> DiffDocumentSide {
    DiffDocumentSide(
      kind: line.kind,
      number: number,
      text: text(for: line),
      selected: selectedLine != nil && line.newNumber == selectedLine
    )
  }

  private func voiceOver(_ line: InlineDiffLine, number: Int?) -> String {
    let key: String
    switch line.kind {
    case .insert: key = "native.diff.line.insert"
    case .delete: key = "native.diff.line.delete"
    case .context: key = "native.diff.line.context"
    }
    return String.localizedStringWithFormat(String(localized: String.LocalizationValue(key), bundle: .lody), String(describing: number ?? 0), String(describing: line.text))
  }

  private var pin: CGFloat {
    guard isFile else { return 0 }
    return max(0, collectionView.contentOffset.x + collectionView.adjustedContentInset.left)
  }

  func numberOfSections(in collectionView: UICollectionView) -> Int { 1 }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    items.count
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let item = items[indexPath.item]
    if case .gap(let range) = item {
      let cell = collectionView.dequeueReusableCell(withReuseIdentifier: DiffDocumentGapCell.reuse, for: indexPath)
      (cell as? DiffDocumentGapCell)?.apply(count: range.count)
      return cell
    }
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: DiffDocumentLineCell.reuse, for: indexPath)
    guard let line = cell as? DiffDocumentLineCell else { return cell }
    switch item {
    case .line(let row):
      let number = row.newNumber ?? row.oldNumber
      line.apply(
        left: side(row, number: number), right: nil, split: false,
        geometry: geometry, textWidth: textWidth, label: voiceOver(row, number: number)
      )
    case .pair(let left, let right):
      var labels = [left.map { voiceOver($0, number: $0.oldNumber) }]
      if right?.kind != .context { labels.append(right.map { voiceOver($0, number: $0.newNumber) }) }
      line.apply(
        left: left.map { side($0, number: $0.oldNumber) }, right: right.map { side($0, number: $0.newNumber) }, split: true,
        geometry: geometry, textWidth: textWidth, label: labels.compactMap { $0 }.joined(separator: "\n")
      )
    case .gap:
      break
    }
    line.pin = pin
    return line
  }

  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    if case .gap = items[indexPath.item] { return true }
    return false
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard case .gap(let range) = items[indexPath.item] else { return }
    collapsed.removeAll { $0 == range }
    rebuild()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    onScroll?()
    guard isFile else { return }
    let pin = pin
    for cell in collectionView.visibleCells {
      (cell as? DiffDocumentLineCell)?.pin = pin
    }
  }

  func probe() -> [String: Any] {
    let inset = collectionView.adjustedContentInset
    let offset = collectionView.contentOffset
    let size = layout.collectionViewContentSize
    let expected = new.text.hasSuffix("\n") ? String(new.text.dropLast()) : new.text
    var result: [String: Any] = [
      "path": path,
      "line": selectedLine ?? 0,
      "rows": items.count,
      "sourceMatches": rows.map(\.text).joined(separator: "\n") == expected,
      "coloredTokens": highlightCount,
      "highlighted": selectedLine.flatMap(index(ofLine:)) != nil,
      "top": inset.top,
      "bottom": collectionView.bounds.height - inset.bottom,
      "width": collectionView.bounds.width,
      "height": collectionView.bounds.height,
      "x": offset.x + inset.left,
      "y": offset.y + inset.top,
      "contentWidth": size.width,
      "contentHeight": size.height,
    ]
    if let line = selectedLine, let index = index(ofLine: line),
      let frame = layout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
    {
      result["targetY"] = frame.minY - offset.y
      result["targetHeight"] = frame.height
    }
    return result
  }
}
