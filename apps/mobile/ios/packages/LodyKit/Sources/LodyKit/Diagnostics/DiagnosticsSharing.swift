import Foundation
import UIKit

@MainActor
enum DiagnosticsSharing {
  static func present(_ file: URL, from controller: UIViewController, completion: @escaping (Error?) -> Void) {
    let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    share.popoverPresentationController?.sourceView = controller.view
    share.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
    share.completionWithItemsHandler = { _, _, _, error in
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
      completion(error)
    }
    controller.present(share, animated: true)
  }
}
