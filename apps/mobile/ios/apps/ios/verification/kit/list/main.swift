import UIKit

let menuButton = UIButton(type: .system)
var menuConfiguration = UIButton.Configuration.plain()
menuConfiguration.attributedTitle = AttributedString("我的超长工作区名称不能折行")
LodyMenuButtonStyle.apply(menuConfiguration, to: menuButton)
assert(menuButton.titleLabel?.numberOfLines == 1, "Workspace menu title must stay on one line")
assert(menuButton.titleLabel?.lineBreakMode == .byTruncatingTail, "Long workspace names must truncate at the tail")
assert(menuButton.configuration?.titleLineBreakMode == .byTruncatingTail, "The button configuration must not restore wrapping")

let letter = LodyMenuButtonStyle.avatarImage(text: "I", fill: .systemIndigo, photo: nil)
let avatarSource = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 40)).image { _ in
  UIColor.red.setFill()
  UIRectFill(CGRect(x: 0, y: 0, width: 80, height: 40))
}
let loaded = LodyMenuButtonStyle.avatarImage(
  text: "I", fill: .systemIndigo, photo: LodyListPhoto.circular(avatarSource)
)
assert(letter.size.width == LodyMenuButtonStyle.avatarSide)
assert(loaded.size.width == LodyMenuButtonStyle.avatarSide)
assert(letter.pngData() != loaded.pngData(), "An account photo must replace the letter fallback")
assert(LodyMenuButtonStyle.trailingInset > 4, "The workspace name needs room after the last glyph")

let shortMenu = UIButton(type: .system)
LodyMenuButtonStyle.apply(label: "Innei", avatar: letter, to: shortMenu)
let shortWidth = LodyMenuButtonStyle.unconstrainedWidth(for: shortMenu)

let longMenu = UIButton(type: .system)
LodyMenuButtonStyle.apply(label: "我的超长工作区名称不能折行", avatar: letter, to: longMenu)
let longWidth = LodyMenuButtonStyle.unconstrainedWidth(for: longMenu)
assert(longWidth > 200, "The long fixture must exceed the old width cap")
LodyMenuButtonStyle.apply(label: "Innei", avatar: loaded, to: shortMenu)
assert(abs(LodyMenuButtonStyle.unconstrainedWidth(for: shortMenu) - shortWidth) < 1,
       "Loading the avatar must not resize the workspace button")

func ink(_ image: UIImage) -> CGFloat {
  let width = Int(image.size.width.rounded(.up) * 3), height = Int(image.size.height.rounded(.up) * 3)
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  pixels.withUnsafeMutableBytes { bytes in
    let context = CGContext(
      data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.scaleBy(x: 3, y: 3)
    UIGraphicsPushContext(context)
    image.withRenderingMode(.alwaysTemplate).withTintColor(.black).draw(at: .zero)
    UIGraphicsPopContext()
  }
  return stride(from: 3, to: pixels.count, by: 4).reduce(CGFloat(0)) { $0 + CGFloat(pixels[$1]) } / 255 / 9
}

let boldChevron = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold))!

func alpha(of image: UIImage, at point: CGPoint) -> UInt8 {
  var pixel = [UInt8](repeating: 0, count: 4)
  pixel.withUnsafeMutableBytes { bytes in
    let context = CGContext(
      data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    UIGraphicsPushContext(context)
    image.draw(at: CGPoint(x: -point.x, y: -point.y))
    UIGraphicsPopContext()
  }
  return pixel[3]
}

assert(LodyMenuButtonStyle.avatarSide == 32, "The workspace monogram is a 32 pt square")
let squareAvatar = LodyMenuButtonStyle.avatarImage(text: "I", fill: .lodyInk, foreground: .white, photo: nil)
assert(alpha(of: squareAvatar, at: CGPoint(x: 4, y: 4)) < 60, "The monogram is a circle that echoes the capsule")
assert(alpha(of: squareAvatar, at: CGPoint(x: 16, y: 1.5)) > 200 && alpha(of: squareAvatar, at: CGPoint(x: 1.5, y: 16)) > 200,
       "The circle fills the avatar side")
let headerMenu = UIButton(type: .system)
LodyMenuButtonStyle.apply(label: "Innei", detail: "3 machines · 2 running", avatar: squareAvatar, to: headerMenu)
let headerDetail = NSAttributedString(headerMenu.configuration!.attributedSubtitle!)
assert(headerDetail.string == "3 machines · 2 running", "The status line sits under the workspace name")
let headerDetailFont = headerDetail.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
assert(headerDetailFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "The status line is monospaced")
let headerTitle = NSAttributedString(headerMenu.configuration!.attributedTitle!)
assert(headerTitle.string.hasPrefix("Innei"))
let headerTitleFont = headerTitle.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
let headerWeight = (headerTitleFont.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat
assert(abs(headerTitleFont.pointSize - 17) <= 0.5 && (headerWeight ?? 0) >= UIFont.Weight.semibold.rawValue, "The name is 17 pt semibold")
assert(headerTitle.containsAttachments(in: NSRange(location: 0, length: headerTitle.length)), "A chevron follows the name")
var headerChevron: UIImage?
headerTitle.enumerateAttribute(.attachment, in: NSRange(location: 0, length: headerTitle.length)) { value, _, _ in
  headerChevron = headerChevron ?? (value as? NSTextAttachment)?.image
}
assert(ink(headerChevron!) > ink(boldChevron), "The header chevron is heavier than a bold 10 pt chevron beside the semibold name")
LodyMenuButtonStyle.apply(label: "Design states", detail: "2 online / 2 devices · 3 running", avatar: squareAvatar, to: headerMenu)
let narrowHeader = headerMenu.sizeThatFits(CGSize(width: 200, height: CGFloat.greatestFiniteMagnitude))
assert(narrowHeader.height <= LodyMenuButtonStyle.height, "A long status line truncates instead of wrapping: \(narrowHeader.height)")
LodyMenuButtonStyle.apply(label: "Innei", avatar: squareAvatar, to: headerMenu)
assert(headerMenu.configuration?.attributedSubtitle == nil, "No status leaves a single-line button")
print("PASS: the workspace header draws a square monogram, a semibold name with chevron and a mono status line")

var swipedState = UICellConfigurationState(traitCollection: UITraitCollection())
swipedState.isSwiped = true
swipedState.isSelected = true
swipedState.isHighlighted = true
let swipedBackgroundState = LodyListCellBackground.visualState(for: swipedState)
assert(!swipedBackgroundState.isSwiped, "Swipe actions must use the resting row background")
assert(!swipedBackgroundState.isSelected, "Swipe actions must not render the selected background")
assert(!swipedBackgroundState.isHighlighted, "Swipe actions must not render the highlighted background")

var tappedState = UICellConfigurationState(traitCollection: UITraitCollection())
tappedState.isSelected = true
tappedState.isHighlighted = true
let tappedBackgroundState = LodyListCellBackground.visualState(for: tappedState)
assert(tappedBackgroundState.isSelected, "Normal row selection must stay visible")
assert(tappedBackgroundState.isHighlighted, "Normal tap highlighting must stay visible")

assert(LodyListPhoto.url("person.crop.circle") == nil)
assert(LodyListPhoto.url("https://avatars.githubusercontent.com/u/1")?.scheme == "https")
assert(LodyListPhoto.url("http://avatars.githubusercontent.com/u/1") == nil)
assert(LodyListPhoto.url("javascript:alert(1)") == nil)
assert(LodyListPhoto.url("https://user:pass@example.com/a.png") == nil)
assert(LodyListPhoto.url("data:image/png;base64,aa")?.scheme == "data")
assert(LodyListPhoto.url("file:///tmp/a.png")?.isFileURL == true)

let source = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 40)).image { _ in
  UIColor.red.setFill()
  UIRectFill(CGRect(x: 0, y: 0, width: 80, height: 40))
}
let photo = LodyListPhoto.circular(source)
assert(photo.size == LodyListPhoto.size)
assert(photo.renderingMode == .alwaysOriginal)

func alpha(_ image: UIImage, x: CGFloat, y: CGFloat) -> CGFloat {
  var pixel: [UInt8] = [0, 0, 0, 0]
  let space = CGColorSpaceCreateDeviceRGB()
  let context = CGContext(
    data: &pixel,
    width: 1,
    height: 1,
    bitsPerComponent: 8,
    bytesPerRow: 4,
    space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  context.translateBy(x: -x, y: -y)
  context.draw(image.cgImage!, in: CGRect(origin: .zero, size: image.size))
  return CGFloat(pixel[3]) / 255
}

assert(alpha(photo, x: 0, y: 0) < 0.05, "Photo corners must be transparent")
assert(alpha(photo, x: photo.size.width - 1, y: 0) < 0.05, "Photo corners must be transparent")
assert(alpha(photo, x: photo.size.width / 2, y: photo.size.height / 2) > 0.9, "Photo center must stay opaque")

let disk = FileManager.default.temporaryDirectory.appendingPathComponent("lody-list-photo.png")
try! source.pngData()!.write(to: disk)
let fromFile = LodyListPhoto.image(for: disk, ready: { _ in })
assert(fromFile != nil, "file URLs must decode a circular photo")
assert(fromFile!.renderingMode == .alwaysOriginal)
assert(alpha(fromFile!, x: 0, y: 0) < 0.05)

let dataURL = URL(string: "data:image/png;base64," + source.pngData()!.base64EncodedString())!
let fromData = LodyListPhoto.image(for: dataURL, ready: { _ in })
assert(fromData != nil, "data image URLs must decode a circular photo")

print("PASS: workspace title stays single-line, swiped rows stay unselected, and list photos are safely cropped")

let restingState = UICellConfigurationState(traitCollection: UITraitCollection())
assert(LodyListCellBackground.railConfiguration(for: restingState).backgroundColor == .clear, "Outline rows at rest must show the section card, not their own background")
assert(LodyListCellBackground.railConfiguration(for: tappedState).backgroundColor != .clear, "Outline rows must still paint their highlight")
assert(LodyListCellBackground.railConfiguration(for: swipedState).backgroundColor != .clear, "A swiped outline row must carry an opaque background with it")
assert(LodySectionCardView(frame: .zero).layer.cornerRadius > 0, "The section card must be rounded")

struct LodyListRow {
  var title = ""
  var subtitle = ""
  var modelName = ""
  var value = ""
  var accessibilityValue = ""
  var unread = false
  var destructive = false
  var badge = ""
  var subtitleMono = false
  var pinned = false
  var diff: [String: Int] = [:]
  var monogram = ""
  var image = ""
  var imageTint = ""
  var parent = false
  var parentId = ""
  var lastChild = false
  var collapsedValue = ""
  var highlight = ""
  var wrapSubtitle = false
  var imageAsset = ""
  var filePath = ""
}



@MainActor func laidOutSessionRow(_ content: LodySessionRowContent) -> LodySessionRowView {
  laidOut(LodySessionRowView(content))
}

@MainActor func laidOut<View: UIView>(_ view: View) -> View {
  let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
  window.makeKeyAndVisible()
  let host = UIView(frame: window.bounds)
  window.addSubview(host)
  host.addSubview(view)
  view.translatesAutoresizingMaskIntoConstraints = false
  NSLayoutConstraint.activate([
    view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
    view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
    view.topAnchor.constraint(equalTo: host.topAnchor),
  ])
  host.layoutIfNeeded()
  withExtendedLifetime(window) {}
  return view
}

func labels(in view: UIView) -> [UILabel] {
  [view as? UILabel].compactMap { $0 } + view.subviews.flatMap(labels(in:))
}

func sessionLabel(_ view: UIView, _ text: String) -> UILabel {
  labels(in: view).first { ($0.text ?? $0.attributedText?.string) == text }!
}

func visibleLabel(_ view: UIView, containing text: String) -> UILabel? {
  labels(in: view).first { !$0.isHidden && ($0.text ?? $0.attributedText?.string ?? "").contains(text) }
}

func midY(_ inner: UIView, in outer: UIView) -> CGFloat {
  inner.convert(CGPoint(x: 0, y: inner.bounds.midY), to: outer).y
}

func frame(_ inner: UIView, in outer: UIView) -> CGRect {
  inner.convert(inner.bounds, to: outer)
}

func statusGlyph(in view: UIView) -> LodyStatusGlyphView {
  view.subviews.compactMap { $0 as? LodyStatusGlyphView }.first!
}

func treePath(in view: UIView) -> CGPath? {
  let rail = UIColor.lodyRail.resolvedColor(with: view.traitCollection).cgColor
  return (view.layer.sublayers ?? []).compactMap { $0 as? CAShapeLayer }
    .first { $0.strokeColor == rail && !$0.isHidden }?.path
}

func reviewButton(in view: UIView) -> UIButton? {
  view.subviews.compactMap { $0 as? UIButton }.first { !$0.isHidden }
}

let primary = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Ship 0.42 release", subtitle: "lody-ios · main", modelName: "Opus", value: "6m", subtitleMono: true, imageTint: "blue")
))
let primaryGlyph = frame(statusGlyph(in: primary), in: primary)
let primaryTitle = sessionLabel(primary, "Ship 0.42 release")
let primaryMeta = visibleLabel(primary, containing: "lody-ios")!
assert(abs(primaryGlyph.midX - 24) < 0.5, "The rail glyph centers at 24 pt: \(primaryGlyph)")
assert(abs(frame(primaryTitle, in: primary).minX - 46) < 0.5, "Primary text starts at 46 pt")
assert(abs(frame(primaryMeta, in: primary).minX - 46) < 0.5, "Line two aligns with the title")
assert(abs(frame(sessionLabel(primary, "6m"), in: primary).maxX - (390 - 16)) < 0.5, "Time keeps a 16 pt trailing margin")
assert(
  abs(primaryGlyph.midY - midY(primaryTitle, in: primary)) < abs(primaryGlyph.midY - midY(primaryMeta, in: primary)),
  "The glyph sits on the title line"
)
assert(statusGlyph(in: primary).kind == .live)
assert(abs(primary.bounds.height - 52) <= 4, "A primary row is about 52 pt: \(primary.bounds.height)")
let metaText = primaryMeta.attributedText!
let projectFont = metaText.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
let modelFont = metaText.attribute(.font, at: (metaText.string as NSString).range(of: "Opus").location, effectiveRange: nil) as! UIFont
assert(projectFont == modelFont, "Line two uses one face for project, branch and model")
assert(!projectFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "Line two is not monospaced")
assert(treePath(in: primary) == nil, "A row outside a group draws no tree line")
assert(reviewButton(in: primary) == nil)
assert(LodySessionRowView.textLeading(for: LodyListRow(), density: .regular) == 46)

let child = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Test on macOS", modelName: "Codex", value: "3m", imageTint: "blue", parentId: "ship")
))
let childGlyph = frame(statusGlyph(in: child), in: child)
assert(abs(childGlyph.midX - 46) < 0.5, "A child glyph centers at 46 pt")
let childTitle = visibleLabel(child, containing: "Test on macOS")!
assert(abs(frame(childTitle, in: child).minX - 62) < 0.5, "Child text starts at 62 pt")
assert((childTitle.attributedText?.string ?? childTitle.text ?? "").contains("· Codex"), "The child names its model after the title")
assert(abs(child.bounds.height - 40) <= 4, "A child row is about 40 pt: \(child.bounds.height)")
let trunk = treePath(in: child)!.boundingBox
assert(trunk.minY <= 0.5 && trunk.maxY >= child.bounds.height - 0.5, "Earlier children carry the trunk through the row")
assert(abs(trunk.minX - 23.5) <= 1, "The trunk runs at the rail center")
assert(LodySessionRowView.textLeading(for: LodyListRow(parentId: "ship"), density: .regular) == 62)

let lastChild = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Land upstream fix", value: "5m", parentId: "ship", lastChild: true)
))
let elbow = treePath(in: lastChild)!.boundingBox
assert(elbow.maxY < lastChild.bounds.height - 4, "The last child ends the trunk at its elbow")
assert(elbow.maxX >= 38, "The elbow reaches the child glyph")

let parent = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Ship 0.42 release", subtitle: "lody-ios", value: "6m", imageTint: "blue", collapsedValue: "2"),
  treeDown: true
))
let down = treePath(in: parent)!.boundingBox
assert(down.minY > frame(statusGlyph(in: parent), in: parent).maxY - 0.5 && down.maxY >= parent.bounds.height - 0.5,
       "An expanded parent starts the trunk below its glyph")

var reviewed = 0
let attention = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Migrate auth middleware", subtitle: "lody-cloud", value: "2m", badge: "Needs approval", imageTint: "warning"),
  onReview: { reviewed += 1 }
))
let review = reviewButton(in: attention)!
assert(review.configuration?.background.backgroundColor == .clear && (review.configuration?.background.strokeWidth ?? 0) > 0, "Review is an outlined capsule")
assert(review.configuration?.baseForegroundColor == .lodyInk, "Review keeps ink text")
let attentionWeight = ((sessionLabel(attention, "Migrate auth middleware").attributedText!.attribute(.font, at: 0, effectiveRange: nil) as! UIFont).fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
assert(attentionWeight < UIFont.Weight.semibold.rawValue, "Needs-you rows rely on the glyph; only unread rows are bold")
assert(review.bounds.height < 44 && review.point(inside: CGPoint(x: review.bounds.midX, y: review.bounds.midY - 21), with: nil),
       "Review draws small but hit-tests at 44 pt")
assert(frame(review, in: attention).maxX <= 390 - 16 + 0.5)
assert(abs(frame(review, in: attention).midY - attention.bounds.midY) < 0.5, "Review centers on the row")
assert(abs(attention.bounds.height - 52) <= 4, "Review keeps the primary row height: \(attention.bounds.height)")
assert(visibleLabel(attention, containing: "2m")?.attributedText?.string.contains("lody-cloud") == true, "The time moves to line two beside Review")
let attentionTitle = frame(visibleLabel(attention, containing: "Migrate auth middleware")!, in: attention)
assert(attentionTitle.maxX <= frame(review, in: attention).minX - 8 + 0.5, "The title never runs under Review")
assert(visibleLabel(attention, containing: "Needs approval") == nil, "Status pills are replaced by the glyph")
assert(attention.accessibilityLabel?.contains("Needs approval") == true, "VoiceOver still hears the state")
_ = attention.accessibilityCustomActions?.first?.actionHandler?(attention.accessibilityCustomActions!.first!)
assert(reviewed == 1, "VoiceOver reaches Review as a custom action")
var compactAttention = LodySessionRowContent(
  row: LodyListRow(title: "Migrate auth middleware", value: "2m", imageTint: "warning"), onReview: {}
)
compactAttention.density = .compact
let compactRow = laidOutSessionRow(compactAttention)
assert(reviewButton(in: compactRow) == nil, "Compact rows rely on the glyph alone")
assert(abs(frame(statusGlyph(in: compactRow), in: compactRow).midX - 10) < 0.5, "Compact rail centers at 10 pt")
var compactChild = LodySessionRowContent(row: LodyListRow(title: "Child", value: "1m", parentId: "p"))
compactChild.density = .compact
let compactChildRow = laidOutSessionRow(compactChild)
assert(abs(frame(statusGlyph(in: compactChildRow), in: compactChildRow).midX - LodyDesign.Rail.compactChildCenter) < 0.5)
assert(LodySessionRowView.textLeading(for: LodyListRow(parentId: "p"), density: .compact) == LodyDesign.Rail.compactChildText)

print("PASS: rail rows place glyphs, text, tree lines and Review on the design grid")

let statsRow = LodyListRow(title: "Review", subtitle: "main", diff: ["add": 4, "del": 2])
let stats = LodySessionRowView.meta(for: statsRow)
let statsText = stats.string as NSString
let addRange = statsText.range(of: "+4")
let delRange = statsText.range(of: "−2")
assert(addRange.location != NSNotFound && delRange.location != NSNotFound, statsText as String)
let addColor = stats.attribute(.foregroundColor, at: addRange.location, effectiveRange: nil) as! UIColor
let delColor = stats.attribute(.foregroundColor, at: delRange.location, effectiveRange: nil) as! UIColor
assert(addColor.isEqual(UIColor.lodySecondary) && delColor.isEqual(UIColor.lodySecondary), "List diff summaries stay quiet; only needs-you keeps a color")

// Compare the same real content view at the same width, including reuse back
// into the default host. Sidebar typography can shrink, but not text or touch targets.
@MainActor func fittedHeight(_ view: UIView) -> CGFloat {
  view.systemLayoutSizeFitting(
    CGSize(width: 288, height: 0),
    withHorizontalFittingPriority: .required,
    verticalFittingPriority: .fittingSizeLevel
  ).height
}

let densityRow = LodyListRow(title: "Review sidebar", subtitle: "feature/sidebar", modelName: "GPT-6", value: "Now")
let sessionContent = LodySessionRowContent(row: densityRow)
let densitySession = LodySessionRowView(sessionContent)
let groupedSessionHeight = fittedHeight(densitySession)
let groupedSessionLabel = densitySession.accessibilityLabel
let groupedTitleFont = sessionLabel(densitySession, densityRow.title).font!
var sidebarSession = sessionContent
sidebarSession.density = .compact
densitySession.configuration = sidebarSession
assert(fittedHeight(densitySession) < groupedSessionHeight, "Sidebar must fit more rows at the same width")
assert(fittedHeight(densitySession) >= 44, "Compact rows must keep a 44 pt touch target")
assert(densitySession.accessibilityLabel == groupedSessionLabel, "Sidebar must retain all session information")
assert(sessionLabel(densitySession, densityRow.title).font.pointSize < groupedTitleFont.pointSize, "Sidebar title must be quieter than the grouped title")
assert(sessionLabel(densitySession, densityRow.title).adjustsFontForContentSizeCategory)
let groupedMetaFont = LodySessionRowView.meta(for: densityRow).attribute(.font, at: 0, effectiveRange: nil) as! UIFont
let sidebarMetaFont = visibleLabel(densitySession, containing: densityRow.subtitle)!.attributedText!.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
assert(sidebarMetaFont.pointSize < groupedMetaFont.pointSize, "Attributed branch text must follow sidebar density too")
densitySession.configuration = sessionContent
assert(sessionLabel(densitySession, densityRow.title).font == groupedTitleFont, "Reuse must restore the phone title size")
assert(abs(fittedHeight(densitySession) - groupedSessionHeight) < 0.5, "Reuse must restore grouped row spacing")
sidebarSession.row = LodyListRow(title: "No metadata")
densitySession.configuration = sidebarSession
assert(fittedHeight(densitySession) >= 44, "A one-line sidebar row must still be tappable")

let pinnedHeader = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "Pinned", image: "pin.fill"))))
let pinnedSymbol = pinnedHeader.subviews.compactMap { $0 as? UIImageView }.first { $0.image != nil && !$0.isHidden }!
assert(abs(frame(pinnedSymbol, in: pinnedHeader).midX - 24) < 0.5, "A symbol header draws its symbol in the rail")
assert(statusGlyph(in: pinnedHeader).isHidden, "A symbol header replaces the folder glyph")

let railProject = laidOut(LodyProjectRowView(LodyProjectRowContent(
  row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios", value: "2 running", badge: "7", subtitleMono: true, monogram: "L", imageTint: "blue")
)))
let railProjectGlyph = statusGlyph(in: railProject)
assert(railProjectGlyph.kind == .project && !railProjectGlyph.isHidden)
assert(abs(frame(railProjectGlyph, in: railProject).midX - 24) < 0.5, "The folder glyph centers on the rail")
let railProjectName = sessionLabel(railProject, "lody-ios")
assert(abs(frame(railProjectName, in: railProject).minX - 46) < 0.5, "The project name starts on the text column")
let projectWeight = (railProjectName.font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat
assert((projectWeight ?? 0) >= UIFont.Weight.semibold.rawValue, "The project name is semibold")
let band = railProject.backgroundColor?.resolvedColor(with: railProject.traitCollection)
assert(band == UIColor.lodyBand.resolvedColor(with: railProject.traitCollection), "A project header is a full-width band")
assert(abs(railProject.bounds.height - 44) <= 0.5, "A project band is one 44 pt line: \(railProject.bounds.height)")
let railProjectPath = visibleLabel(railProject, containing: "~/git/lody-ios")!
assert(abs(midY(railProjectPath, in: railProject) - midY(railProjectName, in: railProject)) < 1, "The path rides the name line")
assert(frame(railProjectPath, in: railProject).minX > frame(railProjectName, in: railProject).maxX, "The path follows the name")
assert(railProjectPath.font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "The path is monospaced")
assert(railProjectPath.textColor == .lodyTertiary, "The path stays faint")
let runningProject = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios", value: "2 running", imageTint: "blue"))))
let railProjectState = visibleLabel(runningProject, containing: "2 running")!
assert(abs(frame(railProjectState, in: runningProject).maxX - (390 - 16)) < 0.5, "Project state sits in the time column")
assert(abs(midY(railProjectState, in: runningProject) - midY(sessionLabel(runningProject, "lody-ios"), in: runningProject)) < 1, "Project state rides the name line")
assert(railProjectState.textColor == .lodySecondary, "Running projects stay neutral")
let waitingProject = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios", value: "2 need you", imageTint: "warning"))))
assert(visibleLabel(waitingProject, containing: "2 need you")!.textColor == .lodyAttention, "Only needs-you keeps amber on the band")
let failedProject = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", value: "1 failed", imageTint: "danger"))))
assert(visibleLabel(failedProject, containing: "1 failed")!.textColor == .lodySecondary, "Failure counts stay neutral on the band")
let railProjectCount = visibleLabel(railProject, containing: "7")!
assert(abs(frame(railProjectCount, in: railProject).maxX - (390 - 16)) < 0.5, "The collapsed count sits in the time column")
assert(visibleLabel(railProject, containing: "2 running") == nil, "A collapsed band shows its count instead of its state")
let compactProject = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios"), density: .compact)))
assert(abs(frame(statusGlyph(in: compactProject), in: compactProject).midX - LodyDesign.Rail.compactCenter) < 0.5)
assert(abs(compactProject.bounds.height - 44) <= 0.5, "A compact project band keeps a 44 pt target: \(compactProject.bounds.height)")
assert(compactProject.layer.cornerRadius >= 8 && compactProject.layer.cornerCurve == .continuous, "Inset sidebar bands round their corners")
assert(railProject.layer.cornerRadius == 0, "Full-bleed phone bands stay square")
var bandAlpha: CGFloat = 0
UIColor.lodyBand.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).getWhite(nil, alpha: &bandAlpha)
assert(bandAlpha < 0.2, "The band is a wash so it reads on both the phone ground and the sidebar ground")

func projectAvatar(_ view: UIView) -> UIImageView? {
  view.subviews.compactMap { $0 as? UIImageView }.first { $0.accessibilityIdentifier == "project-avatar" && !$0.isHidden && $0.image != nil }
}
let avatarProject = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios", image: disk.absoluteString))))
let avatar = projectAvatar(avatarProject)
assert(avatar != nil, "A project with an owner photo shows it")
let avatarFrame = frame(avatar!, in: avatarProject)
assert(abs(avatarFrame.width - 18) < 0.5 && abs(avatarFrame.height - 18) < 0.5, "The project avatar is an 18 pt tile: \(avatarFrame)")
assert(abs(avatarFrame.midX - LodyDesign.Rail.center) < 0.5, "The project avatar centers on the rail")
assert(abs(avatarFrame.midY - frame(sessionLabel(avatarProject, "lody-ios"), in: avatarProject).midY) < 0.5, "The project avatar centers on the name")
assert(avatar!.layer.cornerRadius > 2 && avatar!.layer.cornerRadius < 9 && avatar!.clipsToBounds, "The project avatar is a rounded square, not a circle")
assert(alpha(avatar!.image!, x: 0, y: 0) > 0.9, "The project avatar is not pre-cropped to a circle")
assert(statusGlyph(in: avatarProject).isHidden, "The avatar replaces the folder glyph")
assert(abs(frame(sessionLabel(avatarProject, "lody-ios"), in: avatarProject).minX - 46) < 0.5, "The avatar keeps the text column")
let compactAvatar = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", image: disk.absoluteString), density: .compact)))
assert(abs(frame(projectAvatar(compactAvatar)!, in: compactAvatar).midX - LodyDesign.Rail.compactCenter) < 0.5, "Compact rows center the avatar on their rail")
let pendingAvatar = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", image: "https://avatars.invalid/lody?size=96"))))
assert(projectAvatar(pendingAvatar) == nil && !statusGlyph(in: pendingAvatar).isHidden, "A loading avatar keeps the folder glyph")
let reused = laidOut(LodyProjectRowView(LodyProjectRowContent(row: LodyListRow(title: "lody-ios", image: disk.absoluteString))))
reused.configuration = LodyProjectRowContent(row: LodyListRow(title: "other"))
assert(projectAvatar(reused) == nil && !statusGlyph(in: reused).isHidden, "A reused row without a photo returns to the folder glyph")

let searchHit = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(
    title: "Refactor Catalog sync", subtitle: "…the catalog now resumes from the last durable cursor watermark instead of replaying every replica",
    modelName: "Codex", value: "1h", highlight: "CATALOG", wrapSubtitle: true
  )
))
let snippetLabel = visibleLabel(searchHit, containing: "watermark")!
let snippetText = snippetLabel.attributedText!
func weight(_ font: UIFont) -> CGFloat {
  (font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
}
let snippetMatch = (snippetText.string as NSString).range(of: "catalog")
let matchFont = snippetText.attribute(.font, at: snippetMatch.location, effectiveRange: nil) as! UIFont
let contextFont = snippetText.attribute(.font, at: snippetMatch.location + snippetMatch.length + 2, effectiveRange: nil) as! UIFont
assert(weight(matchFont) >= UIFont.Weight.semibold.rawValue && weight(contextFont) < UIFont.Weight.medium.rawValue, "The matched words stand out in the snippet")
assert(snippetText.attribute(.foregroundColor, at: snippetMatch.location, effectiveRange: nil) as? UIColor == .lodyInk, "Matches read in ink")
assert(snippetLabel.numberOfLines == 2 && snippetLabel.bounds.height > snippetLabel.font.lineHeight * 1.5, "A long snippet wraps to a second line")
let searchTitle = visibleLabel(searchHit, containing: "Refactor")!.attributedText!
let titleMatch = (searchTitle.string as NSString).range(of: "Catalog")
let titleMatchFont = searchTitle.attribute(.font, at: titleMatch.location, effectiveRange: nil) as! UIFont
assert(weight(titleMatchFont) >= UIFont.Weight.semibold.rawValue, "Title matches stand out too")
let plainHit = laidOutSessionRow(LodySessionRowContent(row: LodyListRow(title: "Refactor catalog sync", subtitle: "feature/sync", value: "1h")))
assert(visibleLabel(plainHit, containing: "feature/sync")!.numberOfLines == 1, "Ordinary rows keep a single line two")
print("PASS: search rows highlight the query in titles and wrapped message snippets")

func inlineMark(_ view: UIView, after label: UILabel) -> UIImageView? {
  view.subviews.compactMap { $0 as? UIImageView }
    .first { !$0.isHidden && $0.image != nil && frame($0, in: view).minX >= frame(label, in: view).maxX - 0.5 }
}

var projectToggles = 0
let openProject = laidOut(LodyProjectRowView(LodyProjectRowContent(
  row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios"), expanded: true, onToggle: { projectToggles += 1 }
)))
let openName = frame(sessionLabel(openProject, "lody-ios"), in: openProject)
let openMark = inlineMark(openProject, after: sessionLabel(openProject, "lody-ios"))!
let openMarkFrame = frame(openMark, in: openProject)
assert(openMarkFrame.minX - openName.maxX >= 3 && openMarkFrame.minX - openName.maxX <= 8, "The fold mark follows the group name")
assert(openMarkFrame.width <= 14 && abs(openMarkFrame.midY - openName.midY) < 1, "The fold mark is small and sits on the name line")
assert(openMark.image!.size.width > openMark.image!.size.height, "An open group points the mark down")
assert(ink(openMark.image!) > ink(boldChevron), "The group mark carries the weight of the semibold name")
let closedProject = laidOut(LodyProjectRowView(LodyProjectRowContent(
  row: LodyListRow(title: "lody-cloud", subtitle: "~/git/lody-cloud", badge: "4"), expanded: false, onToggle: {}
)))
let closedMark = inlineMark(closedProject, after: sessionLabel(closedProject, "lody-cloud"))!
assert(closedMark.image!.size.height > closedMark.image!.size.width, "A collapsed group points the mark sideways")
assert(inlineMark(railProject, after: sessionLabel(railProject, "lody-ios")) == nil, "Groups that navigate draw no fold mark")
let collapseGroup = openProject.accessibilityCustomActions?.first { $0.name == "native.list.collapse" }
assert(collapseGroup != nil, "VoiceOver can collapse an open group")
_ = collapseGroup!.actionHandler!(collapseGroup!)
assert(projectToggles == 1)
assert(closedProject.accessibilityCustomActions?.contains { $0.name == "native.list.expand" } == true, "VoiceOver can expand a collapsed group")

var sessionToggles = 0
let foldParent = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Refactor catalog sync", subtitle: "feature/sync", modelName: "Codex", value: "1h", collapsedValue: "3 sessions"),
  expanded: false,
  onToggle: { sessionToggles += 1 }
))
let fold = foldParent.subviews.compactMap { $0 as? UIButton }.first { !$0.isHidden }!
let foldFrame = frame(fold, in: foldParent)
let foldTitle = frame(sessionLabel(foldParent, "Refactor catalog sync"), in: foldParent)
let foldLine = frame(visibleLabel(foldParent, containing: "feature/sync")!, in: foldParent)
assert(foldFrame.minY >= foldTitle.maxY - 0.5 && abs(foldFrame.midY - foldLine.midY) < 1.5, "The sub-agent toggle sits on line two")
assert(foldFrame.minX >= foldLine.maxX - 0.5, "The toggle follows the line-two text")
assert(fold.configuration?.attributedTitle.map { String($0.characters) }?.contains("3 sessions") == true, "The toggle names the children")
assert(fold.point(inside: CGPoint(x: fold.bounds.midX, y: fold.bounds.midY - 21), with: nil), "The toggle hit-tests at 44 pt")
assert(visibleLabel(foldParent, containing: "1h") != nil, "A folded parent keeps its time")
let expandChildren = foldParent.accessibilityCustomActions?.first { $0.name == "native.list.expand" }
assert(expandChildren != nil, "VoiceOver can expand sub-agents")
_ = expandChildren!.actionHandler!(expandChildren!)
assert(sessionToggles == 1, "The toggle folds the sub-agents, not the session")
assert(reviewButton(in: parent) == nil, "Without a toggle handler the parent draws no control")
let compactFold = laidOutSessionRow(LodySessionRowContent(
  row: LodyListRow(title: "Refactor catalog sync", subtitle: "feature/sync", modelName: "Codex", value: "1h", collapsedValue: "3 sessions"),
  density: .compact,
  expanded: false,
  onToggle: { sessionToggles += 1 }
))
let compactToggle = compactFold.subviews.compactMap { $0 as? UIButton }.first { !$0.isHidden }
assert(compactToggle?.configuration?.attributedTitle.map { String($0.characters) }?.contains("3 sessions") == true, "The sidebar folds sub-agents on line two too")
assert(visibleLabel(compactFold, containing: "1h") != nil, "A folded sidebar parent keeps its time")
var compactGroup = LodyProjectRowContent(row: LodyListRow(title: "lody-ios", subtitle: "~/git/lody-ios"), density: .compact, expanded: true)
compactGroup.onToggle = {}
let compactGroupView = LodyProjectRowView(compactGroup)
assert(compactGroupView.subviews.contains { ($0 as? UIImageView)?.isHidden == false && ($0 as? UIImageView)?.image != nil }, "Sidebar groups draw the inline fold mark")
print("PASS: groups and sub-agent parents fold through inline marks, not trailing accessories")

let projectContent = LodyProjectRowContent(row: LodyListRow(title: "Lody", subtitle: "/tmp/lody", monogram: "L"))
let densityProject = LodyProjectRowView(projectContent)
let groupedProjectHeight = fittedHeight(densityProject)
let groupedProjectLabel = densityProject.accessibilityLabel
let groupedProjectFont = sessionLabel(densityProject, "Lody").font!
var sidebarProject = projectContent
sidebarProject.density = .compact
densityProject.configuration = sidebarProject
assert(fittedHeight(densityProject) <= groupedProjectHeight)
assert(fittedHeight(densityProject) >= 44)
assert(densityProject.accessibilityLabel == groupedProjectLabel)
assert(sessionLabel(densityProject, "Lody").font.pointSize < groupedProjectFont.pointSize)
densityProject.configuration = projectContent
assert(sessionLabel(densityProject, "Lody").font == groupedProjectFont, "Reuse must restore the phone project size")
assert(abs(fittedHeight(densityProject) - groupedProjectHeight) < 0.5)
print("PASS: sidebar uses quieter typography with complete text and 44 pt targets; grouped reuse restores its font and spacing")

assert(
  LodyListSectionAnimation.itemCountsCrossEmpty(previous: ["settings": 0], next: ["settings": 3]),
  "Filling an empty section must skip the footer interpolation"
)
assert(
  LodyListSectionAnimation.itemCountsCrossEmpty(previous: ["settings": 3], next: ["settings": 0]),
  "Clearing a section must skip the footer interpolation"
)
assert(
  !LodyListSectionAnimation.itemCountsCrossEmpty(previous: ["settings": 3], next: ["settings": 4]),
  "Growing a populated section can keep its row animation"
)
assert(
  !LodyListSectionAnimation.itemCountsCrossEmpty(previous: ["help": 0], next: ["help": 0]),
  "A footer-only section that stays empty is not a crossing"
)
assert(
  !LodyListSectionAnimation.itemCountsCrossEmpty(previous: ["a": 2], next: ["a": 2, "b": 3]),
  "A newly inserted populated section never parked a footer at the top"
)
assert(
  LodyListSectionAnimation.hidesEmptyFooter(rowCount: 0, placeholder: "Loading remote settings…"),
  "An empty section with a placeholder must not park its description at the top"
)
assert(
  !LodyListSectionAnimation.hidesEmptyFooter(rowCount: 3, placeholder: "Loading remote settings…"),
  "A populated section keeps its footer under the card"
)
assert(
  !LodyListSectionAnimation.hidesEmptyFooter(rowCount: 0, placeholder: ""),
  "A footer-only help section stays visible when the host has no placeholder"
)
print("PASS: empty-to-populated list sections skip the footer interpolation")

let glyphAsset = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { _ in
  UIColor.black.setFill()
  UIRectFill(CGRect(x: 0, y: 0, width: 24, height: 24))
}.withRenderingMode(.alwaysTemplate)

func glyphContent(image: UIImage?, asset: Bool) -> UIListContentConfiguration {
  var content = UIListContentConfiguration.subtitleCell()
  content.text = "Claude Code"
  content.secondaryText = "助手"
  LodyListGlyph.apply(&content, image: image, asset: asset)
  return content
}

func laidOutGlyph(_ content: UIListContentConfiguration) -> UIView {
  let cell = UICollectionViewListCell()
  cell.contentConfiguration = content
  let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
  window.makeKeyAndVisible()
  let host = UIView(frame: window.bounds)
  window.addSubview(host)
  host.addSubview(cell)
  cell.translatesAutoresizingMaskIntoConstraints = false
  NSLayoutConstraint.activate([
    cell.leadingAnchor.constraint(equalTo: host.leadingAnchor),
    cell.trailingAnchor.constraint(equalTo: host.trailingAnchor),
    cell.topAnchor.constraint(equalTo: host.topAnchor),
  ])
  host.layoutIfNeeded()
  withExtendedLifetime(window) {}
  return cell
}

let symbolGlyph = glyphContent(image: UIImage(systemName: "sparkles"), asset: false)
let assetGlyph = glyphContent(image: glyphAsset, asset: true)
assert(assetGlyph.imageProperties.maximumSize == LodyListGlyph.size, "Provider icons must match the title3 symbol size, not a 24 pt asset canvas")
assert(assetGlyph.imageProperties.reservedLayoutSize == LodyListGlyph.reservedSize, "Provider icons must reserve the same list slot as SF Symbols")
assert(symbolGlyph.imageProperties.reservedLayoutSize == LodyListGlyph.reservedSize, "SF Symbols must share the list image slot with provider icons")
let symbolGlyphView = laidOutGlyph(symbolGlyph)
let assetGlyphView = laidOutGlyph(assetGlyph)
let symbolGlyphTitle = frame(sessionLabel(symbolGlyphView, "Claude Code"), in: symbolGlyphView)
let assetGlyphTitle = frame(sessionLabel(assetGlyphView, "Claude Code"), in: assetGlyphView)
assert(
  abs(symbolGlyphTitle.minX - assetGlyphTitle.minX) < 1,
  "Provider icons must keep the same text leading edge as SF Symbols (\(symbolGlyphTitle.minX) vs \(assetGlyphTitle.minX))"
)
assert(
  abs(symbolGlyphTitle.minY - assetGlyphTitle.minY) < 1,
  "Provider icons must keep the same text baseline as SF Symbols (\(symbolGlyphTitle.minY) vs \(assetGlyphTitle.minY))"
)
print("PASS: list asset glyphs keep SF Symbol text alignment")

let resizingSession = LodySessionRowView(LodySessionRowContent(
  row: LodyListRow(title: "Steer E2E", value: "Now")
))
for badgeText in ["Running", "", "Completed"] {
  resizingSession.configuration = LodySessionRowContent(
    row: LodyListRow(title: "Steer E2E", value: "Now", badge: badgeText, imageTint: badgeText.isEmpty ? "" : "blue")
  )
  let fitting = resizingSession.systemLayoutSizeFitting(
    CGSize(width: 370, height: CGFloat.greatestFiniteMagnitude),
    withHorizontalFittingPriority: .required,
    verticalFittingPriority: .defaultLow
  )
  assert(fitting.height >= 20 && fitting.height < 200, "Outline updates must produce a bounded content height: \(fitting)")
}
print("PASS: session state changes remain self-sizing under an expanded outline proposal")

var hold = LodyUnreadNavigationHold()
hold.begin(rowID: "unread", unread: true, coversList: true)
assert(
  hold.applied(rowID: "unread", unread: false) == true,
  "A covering push must keep unread emphasis while the source row is still on screen"
)
assert(
  hold.applied(rowID: "other", unread: false) == false,
  "Unread hold is only for the row that is being opened"
)
assert(hold.end() == "unread")
assert(
  hold.applied(rowID: "unread", unread: false) == false,
  "Unread emphasis drops after the covering transition finishes"
)

var split = LodyUnreadNavigationHold()
split.begin(rowID: "unread", unread: true, coversList: false)
assert(
  split.applied(rowID: "unread", unread: false) == false,
  "A list that stays on screen applies the viewed state immediately"
)
split.begin(rowID: "read", unread: false, coversList: true)
assert(
  split.applied(rowID: "read", unread: false) == false,
  "Opening an already-read row does not hold emphasis"
)
print("PASS: unread emphasis waits for a covering push to finish")

assert(LodyStatusGlyph.kind(for: LodyListRow(imageTint: "warning")) == .attention)
assert(LodyStatusGlyph.kind(for: LodyListRow(imageTint: "blue")) == .live)
assert(LodyStatusGlyph.kind(for: LodyListRow(imageTint: "danger")) == .failed)
assert(LodyStatusGlyph.kind(for: LodyListRow(unread: true)) == .unread)
assert(LodyStatusGlyph.kind(for: LodyListRow(unread: true, imageTint: "warning")) == .attention, "Attention outranks unread")
assert(LodyStatusGlyph.kind(for: LodyListRow()) == .done)
assert(LodyStatusGlyph.kind(for: LodyListRow(parent: true)) == .project)
assert(LodyStatusGlyphView.rotates(kind: .live, reduceMotion: false, inWindow: true))
assert(!LodyStatusGlyphView.rotates(kind: .live, reduceMotion: true, inWindow: true), "Reduce Motion stops the live arc")
assert(!LodyStatusGlyphView.rotates(kind: .live, reduceMotion: false, inWindow: false), "Offscreen glyphs do not animate")
assert(!LodyStatusGlyphView.rotates(kind: .done, reduceMotion: false, inWindow: true))

func shapes(_ view: UIView) -> [CAShapeLayer] {
  (view.layer.sublayers ?? []).compactMap { $0 as? CAShapeLayer }.filter { !$0.isHidden && $0.path != nil }
}
func painted(_ view: UIView, _ color: UIColor) -> Bool {
  let resolved = color.resolvedColor(with: view.traitCollection).cgColor
  return shapes(view).contains { $0.fillColor == resolved || $0.strokeColor == resolved }
}
let glyph = LodyStatusGlyphView(kind: .attention)
glyph.frame = CGRect(x: 0, y: 0, width: 14, height: 14)
glyph.layoutIfNeeded()
assert(!glyph.isAccessibilityElement, "Row labels carry the state; the glyph is decoration")
assert(painted(glyph, .lodyAttention), "Attention paints amber")
var outlines: [[CGPath]] = []
for kind in [LodyStatusGlyph.Kind.attention, .live, .unread, .failed, .done, .project] {
  glyph.kind = kind
  glyph.layoutIfNeeded()
  assert(!shapes(glyph).isEmpty, "\(kind) draws a shape")
  outlines.append(shapes(glyph).map { $0.path! })
}
for (index, outline) in outlines.enumerated() {
  assert(!outlines[(index + 1)...].contains(outline), "Every state has its own glyph")
}
glyph.kind = .failed
glyph.layoutIfNeeded()
assert(painted(glyph, .lodyFailure))
glyph.kind = .live
glyph.layoutIfNeeded()
assert(painted(glyph, .lodySecondary) && !painted(glyph, .lodyInk), "The live arc is quiet grey")
glyph.kind = .none
glyph.layoutIfNeeded()
assert(shapes(glyph).isEmpty, "A row without state draws nothing")

let glyphWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
glyphWindow.makeKeyAndVisible()
let spinner = LodyStatusGlyphView(kind: .live)
spinner.frame = CGRect(x: 0, y: 0, width: 14, height: 14)
glyphWindow.addSubview(spinner)
spinner.layoutIfNeeded()
assert(shapes(spinner).contains { $0.animationKeys()?.isEmpty == false }, "A live glyph on screen spins")
spinner.removeFromSuperview()
assert(!shapes(spinner).contains { $0.animationKeys()?.isEmpty == false }, "Leaving the window stops the spin")
print("PASS: status glyphs map row state, draw distinct shapes and spin only when visible")

assert(LodyFlatRows.sectionHasIcons([LodyListRow(title: "A"), LodyListRow(image: "gear")]), "One symbol row gives the section a rail")
assert(LodyFlatRows.sectionHasIcons([LodyListRow(imageAsset: "lody-mark-github")]), "Asset glyphs count as icons")
assert(LodyFlatRows.sectionHasIcons([LodyListRow(filePath: "a.swift")]), "File rows draw an icon")
assert(!LodyFlatRows.sectionHasIcons([LodyListRow(title: "A"), LodyListRow(title: "B")]), "Text-only sections have no rail")
assert(LodyFlatRows.textLeading(sectionHasIcons: true) == LodyDesign.Rail.text, "Icon sections put text on the rail text column")
assert(LodyFlatRows.textLeading(sectionHasIcons: false) == 16, "Text-only sections start at the reading margin")
assert(LodyFlatRows.iconCenter == LodyDesign.Rail.center && LodyFlatRows.iconSize == 18, "Icons sit on the rail at 18 pt")
assert(LodyFlatRows.separatorLeading(textLeading: 46, isLast: false) == 46, "Hairlines run under the text column")
assert(LodyFlatRows.separatorLeading(textLeading: 46, isLast: true) == nil, "The last row of a section has no hairline")
assert(LodyFlatRows.minHeight(hasSubtitle: false) == 44 && LodyFlatRows.minHeight(hasSubtitle: true) == 52, "Flat rows keep 44 / 52 pt minimums")
print("PASS: flat system rows place icons on the rail and hairlines under the text column")

// The workspace capsule opens WorkspaceSwitcherPanel, never a UIMenu: a menu cannot put the
// current workspace's checkmark at the trailing edge.
let capsule = LodyMenuButton()
let capsuleButton = capsule.subviews.compactMap { $0 as? UIButton }.first!
capsule.accessibilityIdentifier = "workspace-menu"
capsule.setItems([LodyMenuItem(id: "workspace", title: "Workspace", selected: true)])
assert(capsuleButton.menu == nil && !capsuleButton.showsMenuAsPrimaryAction, "The capsule presents the switcher panel")
assert(capsuleButton.accessibilityIdentifier == "workspace-menu", "The capsule's identifier is on its control")

let switcher = WorkspaceSwitcherPanel(items: [
  LodyMenuItem(id: "current", title: "Current", selected: true, monogram: "C"),
  LodyMenuItem(id: "other", title: "Other", monogram: "O"),
]) { _ in }
switcher.view.frame = CGRect(x: 0, y: 0, width: 300, height: 200)
switcher.beginAppearanceTransition(true, animated: false)
switcher.endAppearanceTransition()
let switcherList = switcher.view.subviews.compactMap { $0 as? UICollectionView }.first!
switcherList.layoutIfNeeded()
let currentRow = switcherList.cellForItem(at: IndexPath(item: 0, section: 0)) as! UICollectionViewListCell
let otherRow = switcherList.cellForItem(at: IndexPath(item: 1, section: 0)) as! UICollectionViewListCell
assert(currentRow.accessories.count == 1 && otherRow.accessories.isEmpty, "Only the current workspace carries the trailing checkmark")
assert(currentRow.accessibilityTraits.contains(.selected) && !otherRow.accessibilityTraits.contains(.selected), "VoiceOver reads the current workspace as selected")
assert(switcher.preferredContentSize.height >= 2 * 44, "Rows keep 44 pt targets")
print("PASS: the workspace capsule opens a panel listing only workspaces, checkmark trailing on the current one")

// Chat renders this shared cached photo at 36 pt. A 3x display needs 108 real pixels.
let retinaFormat = UIGraphicsImageRendererFormat()
retinaFormat.scale = 1
retinaFormat.opaque = true
let detailSource = UIGraphicsImageRenderer(size: CGSize(width: 108, height: 108), format: retinaFormat).image { _ in
  for x in 0..<108 {
    (x.isMultiple(of: 2) ? UIColor.black : UIColor.white).setFill()
    UIRectFill(CGRect(x: x, y: 0, width: 1, height: 108))
  }
}
let avatarDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try! FileManager.default.createDirectory(at: avatarDirectory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: avatarDirectory) }
let detailURL = avatarDirectory.appendingPathComponent("retina-avatar.png")
try! detailSource.pngData()!.write(to: detailURL)
let detailedAvatar = LodyListPhoto.image(for: detailURL, ready: { _ in })!
assert(detailedAvatar.size == CGSize(width: 36, height: 36), "Retina pixels must not enlarge the avatar layout")
assert(detailedAvatar.cgImage!.width == 108 && detailedAvatar.cgImage!.height == 108,
       "Decoded avatars must retain 3x detail through circular rendering and caching")
assert(LodyListPhoto.cached(detailURL)?.cgImage?.width == 108)
var detailPixels = [UInt8](repeating: 0, count: 108 * 108 * 4)
detailPixels.withUnsafeMutableBytes { bytes in
  let context = CGContext(data: bytes.baseAddress, width: 108, height: 108, bitsPerComponent: 8,
                          bytesPerRow: 108 * 4, space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(detailedAvatar.cgImage!, in: CGRect(x: 0, y: 0, width: 108, height: 108))
}
let black = Int(detailPixels[(54 * 108 + 52) * 4])
let white = Int(detailPixels[(54 * 108 + 53) * 4])
assert(white - black > 200, "One-pixel avatar detail must survive, not be blurred by a 1x intermediate")
print("PASS: cached circular avatars preserve Retina resolution and image detail")
