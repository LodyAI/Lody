import Foundation

enum LodyHomeLayout {
  case compact, tall, wide, book

  init(size: CGSize, regular: Bool, book: Bool) {
    if !regular || size.width <= 0 || size.height <= 0 { self = .compact }
    else if size.width < size.height { self = .tall }
    else if book { self = .book }
    else { self = .wide }
  }

  var sideBySide: Bool { self == .wide || self == .book }
}
