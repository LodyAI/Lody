import UIKit

func lines(_ document: InlineDiffDocument) -> [InlineDiffLine] {
  document.hunks.flatMap(\.lines)
}

func texts(_ document: InlineDiffDocument) -> [String] {
  lines(document).map { kind in
    let name: String
    switch kind.kind {
    case .context: name = "context"
    case .insert: name = "insert"
    case .delete: name = "delete"
    }
    return "\(name):\(kind.text)"
  }
}

// A replace of one unique line must stay in file order: context, delete, insert, context.
do {
  let document = InlineDiffModel.build(old: "a\nb\nc\n", new: "a\nhello\nc\n")
  precondition(texts(document) == [
    "context:a",
    "delete:b",
    "insert:hello",
    "context:c",
  ])
  let changed = lines(document).filter { $0.kind != .context }
  precondition(changed.count == 2)
  precondition(!changed[0].emphasis.isEmpty)
  precondition(!changed[1].emphasis.isEmpty)
}

// Repeated identical lines must not swap later copies.
do {
  let document = InlineDiffModel.build(old: "x\nx\ny\n", new: "x\nz\ny\n")
  precondition(texts(document) == [
    "context:x",
    "delete:x",
    "insert:z",
    "context:y",
  ])
}

// Empty old file is a pure insert; empty new file is a pure delete.
do {
  let added = InlineDiffModel.build(old: "", new: "only\n")
  precondition(texts(added) == ["insert:only"])
  let removed = InlineDiffModel.build(old: "gone\n", new: "")
  precondition(texts(removed) == ["delete:gone"])
}

// Unicode grapheme clusters stay intact as one token.
do {
  let document = InlineDiffModel.build(old: "café\n", new: "cafés\n")
  precondition(texts(document) == ["delete:café", "insert:cafés"])
}

// Distant edits become two hunks; each keeps three context lines.
do {
  let old = (1...20).map { "line-\($0)" }.joined(separator: "\n") + "\n"
  let newLines = (1...20).map { $0 == 2 || $0 == 18 ? "changed-\($0)" : "line-\($0)" }
  let document = InlineDiffModel.build(old: old, new: newLines.joined(separator: "\n") + "\n")
  precondition(document.hunks.count == 2)
  precondition(lines(document).contains { $0.text == "line-1" })
  precondition(lines(document).contains { $0.text == "line-20" })
  precondition(!lines(document).contains { $0.text == "line-10" })
}

// Identical files still show the body so an empty-looking block is not blank.
do {
  let document = InlineDiffModel.build(old: "same\n", new: "same\n")
  precondition(texts(document) == ["context:same"])
}

// Full documents collapse unchanged runs beyond three lines of context into expandable gaps.
do {
  let old = (1...20).map { "line-\($0)" }.joined(separator: "\n") + "\n"
  let new = (1...20).map { $0 == 2 || $0 == 18 ? "changed-\($0)" : "line-\($0)" }.joined(separator: "\n") + "\n"
  let rows = InlineDiffModel.rows(old: old, new: new)
  let hidden = DiffDocumentModel.hidden(rows)
  precondition(hidden.count == 1)
  precondition(rows[hidden[0]].map(\.text) == (6...14).map { "line-\($0)" })
  let items = DiffDocumentModel.items(rows, hidden: hidden, style: .unified)
  precondition(items.count == rows.count - hidden[0].count + 1)
  precondition(items.contains(.gap(hidden[0])))
  precondition(DiffDocumentModel.items(rows, hidden: [], style: .unified).count == rows.count)
  let tail = DiffDocumentModel.hidden(InlineDiffModel.rows(old: "1\n2\n3\n4\n5\n6\n7\n8\n", new: "1\n2\n3\n4\n5\n6\n7\nX\n"))
  precondition(tail == [0..<4])
  precondition(DiffDocumentModel.hidden(InlineDiffModel.rows(old: "same\n", new: "same\n")).isEmpty)
}

// Split pairs a deleted run with the inserted run that replaces it; extra lines face an empty side.
do {
  let rows = InlineDiffModel.rows(old: "a\nb\nc\n", new: "a\nB\nC\nD\nc\n")
  let pairs = DiffDocumentModel.pairs(rows[...]).map { "\($0.0?.text ?? "-")|\($0.1?.text ?? "-")" }
  precondition(pairs == ["a|a", "b|B", "-|C", "-|D", "c|c"], "\(pairs)")
  let items = DiffDocumentModel.items(rows, hidden: [], style: .split)
  precondition(items.count == 5)
}

// File mode numbers every line, and line ranges index the normalized source in UTF-16.
do {
  let text = DiffDocumentModel.normalized("é1\r\nb\rlast")
  precondition(text == "é1\nb\nlast")
  precondition(DiffDocumentModel.file(text).map(\.newNumber) == [1, 2, 3])
  precondition(DiffDocumentModel.lineRanges(text) == [NSRange(location: 0, length: 2), NSRange(location: 3, length: 1), NSRange(location: 5, length: 4)])
  precondition(DiffDocumentModel.lineRanges("a\n\nb\n").count == 3)
  precondition(DiffLanguage.name(for: "src/App.tsx") == "typescript")
  precondition(DiffLanguage.name(for: "Makefile") == nil)
}

// Wrapped rows grow in whole 20 pt lines; unwrapped rows keep one line and report their width.
do {
  let geometry = DiffDocumentGeometry(wrap: true, numberWidth: 24, sideWidth: 200, contentWidth: 200)
  precondition(geometry.lines("short") == 1)
  let long = String(repeating: "word ", count: 40)
  let lines = geometry.lines(long)
  precondition(lines > 2, "\(lines)")
  precondition(geometry.height(of: .line(InlineDiffLine(kind: .insert, oldNumber: nil, newNumber: 1, text: long, emphasis: []))) == CGFloat(lines) * 20)
  precondition(geometry.height(of: .gap(0..<3)) == 28)
  let flat = DiffDocumentGeometry(wrap: false, numberWidth: 24, sideWidth: 200, contentWidth: 200)
  precondition(flat.lines(long) == 1)
  precondition(abs(flat.width(of: "abcd") - flat.digit * 4) < 0.5)
  precondition(flat.width(of: "中文") > 0)
  precondition(DiffDocumentGeometry.numberWidth(maxNumber: 12345, minimumDigits: 3) == DiffDocumentGeometry.digitWidth * 5)
}

// The layout returns only the rows that intersect the visible rect.
do {
  let layout = DiffDocumentLayout()
  layout.update(heights: [20, 28, 40, 20], width: 320)
  precondition(layout.collectionViewContentSize == CGSize(width: 320, height: 108))
  let visible = layout.layoutAttributesForElements(in: CGRect(x: 0, y: 25, width: 320, height: 10))?.map(\.indexPath.item)
  precondition(visible == [1], "\(String(describing: visible))")
  let tail = layout.layoutAttributesForElements(in: CGRect(x: 0, y: 60, width: 320, height: 100))?.map(\.indexPath.item)
  precondition(tail == [2, 3])
}

let renderer = InlineDiffRenderer(frame: CGRect(x: 0, y: 0, width: 320, height: 10))
renderer.render(
  InlineDiffModel.build(old: "short\n", new: "short\nvery-long-identifier-that-needs-horizontal-scroll\n"),
  path: "demo.ts",
  highlight: false
)
renderer.bounds.size.height = renderer.contentHeight
renderer.layoutIfNeeded()
precondition(renderer.contentHeight > 40, "Renderer must report full stacked height")
precondition(!renderer.allowsVerticalScrolling, "Inline diff must not scroll vertically")
precondition(renderer.allowsHorizontalScrolling, "Long lines must scroll horizontally")
precondition(
  renderer.lineViews.allSatisfy { abs($0.bounds.height - 20) < 0.5 },
  "Code rows must share the 20 pt line box"
)
let origins = renderer.lineViews.map { $0.convert($0.bounds, to: renderer).minY }
if origins.count >= 2 {
  precondition(abs((origins[1] - origins[0]) - 20) < 0.5, "Adjacent rows must sit on a 20 pt grid")
}
precondition(!renderer.rowProbes.isEmpty, "Rendered rows must expose alignment probes")
for probe in renderer.rowProbes {
  precondition(abs(probe.row.height - 20) < 0.5, "Each row is a 20 pt box")
  precondition(abs(probe.gutter.minY - probe.code.minY) < 0.5, "Gutter tint must share the code band origin")
  precondition(abs(probe.gutter.height - probe.code.height) < 0.5, "Gutter tint must share the code band height")
  precondition(abs(probe.bar.minY - probe.gutter.minY) < 0.5, "Change bar must share the gutter origin")
  precondition(abs(probe.bar.height - probe.gutter.height) < 0.5, "Change bar must share the gutter height")
  precondition(abs(probe.number.minY - probe.code.minY) < 0.5, "Line numbers must share the code origin")
  precondition(abs(probe.number.height - probe.code.height) < 0.5, "Line numbers must share the code height")
}
let numberXs = Set(renderer.rowProbes.map { $0.number.minX.rounded() })
let codeXs = Set(renderer.rowProbes.map { $0.code.minX.rounded() })
precondition(numberXs.count == 1, "Every line number must sit on the same left column")
precondition(codeXs.count == 1, "Every code band must share one left edge")

func channels(_ color: UIColor, _ style: UIUserInterfaceStyle) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) {
  var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
  color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&r, green: &g, blue: &b, alpha: &a)
  return (r, g, b, a)
}

func resolved(_ color: UIColor, _ style: UIUserInterfaceStyle) -> UIColor {
  color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
}

for style in [UIUserInterfaceStyle.light, .dark] {
  for kind in [InlineDiffLine.Kind.insert, .delete] {
    let tints = [
      InlineDiffRenderer.gutterTint(for: kind),
      InlineDiffRenderer.lineTint(for: kind),
      InlineDiffRenderer.emphasisTint(for: kind),
      InlineDiffRenderer.barColor(for: kind),
    ]
    let expected = kind == .insert ? UIColor.systemGreen : .systemRed
    precondition(
      resolved(InlineDiffRenderer.barColor(for: kind), style).isEqual(resolved(expected, style)),
      "\(kind) bar must match \(kind == .insert ? "systemGreen" : "systemRed")"
    )
    for tint in tints {
      let parts = channels(tint, style)
      if kind == .insert {
        precondition(parts.g > parts.r && parts.g > parts.b, "insert tint must be green: \(parts)")
      } else {
        precondition(parts.r > parts.g && parts.r > parts.b, "delete tint must be red: \(parts)")
      }
    }
    let alphas = tints.dropLast().map { channels($0, style).a }
    precondition(alphas == alphas.sorted(), "Gutter fade must stay quieter than line and word fades")
  }
  for kind in [InlineDiffLine.Kind.context] {
    precondition(channels(InlineDiffRenderer.lineTint(for: kind), style).a == 0)
    precondition(channels(InlineDiffRenderer.barColor(for: kind), style).a == 0)
  }
}

print("PASS: inline diff model, hunks, emphasis, layout height, scroll axes, green/red tint scale, document gaps, split pairs, wrap geometry")
