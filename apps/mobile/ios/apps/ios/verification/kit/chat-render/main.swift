import ChatKit
import UIKit

let toolParagraph = NSMutableParagraphStyle()
toolParagraph.lineBreakMode = .byTruncatingTail
toolParagraph.minimumLineHeight = 18
toolParagraph.maximumLineHeight = 18
let toolText = CKTextView(frame: CGRect(x: 0, y: 0, width: 180, height: 30))
toolText.setText(NSAttributedString(string: String(repeating: "cat packages/components/source.ts; ", count: 30), attributes: [.font: UIFont.systemFont(ofSize: 15), .paragraphStyle: toolParagraph]))
precondition(toolText.sizeThatFits(CGSize(width: 180, height: 10000)).height <= 20, "Long tool commands truncate to one line")
print("Tool command single-line rendering passed")

let mentionText = "#30 @src/app.ts @\"folder/my file.swift\" use /review [Skill Path](/skills/review/SKILL.md)"
let mentionSource = NSAttributedString(string: mentionText, attributes: [.font: UIFont.systemFont(ofSize: 17)])
let richMentions = ChatUserMentions.decorate(mentionSource, repository: "Innei/lody-ios", traits: .current)
precondition(mentionSource.string == mentionText, "Decorating must not change the stored or copied prompt")
precondition(richMentions.string.contains("$review") && !richMentions.string.contains("[Skill Path]"))
let mentionView = CKTextView(frame: CGRect(x: 0, y: 0, width: 180, height: 400))
mentionView.setText(richMentions)
var mentionOpened = ""
mentionView.onLink = { mentionOpened = $0 }
precondition(mentionView.link(at: CGPoint(x: 5, y: 12)) == "https://github.com/Innei/lody-ios/issues/30")
precondition(mentionView.linkActions.map(\.name) == ["#30", "@src/app.ts", "@folder/my file.swift", "$review"])
precondition(mentionView.linkActions.last!.actionHandler!(mentionView.linkActions.last!))
precondition(mentionOpened == "/skills/review/SKILL.md", "The skill must open its file, not execute an instruction")
mentionView.linkHitHeight = 0
precondition(mentionView.link(at: CGPoint(x: 5, y: 12)) == nil, "Faded or collapsed text must not intercept touches")
let literal = "`#30 @src/app.ts` `` @src/app.ts #30 `` ```\n@src/app.ts\n#30\n``` https://example.org/#30 someone@example.org \\#30 \\@src/app.ts @session:id @role:id"
let unchanged = ChatUserMentions.decorate(NSAttributedString(string: literal), repository: "Innei/lody-ios", traits: .current)
precondition(unchanged.string == literal, "Code, URLs, emails, escaped text and other mention types stay literal")
let localNumber = ChatUserMentions.decorate(NSAttributedString(string: "#30"), repository: "", traits: .current)
precondition(localNumber.string == "#30", "A number cannot link to a repository outside this session")
let punctuation = ChatUserMentions.decorate(NSAttributedString(string: "@file.swift, then @Dockerfile."), repository: "", traits: .current)
precondition(punctuation.string.replacingOccurrences(of: "\u{FFFC}\u{00a0}", with: "") == "@file.swift, then @Dockerfile.", "Reference styling preserves adjacent punctuation")
let longPath = "@src/" + String(repeating: "long-segment/", count: 12) + "View.swift"
mentionView.setText(ChatUserMentions.decorate(NSAttributedString(string: longPath, attributes: [.font: UIFont.systemFont(ofSize: 17)]), repository: "", traits: .current))
let mentionSize = mentionView.sizeThatFits(CGSize(width: 180, height: 1000))
precondition(mentionSize.width <= 181 && mentionSize.height > 44, "Long file references wrap within the message width")
print("User mentions: rich labels, file and GitHub targets, VoiceOver actions, wrapping and literal-text boundaries passed")

struct LodyListRow {
  var parent = false
  var imageTint = ""
  var unread = false
}

// A partially offscreen text view must retain every line when scrolling exposes it.
let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
let view = CKTextView(frame: CGRect(x: 0, y: 350, width: 350, height: 600))
window.addSubview(view)
view.setText(NSAttributedString(string: (1...20).map { "Line \($0): scrolling keeps this content" }.joined(separator: "\n"), attributes: [.font: UIFont.systemFont(ofSize: 17), .foregroundColor: UIColor.black]))
@MainActor func draw() -> Data {
  UIGraphicsImageRenderer(size: view.bounds.size).image { context in
    UIColor.white.setFill()
    context.fill(view.bounds)
    view.draw(view.bounds)
  }.pngData()!
}
let initiallyClipped = draw()
view.frame.origin.y = 0
let exposedByScrolling = draw()
precondition(initiallyClipped == exposedByScrolling, "Text drawing must not depend on the current scroll position")
print("Chat render: offscreen lines remain drawn across scrolling")

let shineView = CKTextView(frame: CGRect(x: 0, y: 0, width: 200, height: 20))
window.addSubview(shineView)
shineView.setText(NSAttributedString(string: "正在处理", attributes: [
  .font: UIFont.systemFont(ofSize: 13),
  .foregroundColor: UIColor.systemBlue,
]))
@MainActor func shineSnapshot() -> Data {
  UIGraphicsImageRenderer(size: shineView.bounds.size).image { context in
    UIColor.white.setFill()
    context.fill(shineView.bounds)
    shineView.draw(shineView.bounds)
  }.pngData()!
}
shineView.setShine(false)
let rest = shineSnapshot()
shineView.setShine(true)
// Sample a full cycle: its offscreen phase can legitimately match resting text.
let frames = (0..<10).map { _ in
  Thread.sleep(forTimeInterval: 0.16)
  return shineSnapshot()
}
if !UIAccessibility.isReduceMotionEnabled {
  precondition(frames.contains { $0 != rest }, "Shine must change glyph brightness")
  precondition(Set(frames).count > 1, "Shine must travel across glyphs")
}
shineView.setShine(false)
let still = shineSnapshot()
Thread.sleep(forTimeInterval: 0.4)
precondition(still == shineSnapshot(), "Completed process text must stay still")
print("Chat render: process shine travels across running glyphs")

let durationRow = ChatRow(
  id: "turn:duration",
  entryID: "reply",
  kind: "duration",
  text: "Processing for " + ChatWorkDuration.label(3_000),
  running: true,
  workDurationMs: 3_000
)
precondition(!durationRow.shines, "The duration label must stay static")
precondition(ChatReadingColumn.cellMargin == 16, "Chat rows must use the 16 pt reading margin")

let railTraits = window.traitCollection
let processRow = ChatRow(
  id: "done:duration",
  entryID: "done",
  kind: "duration",
  text: "Processed for " + ChatWorkDuration.label(64_000),
  actionable: true,
  workDurationMs: 64_000,
  detail: "Ran 2 commands · Read 3 files",
  treeDown: true
)
let processHeight = ChatCell.processHeight(for: processRow, width: 358, traits: railTraits)
precondition(processHeight >= LodyDesign.Rail.primaryHeight, "A two-line process row must be at least 52 pt, got \(processHeight)")
let processCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 358, height: processHeight))
window.addSubview(processCell)
processCell.configure(processRow, text: NSAttributedString(string: processRow.text))
processCell.layoutIfNeeded()
let railCenter = LodyDesign.Rail.center - ChatReadingColumn.cellMargin
let railText = LodyDesign.Rail.text - ChatReadingColumn.cellMargin
precondition(processCell.processGlyph.isHidden, "A finished process must hide the done glyph")
precondition(processCell.processTitle.frame.minX == 0, "A completed process without a glyph starts at the text edge")
precondition(processCell.label.isHidden && processCell.numericText.isHidden, "The rail row replaces the plain duration label")
precondition(processCell.processDetail.text == processRow.detail && processCell.processDetail.numberOfLines == 1,
  "Line two must show the process summary on one line")
precondition(processCell.processDetail.frame.minY >= processCell.processTitle.frame.maxY - 0.5,
  "Line two must sit below line one")
precondition(processCell.processDetail.frame.minX == processCell.processTitle.frame.minX, "Both lines share the text column")
let titleText = processCell.processTitle.attributedText!
let titleFont = titleText.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
let titleWeight = (titleFont.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
let titleSize = LodyDesign.mono(12, compatibleWith: processCell.traitCollection).pointSize
precondition(abs(titleFont.pointSize - titleSize) < 0.1 && abs(titleWeight) < 0.01
  && titleFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace),
  "The whole process title uses regular 12 pt mono")
let durationLabel = ChatWorkDuration.label(64_000)
let durationRange = (titleText.string as NSString).range(of: durationLabel, options: .backwards)
precondition(durationRange.location != NSNotFound, "Line one must carry the duration")
let durationRunFont = titleText.attribute(.font, at: durationRange.location, effectiveRange: nil) as! UIFont
precondition(durationRunFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) && abs(durationRunFont.pointSize - LodyDesign.mono(12, compatibleWith: processCell.traitCollection).pointSize) < 0.1,
  "The duration uses 12 pt mono")
precondition(!processCell.processChevron.isHidden && processCell.processChevron.frame.maxX <= 358,
  "An actionable process row shows a trailing chevron")
let titleWidth = ceil(titleText.boundingRect(with: CGSize(width: processCell.processTitle.bounds.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width)
precondition(abs(processCell.processChevron.frame.minX - min(342, processCell.processTitle.frame.minX + titleWidth + 2)) < 1,
  "The chevron follows the title rather than the row edge: \(processCell.processChevron.frame) title \(processCell.processTitle.frame), measured \(titleWidth)")
let separatorColor = UIColor.separator.resolvedColor(with: processCell.traitCollection).cgColor
precondition(!processCell.contentView.subviews.contains {
  !$0.isHidden && $0.backgroundColor?.resolvedColor(with: processCell.traitCollection).cgColor == separatorColor
}, "The process row draws no hairline")
precondition(processCell.processTree.path == nil, "A completed process without a glyph has no rail trunk")
precondition(processCell.accessibilityLabel == processRow.text + ", " + processRow.detail,
  "VoiceOver reads both process lines")

let liveHeight = ChatCell.processHeight(for: durationRow, width: 358, traits: railTraits)
precondition(liveHeight >= 44 && liveHeight < processHeight, "A one-line process row stays one line tall")
let liveCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 358, height: liveHeight))
window.addSubview(liveCell)
liveCell.configure(durationRow, text: NSAttributedString(string: durationRow.text))
liveCell.layoutIfNeeded()
precondition(liveCell.processGlyph.kind == .live, "A running process draws the live glyph")
precondition(liveCell.processChevron.isHidden, "A process row that cannot open hides the chevron")
precondition(liveCell.processDetail.isHidden, "A process row without a summary hides line two")
precondition(liveCell.processTree.path == nil, "A process row without sub-agents draws no trunk")
precondition(abs(liveCell.processTitle.frame.maxY - (liveHeight - ChatRowPadding.durationTextBottom)) < 1,
  "Process text sits low: clear of the message above, close to the reply below")
var waitingRow = processRow
waitingRow.attention = true
liveCell.configure(waitingRow, text: NSAttributedString(string: waitingRow.text))
precondition(liveCell.processGlyph.kind == .attention, "A process that needs attention draws the attention glyph")
for style in [UIUserInterfaceStyle.light, .dark] {
  for category in [UIContentSizeCategory.large, .accessibilityLarge] {
    let traits = UITraitCollection(traitsFrom: [UITraitCollection(userInterfaceStyle: style), UITraitCollection(preferredContentSizeCategory: category)])
    for row in [processRow, durationRow, waitingRow] {
      let title = ChatCell.processTitle(row, traits: traits)
      title.enumerateAttributes(in: NSRange(location: 0, length: title.length)) { attributes, _, _ in
        let font = attributes[.font] as! UIFont
        precondition(font == LodyDesign.mono(12, compatibleWith: traits), "Every status and duration run uses the same regular mono face")
        let color = attributes[.foregroundColor] as! UIColor
        precondition(color.resolvedColor(with: traits) == UIColor.lodySecondary.resolvedColor(with: traits))
      }
      let cell = ChatCell(frame: CGRect(x: 0, y: 0, width: 358, height: ChatCell.processHeight(for: row, width: 358, traits: traits)))
      window.addSubview(cell)
      cell.traitOverrides.preferredContentSizeCategory = category
      cell.overrideUserInterfaceStyle = style
      cell.configure(row, text: title)
      cell.setNeedsLayout()
      cell.layoutIfNeeded()
      precondition(cell.processTitle.frame.height == ceil(LodyDesign.mono(12, compatibleWith: cell.traitCollection).lineHeight),
        "Process layout measures the same font it renders")
    }
  }
}
print("Chat render: process rows draw the rail glyph, two lines, chevron and sub-agent trunk")

let answerRow = ChatRow(id: "reply:answer", entryID: "reply", kind: "text", text: "计时完成。")
precondition(
  ChatRowPadding.top(kind: "text", previousKind: "duration") == ChatRowPadding.textBelowDuration,
  "Body copy right under the process row keeps the ordinary inset"
)
precondition(
  ChatCell.rowExtra(for: answerRow, previousKind: "duration")
    == ChatRowPadding.textBelowDuration + ChatRowPadding.content,
  "A text row after duration must grow by that inset, not the 44 pt button floor"
)
precondition(
  ChatCell.rowExtra(for: answerRow, previousKind: "summary") == ChatRowPadding.content * 2,
  "Ordinary body copy keeps the compact text padding"
)
print("Chat render: text below the duration rule uses a paragraph inset")

func resolved(_ color: UIColor?, traits: UITraitCollection) -> CGColor? {
  color?.resolvedColor(with: traits).cgColor
}

let thoughtRow = ChatRow(
  id: "reply:thought",
  entryID: "reply",
  kind: "thought",
  text: "思考过程",
  symbol: "brain"
)
let thoughtCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
window.addSubview(thoughtCell)
thoughtCell.configure(thoughtRow, text: NSAttributedString(string: thoughtRow.text, attributes: [
  .font: UIFont.systemFont(ofSize: 15),
]))
thoughtCell.layoutIfNeeded()
precondition(thoughtCell.icon.frame.minX >= 2, "Thought icon must inset from the clipped leading edge")
precondition(thoughtCell.icon.frame.width >= 20, "Thought icon slot must fit the brain symbol")
precondition(thoughtCell.icon.frame.maxX <= ChatCell.leading(thoughtRow),
  "Thought icon must stay inside the reserved leading gutter")
precondition((thoughtCell.icon.image?.size.width ?? .greatestFiniteMagnitude) <= thoughtCell.icon.bounds.width,
  "Thought icon must not overflow its slot")
let toolRow = ChatRow(
  id: "reply:read",
  entryID: "reply",
  kind: "tool_call",
  text: "读取文件",
  symbol: "doc.text.magnifyingglass"
)
let toolCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
window.addSubview(toolCell)
toolCell.configure(toolRow, text: NSAttributedString(string: toolRow.text, attributes: [
  .font: UIFont.systemFont(ofSize: 13),
]))
toolCell.layoutIfNeeded()
let thoughtWidth = thoughtCell.icon.image?.size.width ?? .greatestFiniteMagnitude
let toolWidth = toolCell.icon.image?.size.width ?? 0
precondition(abs(thoughtWidth - toolWidth) <= 2,
  "Thought and tool icons must share the same optical size, thought=\(thoughtWidth) tool=\(toolWidth)")
print("Chat render: thought icon stays inside the leading gutter")

let runningToolRow = ChatRow(
  id: "reply:running-read",
  entryID: "reply",
  kind: "tool_call",
  text: "正在读取文件",
  symbol: "doc.text.magnifyingglass",
  running: true
)
let runningToolCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
window.addSubview(runningToolCell)
runningToolCell.configure(runningToolRow, text: NSAttributedString(string: runningToolRow.text, attributes: [
  .font: UIFont.systemFont(ofSize: 13),
  .foregroundColor: UIColor.secondaryLabel,
]))
runningToolCell.layoutIfNeeded()
precondition(runningToolRow.shines, "A running process detail must shine")
precondition(
  !runningToolCell.contentView.subviews.contains { $0 is UIActivityIndicatorView },
  "A running process detail must not retain the old spinner"
)
precondition(
  ChatCell.textWidth(runningToolRow, width: 320) == 320 - ChatCell.leading(runningToolRow),
  "Process text must reclaim the trailing spinner slot"
)
print("Chat render: process details replace spinners with traveling text shine")

func summaryRow(running: Bool, attention: Bool) -> ChatRow {
  ChatRow(
    id: "reply:process",
    entryID: "reply",
    kind: "summary",
    text: "执行过程",
    symbol: ChatProcessSummary.mark(attention: attention),
    actionable: true,
    running: running,
    attention: attention
  )
}

func summaryCell(for row: ChatRow) -> ChatCell {
  let cell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
  window.addSubview(cell)
  cell.configure(row, text: NSAttributedString(string: row.text, attributes: [
    .font: UIFont.systemFont(ofSize: 13),
  ]))
  cell.layoutIfNeeded()
  return cell
}

let runningSummary = summaryCell(for: summaryRow(running: true, attention: false))
let doneSummary = summaryCell(for: summaryRow(running: false, attention: false))
let failedSummary = summaryCell(for: summaryRow(running: false, attention: true))
let failedLiveSummary = summaryCell(for: summaryRow(running: true, attention: true))
let traits = runningSummary.traitCollection
precondition(runningSummary.icon.image == nil && doneSummary.icon.image == nil, "A healthy process shows no pip")
precondition(ChatCell.leading(doneSummary.row!) == 0, "Without a pip the summary starts at the text edge")
precondition(resolved(failedSummary.icon.tintColor, traits: traits) == resolved(.secondaryLabel, traits: traits),
  "A process waiting on permission has a neutral mark (no orange in a conversation)")
precondition(runningSummary.row!.shines, "A live process pip must shine")
precondition(!doneSummary.row!.shines, "A finished process must not shine")
precondition(failedLiveSummary.row!.shines, "A live process with a failed tool must keep the shine")
precondition(failedLiveSummary.row!.symbol == "exclamationmark.triangle.fill",
  "A live process with a failed tool must use a warning mark")
precondition(failedSummary.row!.symbol == "exclamationmark.triangle.fill",
  "A failed process must use a warning mark")
precondition(runningSummary.row!.symbol.isEmpty, "A healthy live process carries no pip")
let warnMark = UIImage(
  systemName: "exclamationmark.triangle.fill",
  withConfiguration: ChatCell.iconSymbolConfiguration(for: failedLiveSummary.row!)
)
precondition(
  failedLiveSummary.icon.image?.pngData() == warnMark?.pngData(),
  "The leading mark must draw the warning symbol, not the pip"
)
precondition(resolved(failedLiveSummary.icon.tintColor, traits: traits) == resolved(.secondaryLabel, traits: traits),
  "The warning mark stays neutral")

precondition((failedLiveSummary.icon.image?.size.width ?? .greatestFiniteMagnitude) < (thoughtCell.icon.image?.size.width ?? 0),
  "The warning mark must stay in the process pip scale")
precondition(ChatCell.leading(failedSummary.row!) == railText, "A summary with a mark starts at the rail text column")
precondition(abs(failedSummary.icon.frame.midX - railCenter) < 0.5, "The summary mark must sit on the rail center")
precondition(failedSummary.icon.frame.width == 8, "The process mark slot stays 8 points")
precondition(abs(doneSummary.icon.frame.midY - doneSummary.label.frame.midY) <= 0.5,
  "The process pip must sit on the text baseline")
precondition(doneSummary.label.frame.minX == 0, "A summary without a mark starts at the text edge")
precondition(!doneSummary.processChevron.isHidden && doneSummary.processChevron.frame.minX > doneSummary.label.frame.minX,
  "Summary rows open the activity through a trailing chevron")
precondition(ChatCell.messageFont(for: doneSummary.row!, compatibleWith: traits).pointSize == 12.5 * UIFont.dynamicScale(compatibleWith: traits),
  "Summary rows use 12.5 pt text")

let wrappedSummary = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
window.addSubview(wrappedSummary)
wrappedSummary.configure(
  summaryRow(running: false, attention: false),
  text: NSAttributedString(
    string: "思考过程 · 调用了 2 个命令 · 阅读了 2 个文件 · 编辑了 2 个文件 · 进行了 1 次搜索",
    attributes: [.font: UIFont.systemFont(ofSize: 13)]
  )
)
wrappedSummary.layoutIfNeeded()
let wrappedLines = wrappedSummary.label.lineAdvances(width: wrappedSummary.label.bounds.width)
precondition(wrappedLines.count > 1, "The wrapped process title fixture must occupy more than one line")
let firstLineCenter = wrappedSummary.label.frame.minY + wrappedLines[0] / 2
precondition(
  abs(wrappedSummary.icon.frame.midY - firstLineCenter) <= 0.5,
  "The process pip must sit on the first line of wrapped text"
)
precondition(
  abs(wrappedSummary.icon.frame.midY - wrappedSummary.label.frame.midY) > 0.5,
  "The process pip must not center on the whole wrapped block"
)

precondition(
  !runningSummary.icon.lastReplaceAnimated && !failedLiveSummary.icon.lastReplaceAnimated,
  "The first process mark must appear without a replace transition"
)
let markSwap = summaryCell(for: summaryRow(running: true, attention: false))
precondition(!markSwap.icon.lastReplaceAnimated, "A newly bound process pip must not animate in")
let warningSwap = summaryRow(running: true, attention: true)
let warningSwapText = NSAttributedString(string: warningSwap.text, attributes: [
  .font: UIFont.systemFont(ofSize: 13),
])
markSwap.configure(warningSwap, text: warningSwapText)
markSwap.layoutIfNeeded()
// A healthy summary has no image to replace; adding attention must show the mark.
markSwap.configure(warningSwap, text: warningSwapText)
precondition(
  markSwap.icon.image?.pngData() == warnMark?.pngData(),
  "The leading mark must finish on the warning symbol"
)
precondition(
  resolved(markSwap.icon.tintColor, traits: traits) == resolved(.secondaryLabel, traits: traits),
  "The animated warning mark stays neutral"
)
let reusedMark = summaryCell(for: summaryRow(running: true, attention: false))
reusedMark.prepareForReuse()
reusedMark.configure(warningSwap, text: warningSwapText)
reusedMark.layoutIfNeeded()
precondition(!reusedMark.icon.lastReplaceAnimated, "Reuse must not play the pip-to-warning transition")
precondition(
  reusedMark.icon.image?.pngData() == warnMark?.pngData(),
  "Reuse must still draw the warning symbol"
)
print("Chat render: process status pip uses running, done and attention colors")

func glyphWidth(_ font: UIFont, _ text: String) -> CGFloat {
  (text as NSString).size(withAttributes: [.font: font]).width
}

let durationFont = ChatCell.messageFont(for: durationRow, compatibleWith: traits)
let summaryFont = ChatCell.messageFont(for: doneSummary.row!, compatibleWith: traits)
let userFont = ChatCell.messageFont(
  for: ChatRow(id: "user", entryID: "user", kind: "user", text: "hi"),
  compatibleWith: traits
)
precondition(glyphWidth(durationFont, "1") == glyphWidth(durationFont, "8"),
  "Duration digits must keep a fixed width")
precondition(glyphWidth(durationFont, "0") == glyphWidth(durationFont, "8"),
  "Duration digits must keep a fixed width")
precondition(glyphWidth(summaryFont, "1") == glyphWidth(summaryFont, "8"),
  "Process-count digits must keep a fixed width")
precondition(glyphWidth(userFont, "1") < glyphWidth(userFont, "8"),
  "User messages keep proportional digits")
print("Chat render: duration and process counts use tabular digits")

// A long send lands at its source viewport height without discarding text.
let longBody = (1...18).map { "Line \($0): a complete message remains available after sending." }.joined(separator: "\n")
let longRow = ChatRow(id: "long:user", entryID: "long", kind: "user", text: longBody)
let longCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 350, height: 164))
window.addSubview(longCell)
longCell.collapsedHeight = 140
longCell.configure(longRow, text: NSAttributedString(string: longBody, attributes: [.font: UIFont.systemFont(ofSize: 17)]))
longCell.layoutIfNeeded()
precondition(longCell.messageContent.bounds.height == 140 && longCell.label.layer.mask != nil,
  "Long messages must land in the composer viewport with a text-only fade")
precondition(longCell.label.attributedTextValue.string == longBody && longCell.expandable,
  "Folding must preserve all text for expansion and copying")
longCell.expanded = true
longCell.setNeedsLayout()
longCell.layoutIfNeeded()
precondition(longCell.messageContent.bounds.height > 140 && longCell.label.layer.mask == nil,
  "Expanding must expose the complete message and remove the fade")
precondition(longCell.messageContent.disclosure.bounds.height >= 44,
  "Expanded messages must keep an accessible collapse target")
longCell.expanded = false
let narrowBody = Array(repeating: "x", count: 20).joined(separator: "\n")
longCell.configure(ChatRow(id: "narrow:user", entryID: "narrow", kind: "user", text: narrowBody),
  text: NSAttributedString(string: narrowBody, attributes: [.font: UIFont.systemFont(ofSize: 17)]))
longCell.layoutIfNeeded()
precondition(longCell.messageContent.disclosure.bounds.width >= longCell.messageContent.disclosure.intrinsicContentSize.width,
  "A narrow multiline message must still have room for its expansion affordance")
longCell.configure(ChatRow(id: "short:user", entryID: "short", kind: "user", text: "hello"),
  text: NSAttributedString(string: "hello", attributes: [.font: UIFont.systemFont(ofSize: 17)]))
longCell.layoutIfNeeded()
precondition(longCell.messageContent.bounds.height < 68 && !longCell.expandable && longCell.label.layer.mask == nil,
  "Reusing a folded cell for a short message must restore its natural height and clear the mask")
print("Chat send: bounded landing, complete expansion, accessible collapse and short-message reuse passed")

let retryCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
retryCell.configure(ChatRow(id: "failed:pending", entryID: "failed", kind: "pending", text: "Retry", actionable: true), text: NSAttributedString(string: "Retry"))
retryCell.layoutIfNeeded()
var activatedRetry = false
retryCell.onActivate = { activatedRetry = true }
precondition(retryCell.accessibilityActivate() && activatedRetry, "Accessible status rows must invoke their retry/reconnect action")
print("Chat render: accessible status actions remain available with expandable messages")

let metaFont = UIFont.preferredFont(forTextStyle: .footnote)
let providerMark = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { _ in
  UIColor.black.setFill()
  UIRectFill(CGRect(x: 0, y: 0, width: 24, height: 24))
}.withRenderingMode(.alwaysTemplate)
let marked = ChatMetaCell.attributedText("GPT-5.6 Sol · High", image: providerMark, font: metaFont)
var metaAttachment: NSTextAttachment?
marked.enumerateAttribute(.attachment, in: NSRange(location: 0, length: marked.length)) { value, _, _ in
  if let attachment = value as? NSTextAttachment { metaAttachment = attachment }
}
precondition(metaAttachment != nil, "A known provider mark sits on the model line")
let markSize = metaFont.pointSize - 2
precondition(abs((metaAttachment?.bounds.height ?? 0) - markSize) < 0.01, "The mark is 2 pt smaller than the meta type")
precondition(
  abs((metaAttachment?.bounds.minY ?? 0) - (metaFont.capHeight - markSize) / 2) < 0.01,
  "The mark centers on the cap height so it does not sit flush with the type"
)
precondition(
  marked.string.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespaces) == "GPT-5.6 Sol · High"
)
let unmarked = ChatMetaCell.attributedText("id-only", image: nil, font: metaFont)
var unmarkedAttachment = false
unmarked.enumerateAttribute(.attachment, in: NSRange(location: 0, length: unmarked.length)) { value, _, _ in
  if value is NSTextAttachment { unmarkedAttachment = true }
}
precondition(unmarked.string == "id-only" && !unmarkedAttachment, "Unknown models stay text-only")
var metaRow = ChatRow(id: "reply:meta", entryID: "reply", kind: "meta", text: "GPT-5.6 Sol · High")
metaRow.imageAsset = "lody-agent-openai"
let metaCell = ChatMetaCell(frame: CGRect(x: 0, y: 0, width: 320, height: 32))
metaCell.detailsButton.isHidden = true
window.addSubview(metaCell)
metaCell.configure(metaRow)
func modelLabel(_ root: UIView) -> UILabel? {
  if let label = root as? UILabel, label.accessibilityIdentifier == "reply:meta:model" { return label }
  return root.subviews.compactMap(modelLabel).first
}
precondition(modelLabel(metaCell)?.accessibilityLabel == "GPT-5.6 Sol · High", "VoiceOver reads the model line without the mark")

func lowestInkRow(_ image: UIImage) -> Int {
  guard let cgImage = image.cgImage else { return -1 }
  let width = cgImage.width
  let height = cgImage.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  guard let ctx = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return -1 }
  ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
  var last = -1
  for row in 0..<height {
    for column in 0..<width {
      let i = (row * width + column) * 4
      if Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 720 { last = row }
    }
  }
  return last
}

func snapshotCell(_ cell: ChatMetaCell, text: String) -> UIImage {
  let row = ChatRow(id: "reply:meta", entryID: "reply", kind: "meta", text: text)
  cell.detailsButton.isHidden = true
  cell.frame.size.height = ChatMetaCell.height(for: row, width: cell.bounds.width, traits: .current, detailsEnabled: false)
  cell.configure(row)
  cell.backgroundColor = .white
  cell.contentView.backgroundColor = .white
  cell.layoutIfNeeded()
  return UIGraphicsImageRenderer(size: cell.bounds.size).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: cell.bounds.size))
    cell.layer.render(in: context.cgContext)
  }
}

let metaY = snapshotCell(metaCell, text: "Gy")
let metaX = snapshotCell(metaCell, text: "Gx")
precondition(
  lowestInkRow(metaY) >= lowestInkRow(metaX) + Int(metaY.scale * 2),
  "The descender of y on the model line must not be clipped"
)
print("Chat render: meta bar provider marks sit on the model line")

func pixelBuffer(_ image: UIImage) -> (pixels: [UInt8], width: Int, height: Int)? {
  guard let cgImage = image.cgImage else { return nil }
  let width = cgImage.width
  let height = cgImage.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  guard let ctx = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
  return (pixels, width, height)
}

struct ActionInk {
  var minX = Int.max
  var maxX = -1
  var minY = Int.max
  var maxY = -1
  var red = 0
  var green = 0
  var blue = 0
}

func actionInk(_ image: UIImage) -> ActionInk {
  guard let buffer = pixelBuffer(image) else { return ActionInk() }
  var ink = ActionInk()
  var darkest = 765
  for row in 0..<buffer.height {
    for column in 0..<buffer.width {
      let i = (row * buffer.width + column) * 4
      let red = Int(buffer.pixels[i])
      let green = Int(buffer.pixels[i + 1])
      let blue = Int(buffer.pixels[i + 2])
      let sum = red + green + blue
      if sum >= 720 { continue }
      ink.minX = min(ink.minX, column)
      ink.maxX = max(ink.maxX, column)
      ink.minY = min(ink.minY, row)
      ink.maxY = max(ink.maxY, row)
      if sum < darkest {
        darkest = sum
        ink.red = red
        ink.green = green
        ink.blue = blue
      }
    }
  }
  return ink
}

metaCell.frame.size.height = ChatMetaCell.height(for: metaRow, width: 320, traits: .current, detailsEnabled: false)
metaCell.configure(metaRow)
metaCell.layoutIfNeeded()
let actions = metaCell.actionButton
precondition(actions.bounds.width >= 44 && actions.bounds.height >= 44, "Message actions keep a 44 pt target")
let actionShot = UIGraphicsImageRenderer(size: actions.bounds.size).image { context in
  UIColor.white.setFill()
  context.fill(CGRect(origin: .zero, size: actions.bounds.size))
  actions.layer.render(in: context.cgContext)
}
let ink = actionInk(actionShot)
precondition(ink.maxX >= 0, "Message actions draw an ellipsis")
let actionScale = max(1, actionShot.scale)
let glyphWidth = CGFloat(ink.maxX - ink.minX + 1) / actionScale
let trailingPad = actions.bounds.width - CGFloat(ink.maxX + 1) / actionScale
precondition(
  glyphWidth <= metaFont.pointSize + 4,
  "The action glyph is no larger than the model type"
)
precondition(
  trailingPad <= 1,
  "The action glyph sits on the trailing edge so button padding does not inset it from the type"
)
precondition(
  ink.blue <= ink.red + 24 && ink.blue <= ink.green + 24,
  "Message actions use the same color as the model line"
)
print("Chat render: meta bar actions match the model line and sit on the trailing edge")

final class FoldSizes: NSObject, UICollectionViewDelegateFlowLayout {
  var source: UICollectionViewDiffableDataSource<String, String>?
  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    CGSize(width: 320, height: source?.itemIdentifier(for: indexPath) == "answer" ? 200 : 44)
  }
}
let foldCollection = UICollectionView(frame: window.bounds, collectionViewLayout: ChatCollectionLayout())
let foldSizes = FoldSizes()
foldCollection.delegate = foldSizes
foldCollection.register(ChatMetaCell.self, forCellWithReuseIdentifier: "meta")
foldCollection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
let foldSource = UICollectionViewDiffableDataSource<String, String>(collectionView: foldCollection) { collection, index, id in
  guard id == metaRow.id else { return collection.dequeueReusableCell(withReuseIdentifier: "row", for: index) }
  let cell = collection.dequeueReusableCell(withReuseIdentifier: "meta", for: index) as! ChatMetaCell
  cell.configure(metaRow)
  return cell
}
foldSizes.source = foldSource
window.addSubview(foldCollection)
window.isHidden = false
var liveReply = NSDiffableDataSourceSnapshot<String, String>()
liveReply.appendSections(["reply"])
liveReply.appendItems(["duration", "tool-1", "tool-2", "answer"])
foldSource.apply(liveReply, animatingDifferences: false)
foldCollection.layoutIfNeeded()
CATransaction.flush()
var foldedReply = NSDiffableDataSourceSnapshot<String, String>()
foldedReply.appendSections(["reply"])
foldedReply.appendItems(["duration", "answer", metaRow.id])
UIView.animate(withDuration: 0.22) {
  foldSource.apply(foldedReply, animatingDifferences: true)
  foldCollection.collectionViewLayout.invalidateLayout()
  foldCollection.layoutIfNeeded()
}
@MainActor func travel(_ id: String) -> CGFloat {
  let cell = foldCollection.cellForItem(at: foldSource.indexPath(for: id)!)!
  let animation = cell.layer.animation(forKey: "position") as? CABasicAnimation
  return (animation?.fromValue as? CGPoint)?.y ?? 0
}
precondition(travel("answer") > 0, "The regression check must fold process rows above the answer")
precondition(travel(metaRow.id) == travel("answer"),
  "New metadata must travel with the answer above it, not slide over it during reply completion")
foldCollection.removeFromSuperview()
print("Chat render: metadata inserted by completion folding travels with its answer")

func processAttributed(_ string: String, row: ChatRow, traits: UITraitCollection) -> NSAttributedString {
  let font = ChatCell.messageFont(for: row, compatibleWith: traits)
  let lineHeight = 18 * UIFont.dynamicScale(compatibleWith: traits)
  let paragraph = NSMutableParagraphStyle()
  if row.kind == "delivery" { paragraph.alignment = .right }
  paragraph.minimumLineHeight = lineHeight
  paragraph.maximumLineHeight = lineHeight
  return NSAttributedString(string: string, attributes: [
    .font: font,
    .foregroundColor: UIColor.secondaryLabel,
    .paragraphStyle: paragraph,
    .baselineOffset: (lineHeight - font.lineHeight) / 2,
  ])
}

let deliveryRow = ChatRow(
  id: "local-send:delivery",
  entryID: "local-send",
  kind: "delivery",
  text: String(localized: "send.status.awaitingConnection", bundle: .lody)
)
let deliveryText = processAttributed(deliveryRow.text, row: deliveryRow, traits: traits)
let deliveryWidth = ChatCell.textWidth(deliveryRow, width: 320)
let deliveryMeasure = CKTextView()
deliveryMeasure.setText(deliveryText)
let deliveryHeight = deliveryMeasure.sizeThatFits(CGSize(width: deliveryWidth, height: .greatestFiniteMagnitude)).height
precondition(
  !deliveryRow.text.isEmpty && deliveryHeight >= 18 * UIFont.dynamicScale(compatibleWith: traits) - 0.5,
  "Offline delivery status must measure a visible line, height=\(deliveryHeight) text=\(deliveryRow.text)"
)
let deliveryCellHeight = deliveryHeight + ChatCell.rowExtra(for: deliveryRow)
precondition(
  deliveryCellHeight > 0,
  "Delivery rows must occupy layout space so VoiceOver can find them"
)
let deliveryCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: deliveryCellHeight))
window.addSubview(deliveryCell)
deliveryCell.configure(deliveryRow, text: deliveryText)
deliveryCell.layoutIfNeeded()
precondition(deliveryCell.accessibilityIdentifier == deliveryRow.id)
precondition(deliveryCell.accessibilityLabel == deliveryRow.text)
let reusedMeasure = CKTextView()
reusedMeasure.setText(processAttributed("Offline send", row: ChatRow(id: "local-send:user", entryID: "local-send", kind: "user", text: "Offline send"), traits: traits))
_ = reusedMeasure.sizeThatFits(CGSize(width: deliveryWidth, height: .greatestFiniteMagnitude))
reusedMeasure.setText(deliveryText)
let reusedHeight = reusedMeasure.sizeThatFits(CGSize(width: deliveryWidth, height: .greatestFiniteMagnitude)).height
precondition(
  reusedHeight >= 18 * UIFont.dynamicScale(compatibleWith: traits) - 0.5,
  "A reused measuring view must still size right-aligned delivery, height=\(reusedHeight)"
)
print("Chat render: right-aligned delivery status measures a visible line")

let countRow = ChatRow(
  id: "reply:process",
  entryID: "reply",
  kind: "summary",
  text: "思考过程 · 调用了 2 个工具 · 编辑了 2 个文件",
  symbol: "",
  actionable: true,
  running: true
)
let countText = processAttributed(countRow.text, row: countRow, traits: traits)
let countWidth = ChatCell.textWidth(countRow, width: 320)
let measureKit = CKTextView()
measureKit.setText(countText)
let textKitHeight = measureKit.sizeThatFits(CGSize(width: countWidth, height: .greatestFiniteMagnitude)).height
let numericHost = ChatNumericTextHost(frame: CGRect(x: 0, y: 0, width: countWidth, height: 8))
window.addSubview(numericHost)
numericHost.apply(text: countText, animated: false, shines: false)
let hostHeight = numericHost.sizeThatFits(CGSize(width: countWidth, height: .greatestFiniteMagnitude)).height
precondition(
  hostHeight <= textKitHeight + 0.5,
  "SwiftUI process text must not measure taller than TextKit, host=\(hostHeight) text=\(textKitHeight)"
)

let shortText = processAttributed("思考过程", row: countRow, traits: traits)
let shortWidth = ceil(shortText.boundingRect(
  with: CGSize(width: countWidth, height: .greatestFiniteMagnitude),
  options: [.usesLineFragmentOrigin, .usesFontLeading],
  context: nil
).width)
let shortHost = ChatNumericTextHost(frame: CGRect(x: 0, y: 0, width: countWidth, height: textKitHeight))
window.addSubview(shortHost)
shortHost.apply(text: shortText, animated: false, shines: false)
shortHost.layoutIfNeeded()
let countTextWidth = ceil(countText.boundingRect(
  with: CGSize(width: countWidth, height: .greatestFiniteMagnitude),
  options: [.usesLineFragmentOrigin, .usesFontLeading],
  context: nil
).width)
let suffixWidth = min(80, countTextWidth)
numericHost.frame.size.height = textKitHeight
numericHost.layoutIfNeeded()
@MainActor func processSnapshot(_ host: ChatNumericTextHost, x: CGFloat, width: CGFloat) -> Data {
  let size = CGSize(width: width, height: host.bounds.height)
  return UIGraphicsImageRenderer(size: size).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: size))
    context.cgContext.translateBy(x: -x, y: 0)
    host.layer.render(in: context.cgContext)
  }.pngData()!
}
let shortRest = processSnapshot(shortHost, x: 0, width: shortWidth)
let blankX = shortWidth + 4
let blankRest = processSnapshot(shortHost, x: blankX, width: countWidth - blankX)
let suffixRest = processSnapshot(numericHost, x: countTextWidth - suffixWidth, width: suffixWidth)
shortHost.apply(text: shortText, animated: false, shines: true)
numericHost.apply(text: countText, animated: false, shines: true)
var shortFrames: [Data] = []
var suffixFrames: [Data] = []
for _ in 0..<10 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.16))
  shortFrames.append(processSnapshot(shortHost, x: 0, width: shortWidth))
  precondition(
    processSnapshot(shortHost, x: blankX, width: countWidth - blankX) == blankRest,
    "Shine must not draw a shifted copy of the text in the trailing blank area"
  )
  suffixFrames.append(processSnapshot(numericHost, x: countTextWidth - suffixWidth, width: suffixWidth))
}
func sameProcessPixels(_ image: Data, _ reference: Data) -> Bool {
  let pixels = UIImage(data: image)!.cgImage!.dataProvider!.data! as Data
  let expected = UIImage(data: reference)!.cgImage!.dataProvider!.data! as Data
  // Gradient interpolation can round an unchanged channel by one 8-bit step.
  return pixels.count == expected.count && zip(pixels, expected).allSatisfy { abs(Int($0) - Int($1)) <= 1 }
}
if !UIAccessibility.isReduceMotionEnabled {
  precondition(shortFrames.contains { $0 != shortRest }, "Shine must cross the visible short process title")
  precondition(Set(shortFrames).count > 1, "Shine must travel across the short process title")
  precondition(shortFrames.contains { sameProcessPixels($0, shortRest) }, "Text outside the pale shine keeps its normal color")
  precondition(suffixFrames.contains { $0 != suffixRest }, "Shine must cross the full process row suffix")
  precondition(Set(suffixFrames).count > 1, "Shine must travel through the full process row suffix")
  precondition(suffixFrames.contains { sameProcessPixels($0, suffixRest) }, "The full-row suffix keeps its normal color outside the shine")
}
shortHost.apply(text: shortText, animated: false, shines: false)
numericHost.apply(text: countText, animated: false, shines: false)
let shortStill = processSnapshot(shortHost, x: 0, width: shortWidth)
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
precondition(shortStill == processSnapshot(shortHost, x: 0, width: shortWidth), "Completed SwiftUI process text must stay still")
print("Chat render: SwiftUI shine travels across the full process row")

let attentionText = NSAttributedString(string: "思考过程", attributes: [
  .font: UIFont.systemFont(ofSize: 13),
  .foregroundColor: UIColor.systemOrange,
])
let attentionHost = ChatNumericTextHost(frame: CGRect(x: 0, y: 0, width: countWidth, height: textKitHeight))
window.addSubview(attentionHost)
attentionHost.apply(text: attentionText, animated: false, shines: false)
attentionHost.layoutIfNeeded()
let attentionWidth = ceil(attentionText.boundingRect(
  with: CGSize(width: countWidth, height: .greatestFiniteMagnitude),
  options: [.usesLineFragmentOrigin, .usesFontLeading],
  context: nil
).width)
let attentionRest = processSnapshot(attentionHost, x: 0, width: attentionWidth)
attentionHost.apply(text: attentionText, animated: false, shines: true)
var attentionFrames: [Data] = []
for _ in 0..<10 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.16))
  attentionFrames.append(processSnapshot(attentionHost, x: 0, width: attentionWidth))
}
if !UIAccessibility.isReduceMotionEnabled {
  precondition(attentionFrames.contains { $0 != attentionRest }, "Shine must still travel across yellow failed-tool process text")
  precondition(Set(attentionFrames).count > 1, "Shine must keep moving on yellow failed-tool process text")
  precondition(attentionFrames.contains { sameProcessPixels($0, attentionRest) }, "Yellow process text outside the shine must keep its color")
}
print("Chat render: failed-tool process text stays yellow and keeps the shine")

let countCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
window.addSubview(countCell)
countCell.configure(countRow, text: countText)
countCell.layoutIfNeeded()
precondition(countCell.bounds.height == 44, "A one-line process row stays on the 44-point floor")
precondition(!countCell.numericText.isHidden, "Process rows render through the numeric-text host")
precondition(countCell.label.isHidden, "TextKit process text must not draw under the SwiftUI host")
precondition(
  abs(countCell.numericText.frame.height - countCell.label.frame.height) < 0.5,
  "The numeric-text host must occupy the TextKit label frame"
)
precondition(
  countCell.numericText.frame.maxY <= countCell.bounds.maxY + 0.5,
  "The numeric-text host must not extend the process cell"
)

var nextCount = countRow
nextCount.text = "思考过程 · 调用了 3 个工具 · 编辑了 3 个文件"
countCell.configure(nextCount, text: processAttributed(nextCount.text, row: nextCount, traits: traits))
countCell.layoutIfNeeded()
precondition(countCell.bounds.height == 44, "Incrementing tabular counts must not grow the process cell")
precondition(
  abs(countCell.numericText.frame.height - countCell.label.frame.height) < 0.5,
  "Count updates must keep the host inside the TextKit frame"
)
print("Chat render: process numeric-text host does not raise the row")

func userBubbleCell(_ text: String) -> ChatCell {
  let font = UIFont.systemFont(ofSize: 17)
  let cell = ChatCell(frame: CGRect(x: 0, y: 0, width: 350, height: 80))
  window.addSubview(cell)
  cell.configure(
    ChatRow(id: "bubble:\(text)", entryID: "bubble", kind: "user", text: text),
    text: NSAttributedString(string: text, attributes: [.font: font])
  )
  cell.layoutIfNeeded()
  return cell
}

let glyphBubble = userBubbleCell("1").messageContent.bubble
let glyphMinSide = min(glyphBubble.bounds.width, glyphBubble.bounds.height)
precondition(glyphMinSide > 0 && glyphMinSide < ChatMessageContent.bubbleRadius * 2,
  "A one-glyph bubble must be smaller than two full corners")
precondition(glyphBubble.layer.cornerCurve == .circular,
  "A short user bubble must stay round, not pointed")
precondition(glyphBubble.layer.cornerRadius <= glyphMinSide / 2 + 0.01,
  "A short user bubble's radius must fit inside its bounds")

let wideBubble = userBubbleCell("看看 ci 的 tf 过了嘛").messageContent.bubble
precondition(wideBubble.layer.cornerCurve == .circular,
  "User bubbles use circular corners at every width")
precondition(abs(wideBubble.layer.cornerRadius - ChatMessageContent.bubbleRadius) < 0.01,
  "A wide user bubble keeps the full corner radius")
print("Chat render: short user bubbles stay circular capsules")

func rgba(_ color: UIColor, style: UIUserInterfaceStyle) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
  var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
  color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&r, green: &g, blue: &b, alpha: &a)
  return (r, g, b, a)
}

func sameRGB(_ lhs: (CGFloat, CGFloat, CGFloat, CGFloat), _ rhs: (CGFloat, CGFloat, CGFloat, CGFloat)) -> Bool {
  abs(lhs.0 - rhs.0) < 0.001 && abs(lhs.1 - rhs.1) < 0.001 && abs(lhs.2 - rhs.2) < 0.001
}

for style in [UIUserInterfaceStyle.light, .dark] {
  let bubble = rgba(.lodyUserBubble, style: style)
  precondition(sameRGB(bubble, rgba(.lodyInset, style: style)) && bubble.3 == 1, "User bubbles share the inset fill: \(style.rawValue)")
}
let glyphFill = glyphBubble.backgroundColor!.resolvedColor(with: glyphBubble.traitCollection)
precondition(glyphFill == UIColor.lodyInset.resolvedColor(with: glyphBubble.traitCollection), "The on-screen user bubble paints the inset fill")
print("Chat render: user bubbles use the neutral inset fill")

// A member arriving after the message changes the visible identity without changing its text.
var memberRow = ChatRow(id: "member-refresh", entryID: "member-refresh", kind: "user", text: "Existing message")
memberRow.author = "other-user"
memberRow.authorTime = "18:36"
memberRow.readState = "sent"
let memberCell = ChatCell(frame: CGRect(x: 0, y: 0, width: 358, height: 100))
memberCell.configure(memberRow, text: NSAttributedString(string: memberRow.text))
let unresolvedIdentity = memberCell.accessibilityValue
memberRow.authorName = "Alice"
memberCell.configure(memberRow, text: NSAttributedString(string: memberRow.text))
precondition(memberCell.accessibilityValue?.contains("Alice") == true && memberCell.accessibilityValue != unresolvedIdentity)
precondition(memberCell.row?.text == "Existing message")
print("PASS: an existing user message reconfigures with the resolved member identity")

// User actions remain accessible without an inline footer, and stale Edit actions cannot edit.
var editableUserMessage = true
var editedUserMessage = ""
memberCell.canEdit = { editableUserMessage }
memberCell.onEdit = { editedUserMessage = memberRow.entryID }
memberCell.updateEditAccessibility()
let copyUserAction = memberCell.accessibilityCustomActions!.first { $0.name == String(localized: "native.chat.copy", bundle: .lody) }!
precondition(copyUserAction.actionHandler != nil, "User Copy remains accessible without a footer")
let editUserAction = memberCell.accessibilityCustomActions!.first { $0.name == String(localized: "native.chat.editAction", bundle: .lody) }!
precondition(editUserAction.actionHandler!(editUserAction))
precondition(editedUserMessage == memberRow.entryID)
editableUserMessage = false
editedUserMessage = ""
precondition(!editUserAction.actionHandler!(editUserAction))
precondition(editedUserMessage.isEmpty)
memberCell.updateEditAccessibility()
precondition(memberCell.accessibilityCustomActions!.count == 1)
longCell.configure(longRow, text: NSAttributedString(string: longBody, attributes: [.font: userFont]))
longCell.layoutIfNeeded()
precondition(longCell.messageContent.frame.minX >= 0)
precondition(longCell.messageContent.frame.width > longCell.bounds.width * 0.8)
precondition(longCell.messageContent.frame.maxX <= longCell.bounds.width - ChatCell.avatarSlot)
print("PASS: user copy/edit eligibility and wider bubbles preserve the avatar column")

let userMessages = try JSONDecoder().decode([ChatEntry].self, from: Data(#"[{"id":"user-menu","role":"user","status":"completed","finished":true,"items":[{"itemId":"prompt","type":"text","text":"Synthetic prompt"}]}]"#.utf8))
let userRows = ChatTranscript(entries: userMessages).rows()
precondition(userRows.map(\.kind) == ["user"], "User messages expose actions through long press, not an extra footer")
precondition(userRows.first?.text == "Synthetic prompt")

print("PASS: user messages retain text without an inline footer")
