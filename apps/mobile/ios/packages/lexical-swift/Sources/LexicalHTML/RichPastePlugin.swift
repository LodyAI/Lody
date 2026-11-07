import Foundation
import Lexical
import UIKit

// The editor is only touched on the main actor; providers are read once off it.
private final class PasteJob: @unchecked Sendable {
  let editor: Editor
  let providers: [NSItemProvider]

  init(_ editor: Editor, _ providers: [NSItemProvider]) {
    self.editor = editor
    self.providers = providers
  }
}

public final class RichPastePlugin: Plugin {
  private let paste: RichPaste
  private weak var editor: Editor?
  private var removeListener: (() -> Void)?

  public init(paste: RichPaste = .gfm) {
    self.paste = paste
  }

  public func setUp(editor: Editor) {
    self.editor = editor
    removeListener = editor.registerCommand(type: .paste, listener: { [weak self] payload in
      guard let self, let pasteboard = payload as? UIPasteboard else { return false }
      self.paste(pasteboard.itemProviders)
      return true
    }, priority: .High, shouldWrapInUpdateBlock: false)
  }

  public func tearDown() {
    removeListener?()
    removeListener = nil
  }

  public func paste(_ providers: [NSItemProvider], plainTextOnly: Bool = false) {
    guard let editor else { return }
    let job = PasteJob(editor, providers)
    let plain = plainTextOnly || ((try? paste.prefersPlainText(in: editor)) ?? false)
    let paste = self.paste
    Task.detached {
      let sources = await PasteboardReader.sources(job.providers, plainTextOnly: plain)
      guard let trial = try? paste.trial(sources, for: job.editor) else { return }
      await MainActor.run { try? paste.insert(trial, into: job.editor) }
    }
  }
}
