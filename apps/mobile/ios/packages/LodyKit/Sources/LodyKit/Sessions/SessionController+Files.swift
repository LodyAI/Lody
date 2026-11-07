import UIKit

extension SessionController {
  @discardableResult
  func openFile(_ path: String, line: Int, from source: UIViewController? = nil) -> Task<Void, Never>? {
    guard !path.isEmpty, openingFiles.insert(path).inserted else { return nil }
    return Task { @MainActor [weak self] in
      guard let self else { return }
      // Quick Look awaits dismissal; ordinary pages transfer ownership to onClose.
      var pageOwnsRelease = false
      defer { if !pageOwnsRelease { self.openingFiles.remove(path) } }
      guard (source ?? self).view.window != nil else { return }
      if let runtime = DataRuntime.current,
         await FilePreview.open(sessionId: self.sessionId, path: path, line: line, runtime: runtime, from: source ?? self) {
        return
      }
      guard (source ?? self).view.window != nil else { return }
      pageOwnsRelease = true
      self.open("file-content", ["sessionId": self.sessionId, "path": path, "line": line], present: true, from: source) { [weak self] in
        self?.openingFiles.remove(path)
      }
    }
  }
}
