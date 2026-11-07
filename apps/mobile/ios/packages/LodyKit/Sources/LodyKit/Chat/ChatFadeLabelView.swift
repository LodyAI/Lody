import ChatKitCore
import ChatKit
import CoreText
import Litext
import UIKit

final class ChatFadeLayout: TextLabel.Layout {
  var fades: () -> [CKTextFade.RangeFade] = { [] }
  var shines: () -> Bool = { false }
  var displayScale: () -> CGFloat = { 1 }

  override func draw(in context: CGContext, visibleRect: CGRect?) {
    super.draw(in: context, visibleRect: visibleRect)
    guard shines() else { return }
    let textWidth = min(
      containerSize.width,
      max(1, sizeThatFits(CGSize(width: containerSize.width, height: .greatestFiniteMagnitude)).width)
    )
    let bounds = CGRect(origin: .zero, size: containerSize)
    let overlay = CKTextShine.overlay(
      for: CGRect(x: 0, y: 0, width: textWidth, height: containerSize.height),
      height: containerSize.height,
      at: CACurrentMediaTime()
    )
    guard let mask = CKTextShine.mask(
      size: containerSize,
      scale: displayScale(),
      overlay: overlay
    ) else { return }
    context.saveGState()
    context.clip(to: bounds, mask: mask)
    context.setBlendMode(.copy)
    context.setAlpha(0.32)
    super.draw(in: context, visibleRect: visibleRect)
    context.restoreGState()
  }

  override func draw(line: CTLine, at index: Int, in context: CGContext) {
    let time = CACurrentMediaTime()
    let lineRange = CTLineGetStringRange(line)
    let ranges = fades()
    var lower = 0
    var upper = ranges.count
    while lower < upper {
      let middle = (lower + upper) / 2
      if NSMaxRange(ranges[middle].range) <= lineRange.location { lower = middle + 1 }
      else { upper = middle }
    }
    var end = lower
    while end < ranges.count && ranges[end].range.location < lineRange.location + lineRange.length { end += 1 }
    let active = ranges[lower..<end].filter { $0.opacity(at: time) < 1 }
    guard !active.isEmpty else { CTLineDraw(line, context); return }
    func opacity(at character: CFIndex) -> CGFloat {
      var low = 0
      var high = active.count
      while low < high {
        let middle = (low + high) / 2
        if NSMaxRange(active[middle].range) <= character { low = middle + 1 }
        else { high = middle }
      }
      guard low < active.count, NSLocationInRange(character, active[low].range) else { return 1 }
      return CGFloat(active[low].opacity(at: time))
    }
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
      let count = CTRunGetGlyphCount(run)
      guard count > 0 else { continue }
      let runRange = CTRunGetStringRange(run)
      guard active.contains(where: { NSIntersectionRange($0.range, NSRange(location: runRange.location, length: runRange.length)).length > 0 }) else {
        CTRunDraw(run, context, CFRange(location: 0, length: 0))
        continue
      }
      var indices = [CFIndex](repeating: 0, count: count)
      CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
      var start = 0
      var current = opacity(at: indices[0])
      for glyph in 1...count {
        let next = glyph < count ? opacity(at: indices[glyph]) : -1
        guard next != current else { continue }
        context.saveGState()
        context.setAlpha(current)
        CTRunDraw(run, context, CFRange(location: start, length: glyph - start))
        context.restoreGState()
        start = glyph
        current = next
      }
    }
  }
}

/// Fades newly rendered graphemes in while a message streams. Ticks only redraw;
/// they never touch the attributed string or the layout.
final class ChatFadeLabelView: TextLabelView {
  private var fade = CKTextFade()
  private var timer: Timer?
  private var animateNext = false
  private var resetNext = false
  private var wasAnimating = false
  private var shineEnabled = false
  private weak var fadeLayout: ChatFadeLayout?
  private var fadeRect: CGRect?
  private var fadeRectSize: CGSize = .zero
  var isFading: Bool {
    window != nil && !UIAccessibility.isReduceMotionEnabled && fade.isAnimating(at: CACurrentMediaTime())
  }

  func setShine(_ on: Bool) {
    guard shineEnabled != on else { pokeTimer(); return }
    shineEnabled = on
    setNeedsDisplay()
    pokeTimer()
  }

  func prepare(animate: Bool, reset: Bool) {
    animateNext = animate
    if reset { resetNext = true }
  }

  override var attributedText: NSAttributedString {
    didSet {
      fadeRect = nil
      let animate = animateNext && window != nil && !UIAccessibility.isReduceMotionEnabled
      guard animate else { finishAnimation(); return }
      if resetNext {
        fade.update("", animate: false, at: CACurrentMediaTime(), reset: true)
      } else if !wasAnimating {
        fade.update(oldValue.string, animate: false, at: CACurrentMediaTime(), reset: true)
      }
      fade.update(attributedText.string, animate: animate, at: CACurrentMediaTime())
      resetNext = false
      wasAnimating = true
      pokeTimer()
    }
  }

  func finishAnimation() {
    fade = CKTextFade()
    wasAnimating = false
    resetNext = false
    timer?.invalidate()
    timer = nil
    setNeedsDisplay()
    pokeTimer()
  }

  override func makeTextLayout(_ attributedText: NSAttributedString) -> TextLabel.Layout {
    let layout = ChatFadeLayout(attributedString: attributedText)
    fadeLayout = layout
    layout.fades = { [weak self] in self?.fade.active ?? [] }
    layout.shines = { [weak self] in
      self?.shineEnabled == true && !UIAccessibility.isReduceMotionEnabled
    }
    layout.displayScale = { [weak self] in max(1, self?.traitCollection.displayScale ?? 1) }
    return layout
  }

  private func redrawFade() {
    guard !shineEnabled, let layout = fadeLayout, layout.containerSize == bounds.size,
          let first = fade.active.first, let last = fade.active.last else {
      setNeedsDisplay()
      return
    }
    if fadeRect == nil || fadeRectSize != bounds.size {
      fadeRectSize = bounds.size
      let range = NSUnionRange(first.range, last.range)
      let rect = layout.rects(for: range).reduce(CGRect.null) { $0.union($1) }
      if !rect.isNull {
        // Rects are in CoreText coordinates. Include whole line width and a
        // little ink overhang; UIKit retains all pixels outside this dirty area.
        fadeRect = CGRect(x: 0, y: bounds.height - rect.maxY - 4,
          width: bounds.width, height: rect.height + 8).intersection(bounds)
      }
    }
    if let fadeRect { setNeedsDisplay(fadeRect) }
    else { setNeedsDisplay() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { finishAnimation() }
    pokeTimer()
  }

  private func pokeTimer() {
    let keep = window != nil && !UIAccessibility.isReduceMotionEnabled
      && (shineEnabled || fade.isAnimating(at: CACurrentMediaTime()))
    guard keep else { timer?.invalidate(); timer = nil; return }
    guard timer == nil else { return }
    let ticker = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
      guard self != nil else { timer.invalidate(); return }
      MainActor.assumeIsolated {
        guard let self else { return }
        self.redrawFade()
        if self.window == nil || UIAccessibility.isReduceMotionEnabled
          || !(self.shineEnabled || self.fade.isAnimating(at: CACurrentMediaTime())) {
          self.timer?.invalidate()
          self.timer = nil
        }
      }
    }
    timer = ticker
    RunLoop.main.add(ticker, forMode: .common)
  }
}
