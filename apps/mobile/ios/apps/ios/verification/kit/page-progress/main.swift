import Foundation

// UIPageViewController(.scroll) parks the current page at offset.x ≈ width.
// Signed progress is (offset.x - width) / width: -1 previous, 0 current, +1 next.
let width: CGFloat = 390

precondition(
  LodyPageProgress.signedProgress(offsetX: width, width: width) == 0,
  "Resting offset must be the current page"
)
precondition(
  abs(LodyPageProgress.signedProgress(offsetX: width + width * 0.37, width: width) - 0.37) < 0.0001,
  "Dragging toward the next page is positive"
)
precondition(
  abs(LodyPageProgress.signedProgress(offsetX: width - width * 0.35, width: width) + 0.35) < 0.0001,
  "Dragging toward the previous page is negative"
)
precondition(
  LodyPageProgress.signedProgress(offsetX: width, width: 0) == 0,
  "A zero-width page must not divide"
)

// A cancelled swipe reports 0 → 0.4 → 0 against the same page index.
let cancelled = [0, 0.4, 0].map { fraction in
  LodyPageProgress.selectionPosition(
    page: 0,
    signedProgress: LodyPageProgress.signedProgress(offsetX: width + width * fraction, width: width),
    pageCount: 2
  )
}
precondition(cancelled == [0, 0.4, 0], "A bounce-back must not advance the page")

precondition(
  LodyPageProgress.selectionPosition(page: 0, signedProgress: 0.72, pageCount: 2) == 0.72,
  "Page 0 plus forward progress stays between the two segments"
)
precondition(
  LodyPageProgress.selectionPosition(page: 1, signedProgress: -0.25, pageCount: 2) == 0.75,
  "Page 1 plus reverse progress walks back toward page 0"
)
precondition(
  LodyPageProgress.selectionPosition(page: 0, signedProgress: -0.2, pageCount: 2) == 0,
  "Rubber-banding before the first page must clamp"
)
precondition(
  LodyPageProgress.selectionPosition(page: 1, signedProgress: 0.2, pageCount: 2) == 1,
  "Rubber-banding after the last page must clamp"
)

print("PASS: UIPageViewController signed progress maps offset onto the segment rail")
