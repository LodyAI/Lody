import UIKit

struct DiffDocumentGeometry: Equatable {
  static let gapHeight: CGFloat = 28

  var wrap: Bool
  var numberWidth: CGFloat
  var sideWidth: CGFloat
  var contentWidth: CGFloat
  var digit = DiffDocumentGeometry.digitWidth

  var gutterWidth: CGFloat {
    InlineDiffMetrics.barWidth + 4 + numberWidth + InlineDiffMetrics.codeInset
  }

  var codeX: CGFloat { gutterWidth + InlineDiffMetrics.codeInset }

  var codeWidth: CGFloat { max(InlineDiffMetrics.rowHeight, sideWidth - codeX - InlineDiffMetrics.codeInset) }

  static var lineGap: CGFloat { InlineDiffMetrics.rowHeight - InlineDiffMetrics.font().lineHeight }

  static var digitWidth: CGFloat {
    ceil(("8" as NSString).size(withAttributes: [.font: InlineDiffMetrics.font()]).width)
  }

  static func numberWidth(maxNumber: Int, minimumDigits: Int) -> CGFloat {
    digitWidth * CGFloat(max(minimumDigits, String(maxNumber).count))
  }

  static func paragraph(wrap: Bool, spaced: Bool) -> NSParagraphStyle {
    let lineHeight = InlineDiffMetrics.font().lineHeight
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = wrap ? .byWordWrapping : .byClipping
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    paragraph.lineSpacing = spaced ? lineGap : 0
    paragraph.tabStops = []
    paragraph.defaultTabInterval = digitWidth * 4
    return paragraph
  }

  func width(of text: String) -> CGFloat {
    if !text.contains("\t"), text.utf8.allSatisfy({ $0 < 0x80 }) {
      return digit * CGFloat(text.utf8.count)
    }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: InlineDiffMetrics.font(),
      .paragraphStyle: Self.paragraph(wrap: false, spaced: false),
    ]
    return ceil((text as NSString).size(withAttributes: attributes).width)
  }

  func lines(_ text: String?) -> Int {
    guard wrap, let text, !text.isEmpty else { return 1 }
    if !text.contains("\t"), digit * CGFloat(text.utf8.count) <= codeWidth { return 1 }
    let lineHeight = InlineDiffMetrics.font().lineHeight
    let bounds = (text as NSString).boundingRect(
      with: CGSize(width: codeWidth, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin],
      attributes: [.font: InlineDiffMetrics.font(), .paragraphStyle: Self.paragraph(wrap: true, spaced: false)],
      context: nil
    )
    return max(1, Int((bounds.height / lineHeight).rounded()))
  }

  func height(of item: DiffDocumentItem) -> CGFloat {
    switch item {
    case .gap: return Self.gapHeight
    case .line(let line): return CGFloat(lines(line.text)) * InlineDiffMetrics.rowHeight
    case .pair(let left, let right):
      return CGFloat(max(lines(left?.text), lines(right?.text))) * InlineDiffMetrics.rowHeight
    }
  }
}

final class DiffDocumentLayout: UICollectionViewLayout {
  private var attributes: [UICollectionViewLayoutAttributes] = []
  private var size: CGSize = .zero

  var frames: [CGRect] { attributes.map(\.frame) }

  func update(heights: [CGFloat], width: CGFloat) {
    var y: CGFloat = 0
    attributes = heights.enumerated().map { index, height in
      let item = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
      item.frame = CGRect(x: 0, y: y, width: width, height: height)
      y += height
      return item
    }
    size = CGSize(width: width, height: y)
    invalidateLayout()
  }

  override var collectionViewContentSize: CGSize { size }

  override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
    var low = 0
    var high = attributes.count
    while low < high {
      let middle = (low + high) / 2
      if attributes[middle].frame.maxY <= rect.minY {
        low = middle + 1
      } else {
        high = middle
      }
    }
    var result: [UICollectionViewLayoutAttributes] = []
    var index = low
    while index < attributes.count, attributes[index].frame.minY < rect.maxY {
      result.append(attributes[index])
      index += 1
    }
    return result
  }

  override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    attributes.indices.contains(indexPath.item) ? attributes[indexPath.item] : nil
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool { false }
}
