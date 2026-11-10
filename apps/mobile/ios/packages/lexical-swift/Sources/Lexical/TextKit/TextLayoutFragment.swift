import UIKit

final class TextLayoutManagerDelegate: NSObject, NSTextLayoutManagerDelegate {
  func textLayoutManager(_ textLayoutManager: NSTextLayoutManager, textLayoutFragmentFor location: NSTextLocation, in textElement: NSTextElement) -> NSTextLayoutFragment {
    TextLayoutFragment(textElement: textElement, range: textElement.elementRange)
  }
}

final class TextLayoutFragment: NSTextLayoutFragment, @unchecked Sendable {
  private var contentStorage: NSTextContentStorage? {
    textLayoutManager?.textContentManager as? NSTextContentStorage
  }

  private var containerWidth: CGFloat {
    textLayoutManager?.textContainer?.size.width ?? layoutFragmentFrame.width
  }

  private var characterRange: NSRange? {
    guard let contentStorage else { return nil }
    let start = contentStorage.offset(from: contentStorage.documentRange.location, to: rangeInElement.location)
    let length = contentStorage.offset(from: rangeInElement.location, to: rangeInElement.endLocation)
    return NSRange(location: start, length: length)
  }

  // Block decorations (quote bars, code backgrounds, list bullets) are drawn outside the glyphs' typographic bounds.
  override var renderingSurfaceBounds: CGRect {
    let fullWidth = CGRect(x: -layoutFragmentFrame.minX, y: 0, width: containerWidth, height: layoutFragmentFrame.height)
    return super.renderingSurfaceBounds.union(fullWidth)
  }

  override func draw(at point: CGPoint, in context: CGContext) {
    guard let storage = contentStorage?.textStorage as? TextStorage, let editor = storage.editor, let range = characterRange else {
      super.draw(at: point, in: context)
      return
    }
    let clip = renderingSurfaceBounds.offsetBy(dx: point.x, dy: point.y)
    context.saveGState()
    context.clip(to: clip)
    draw(editor.customDrawingBackground, storage: storage, range: range, at: point)
    context.restoreGState()

    super.draw(at: point, in: context)

    context.saveGState()
    context.clip(to: clip)
    draw(editor.customDrawingText, storage: storage, range: range, at: point)
    context.restoreGState()
  }

  private func lineRect(_ line: NSTextLineFragment, at point: CGPoint) -> CGRect {
    let bounds = line.typographicBounds
    return CGRect(x: point.x - layoutFragmentFrame.minX, y: point.y + bounds.minY, width: containerWidth, height: bounds.height)
  }

  private func draw(_ handlers: [NSAttributedString.Key: Editor.CustomDrawingHandlerInfo], storage: TextStorage, range: NSRange, at point: CGPoint) {
    guard !handlers.isEmpty, range.length > 0, let firstLine = textLineFragments.first else { return }
    let firstLineRect = lineRect(firstLine, at: point)
    let paragraphRect = textLineFragments.map { lineRect($0, at: point) }.reduce(firstLineRect) { $0.union($1) }
    let toContext = CGPoint(x: point.x - layoutFragmentFrame.minX, y: point.y - layoutFragmentFrame.minY)

    for (attribute, info) in handlers {
      storage.enumerateAttribute(attribute, in: range) { value, runRange, _ in
        guard let value else { return }
        switch info.granularity {
        case .characterRuns:
          for line in textLineFragments {
            let lineRange = NSRange(location: range.location + line.characterRange.location, length: line.characterRange.length)
            let run = NSIntersectionRange(runRange, lineRange)
            guard run.length > 0 else { continue }
            let bounds = line.typographicBounds
            let startX = line.locationForCharacter(at: run.location - range.location).x
            let endX = line.locationForCharacter(at: run.upperBound - range.location).x
            let glyphRect = CGRect(x: point.x + bounds.minX + startX, y: point.y + bounds.minY, width: endX - startX, height: bounds.height)
            info.customDrawingHandler(attribute, value, storage, runRange, run, run, glyphRect, lineRect(line, at: point))
          }
        case .singleParagraph:
          info.customDrawingHandler(attribute, value, storage, runRange, range, range, paragraphRect, firstLineRect)
        case .contiguousParagraphs:
          var fullRun = NSRange()
          _ = storage.attribute(attribute, at: runRange.location, longestEffectiveRange: &fullRun, in: NSRange(location: 0, length: storage.length))
          let group = storage.mutableString.paragraphRange(for: fullRun)
          guard let rects = containerRects(for: group) else { return }
          var rect = rects.block.offsetBy(dx: toContext.x, dy: toContext.y)
          if let blockStyle = storage.attribute(.appliedBlockLevelStyles_internal, at: group.location, effectiveRange: nil) as? BlockLevelAttributes {
            if group.location > 0 {
              rect.origin.y += blockStyle.marginTop
              rect.size.height -= blockStyle.marginTop
            }
            if group.upperBound < storage.length {
              rect.size.height -= blockStyle.marginBottom
            }
          }
          info.customDrawingHandler(attribute, value, storage, fullRun, group, group, rect, rects.firstLine.offsetBy(dx: toContext.x, dy: toContext.y))
        }
      }
    }
  }

  private func containerRects(for range: NSRange) -> (block: CGRect, firstLine: CGRect)? {
    guard let textLayoutManager, let contentStorage,
      let start = contentStorage.location(contentStorage.documentRange.location, offsetBy: range.location),
      let end = contentStorage.location(start, offsetBy: max(range.length - 1, 0)),
      let first = textLayoutManager.textLayoutFragment(for: start),
      let last = textLayoutManager.textLayoutFragment(for: end)
    else { return nil }
    let union = first.layoutFragmentFrame.union(last.layoutFragmentFrame)
    let lineBounds = first.textLineFragments.first?.typographicBounds ?? .zero
    return (
      CGRect(x: 0, y: union.minY, width: containerWidth, height: union.height),
      CGRect(x: 0, y: first.layoutFragmentFrame.minY + lineBounds.minY, width: containerWidth, height: lineBounds.height)
    )
  }
}
