import UIKit

enum LodyAppIconError: Error {
  case unknown
  case unavailable
}

@MainActor
enum LodyAppIcon {
  static let names = ["default", "Aqua"]

  static var current: String { UIApplication.shared.alternateIconName ?? "default" }

  static func set(_ name: String, completion: @escaping @MainActor (Result<String, Error>) -> Void) {
    guard names.contains(name) else { return completion(.failure(LodyAppIconError.unknown)) }
    let app = UIApplication.shared
    let alternate = name == "default" ? nil : name
    guard app.alternateIconName != alternate else {
      return completion(.success(name))
    }
    guard app.supportsAlternateIcons else { return completion(.failure(LodyAppIconError.unavailable)) }
    app.setAlternateIconName(alternate) { error in
      DispatchQueue.main.async {
        if let error { return completion(.failure(error)) }
        completion(.success(current))
      }
    }
  }
}
