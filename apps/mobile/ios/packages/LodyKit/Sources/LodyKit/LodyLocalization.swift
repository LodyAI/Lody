import Foundation

extension Bundle {
  // Shared sources use the package bundle in the app and the host bundle in extensions.
  static var lody: Bundle {
    #if SWIFT_PACKAGE
    .module
    #else
    .main
    #endif
  }
}
