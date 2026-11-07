import Foundation

func layout(_ width: CGFloat, _ height: CGFloat, regular: Bool = true, book: Bool = false) -> LodyHomeLayout {
  LodyHomeLayout(size: CGSize(width: width, height: height), regular: regular, book: book)
}

// The same open display changes presentation only when the hinge is partially open.
precondition(layout(951, 669, book: true) == .book)
precondition(layout(951, 669) == .wide)
precondition(layout(951, 669).sideBySide)

// A horizontal fold and a compact window must not force two narrow pages.
precondition(layout(669, 951, book: true) == .tall)
precondition(!layout(669, 951, book: true).sideBySide)
precondition(layout(466, 678, regular: false, book: true) == .compact)
precondition(layout(951, 669, regular: false, book: true) == .compact)

// iPad uses available space, including live resizing and the square boundary.
precondition(layout(1194, 834) == .wide)
precondition(layout(834, 1194) == .tall)
precondition(layout(834, 834) == .wide)
precondition(layout(0, 0) == .compact)

print("PASS: book alone follows the fold; flat, tall and compact windows use their available space")
