import UIKit
import UniformTypeIdentifiers

@MainActor
enum ShareIngest {
  struct Draft {
    var text = ""
    var attachments: [ChatAttachment] = []
    var dropped = 0
  }

  static func load(_ providers: [NSItemProvider]) async -> Draft {
    var draft = Draft()
    var texts: [String] = []
    for provider in providers {
      if let type = ChatAttachment.transferType(for: provider) {
        if let attachment = await attachment(provider, type: type) { draft.attachments.append(attachment) }
        else { draft.dropped += 1 }
      } else if let text = await text(provider), !text.isEmpty, !texts.contains(text) {
        texts.append(text)
      }
    }
    draft.text = texts.joined(separator: "\n\n")
    if draft.text.utf8.count > ShareStore.limits.textBytes, let file = ChatAttachment.makePastedTextFile(draft.text) {
      draft.attachments.insert(file, at: 0)
      draft.text = ""
    }
    var images = 0
    var files = 0
    draft.attachments = draft.attachments.filter { item in
      let fits = item.isImage ? images < ShareStore.limits.images : files < ShareStore.limits.files
      guard fits, images + files < ShareStore.limits.total else {
        draft.dropped += 1
        try? FileManager.default.removeItem(at: item.url)
        return false
      }
      if item.isImage { images += 1 } else { files += 1 }
      return true
    }
    return draft
  }

  private static func attachment(_ provider: NSItemProvider, type: UTType) async -> ChatAttachment? {
    let name = provider.suggestedName
    return await withCheckedContinuation { continuation in
      if type == .fileURL {
        _ = provider.loadObject(ofClass: URL.self) { url, _ in
          continuation.resume(returning: url.flatMap {
            ChatAttachment.make(suggestedName: name, type: UTType(filenameExtension: $0.pathExtension) ?? .data, source: $0)
          })
        }
        return
      }
      _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        continuation.resume(returning: url.flatMap { ChatAttachment.make(suggestedName: name, type: type, source: $0) })
      }
    }
  }

  private static func text(_ provider: NSItemProvider) async -> String? {
    if provider.canLoadObject(ofClass: URL.self) {
      let url: URL? = await withCheckedContinuation { continuation in
        _ = provider.loadObject(ofClass: URL.self) { value, _ in continuation.resume(returning: value) }
      }
      if let url, !url.isFileURL { return url.absoluteString }
    }
    if provider.canLoadObject(ofClass: String.self) {
      let text: String? = await withCheckedContinuation { continuation in
        _ = provider.loadObject(ofClass: String.self) { value, _ in continuation.resume(returning: value) }
      }
      if let text { return text }
    }
    // Some hosts register plain text that NSString cannot instantiate; read the raw item.
    guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) else { return nil }
    return await withCheckedContinuation { continuation in
      _ = provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
        switch item {
        case let text as String: continuation.resume(returning: text)
        case let text as NSAttributedString: continuation.resume(returning: text.string)
        case let data as Data: continuation.resume(returning: String(data: data, encoding: .utf8))
        default: continuation.resume(returning: nil)
        }
      }
    }
  }
}
