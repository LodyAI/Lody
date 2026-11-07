import UIKit

struct LodyListRow {
  var parent = false
  var imageTint = ""
  var unread = false
}

@MainActor func descendants(_ view: UIView) -> [UIView] {
  view.subviews.flatMap { [$0] + descendants($0) }
}

precondition(ChatFileCell.rowHeight() == 44, "File rows keep the 44 pt touch target")
precondition(ChatFileCell.headerHeight == 44, "The grouped header must be 44 pt")

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
let cell = ChatFileCell(frame: CGRect(x: 16, y: 0, width: 358, height: ChatFileCell.rowHeight()))
window.addSubview(cell)
let path = "Sources/Chat/Transcript.swift"
cell.contentConfiguration = ChatFileCell.rowContent(for: path)
cell.apply(group: "first", selected: false)
cell.layoutIfNeeded()
let views = descendants(cell)
precondition(!views.contains { ($0 as? UIImageView)?.image != nil }, "File rows must not display a leading image")
let label = views.compactMap { $0 as? UILabel }.first { $0.attributedText?.string == path }!
let font = label.attributedText!.attribute(.font, at: 0, effectiveRange: nil) as! UIFont
precondition(font.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "File paths must be monospaced")
let expectedSize = LodyDesign.mono(12.5, compatibleWith: cell.traitCollection).pointSize
precondition(abs(font.pointSize - expectedSize) < 0.01, "File paths must use scaled 12.5 pt type, got \(font.pointSize), expected \(expectedSize)")
let chrome = cell.subviews.first { $0.layer.masksToBounds && $0.layer.cornerCurve == .continuous }!
precondition(chrome.layer.cornerRadius == 12, "The block must have a 12 pt radius")
precondition(chrome.layer.maskedCorners == [.layerMinXMinYCorner, .layerMaxXMinYCorner], "The first row rounds only the top corners")
for style in [UIUserInterfaceStyle.light, .dark] {
  let traits = UITraitCollection(userInterfaceStyle: style)
  precondition(chrome.backgroundColor!.resolvedColor(with: traits) == UIColor.lodyInset.resolvedColor(with: traits), "The block must use the inset fill in each appearance")
}
let separator = descendants(cell).first { $0.frame.height == 0.5 && !$0.isHidden }!
precondition(separator.frame.minX == 14 && separator.frame.maxX == cell.bounds.width - 14, "The hairline must be inset 14 pt on both sides")
precondition(separator.frame.maxY == cell.bounds.height, "The hairline must separate adjacent rows")
precondition(separator.backgroundColor == .lodyLine, "The hairline must use the line token")
cell.apply(group: "middle", selected: false)
precondition(chrome.layer.maskedCorners.isEmpty && !separator.isHidden, "Middle rows must remain square and separated")
cell.apply(group: "last", selected: false)
precondition(chrome.layer.maskedCorners == [.layerMinXMaxYCorner, .layerMaxXMaxYCorner], "The last row rounds only the bottom corners")
precondition(separator.isHidden, "The last row must not draw an outside hairline")
cell.apply(group: "only", selected: false)
precondition(chrome.layer.maskedCorners == [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner], "An isolated row rounds all corners")
precondition(separator.isHidden, "An isolated row must not draw an outside hairline")
cell.apply(group: "last", selected: true)
precondition(chrome.backgroundColor == .lodyInsetSelected, "Selected files must retain their existing selection feedback")
let header = ChatFileCell(frame: CGRect(x: 16, y: 40, width: 358, height: ChatFileCell.headerHeight))
window.addSubview(header)
let headerText = String.localizedStringWithFormat(String(localized: "native.chat.transcript.fileCount", bundle: .lody), 2)
header.contentConfiguration = ChatFileCell.headerContent(for: headerText)
header.apply(group: "first", selected: false)
header.layoutIfNeeded()
let headerLabel = descendants(header).compactMap { $0 as? UILabel }.first { $0.text == headerText }!
let headerFont = headerLabel.font!
let headerWeight = (headerFont.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
precondition(abs(headerFont.pointSize - LodyDesign.font(.subheadline, size: 14.5, compatibleWith: header.traitCollection).pointSize) < 0.01 && headerWeight >= UIFont.Weight.semibold.rawValue - 0.01, "The header must use scaled 14.5 pt semibold type")
precondition(headerLabel.textColor == .lodyInk, "The header must use the ink token")
precondition(header.accessories.isEmpty, "The header must have no navigation chevron")
precondition(descendants(header).contains { $0.frame.height == 0.5 && !$0.isHidden }, "The header must separate its title from the first file")
print("Chat files: grouped chrome, row heights, monospaced paths, icon removal and inset hairlines passed")


let changedFiles = (0..<10).map { ChatFileDiff(path: "src/file\($0).swift", add: $0, del: 2, status: nil) }
let fileList = ChatFileListCell(frame: CGRect(x: 16, y: 100, width: 358, height: ChatFileListCell.height(count: changedFiles.count)))
window.addSubview(fileList)
fileList.configure(entryID: "turn", files: changedFiles)
fileList.layoutIfNeeded()
let innerList = descendants(fileList).compactMap { $0 as? UICollectionView }.first!
precondition(innerList.frame.height == ChatFileCell.rowHeight() * 6)
precondition(innerList.isScrollEnabled && innerList.numberOfItems(inSection: 0) == 10)
var selectedPath = ""
fileList.onSelect = { selectedPath = $0 }
fileList.collectionView(innerList, didSelectItemAt: IndexPath(item: 9, section: 0))
precondition(selectedPath == changedFiles[9].path, "Files past the sixth row remain actionable")
fileList.configure(entryID: "short", files: Array(changedFiles.prefix(2)))
precondition(!innerList.isScrollEnabled && ChatFileListCell.height(count: 2) == ChatFileCell.rowHeight() * 2)
print("PASS: changed files cap at six rows without dropping overflow files or selection")
