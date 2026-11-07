import ChatKit
import ImageIO
import Lexical
import PhotosUI
import QuickLook
import UIKit
import UniformTypeIdentifiers

struct ChatAttachment: Equatable {
  let id: String
  let name: String
  let url: URL
  let isImage: Bool

  /// Only for newly imported files that were never accepted into a draft.
  static func discardImports(_ items: [ChatAttachment]) {
    for item in items { try? FileManager.default.removeItem(at: item.url) }
  }

  static func thumbnail(_ url: URL) -> UIImage? {
    guard url.isFileURL, let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 768,
      ] as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
  }

  static func store(_ url: URL) -> URL? {
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue else { return nil }
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
    return (try? FileManager.default.copyItem(at: url, to: destination)) == nil ? nil : destination
  }

  static func store(_ data: Data, name: String) -> URL? {
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString + "-" + name)
    return (try? data.write(to: destination)) == nil ? nil : destination
  }

  static func isImage(type: UTType?, name: String) -> Bool {
    if let type, type.conforms(to: .movie) { return false }
    if let type, type.conforms(to: .image) { return true }
    guard let fileType = UTType(filenameExtension: (name as NSString).pathExtension) else { return false }
    return fileType.conforms(to: .image) && !fileType.conforms(to: .movie)
  }

  static func transferType(for provider: NSItemProvider) -> UTType? {
    if !provider.hasItemConformingToTypeIdentifier(UTType.livePhoto.identifier) {
      if let movie = provider.registeredContentTypes.first(where: { $0.conforms(to: .movie) }) { return movie }
      if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) { return .movie }
    }
    if let image = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) && !$0.conforms(to: .movie) }) {
      return image
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) { return .image }
    if isWebArchiveProvider(provider) { return nil }
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return .fileURL }
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) { return nil }
    return provider.registeredContentTypes.first { type in
      !type.conforms(to: .directory)
        && !type.conforms(to: .url)
        && !type.conforms(to: .text)
        && !isRichTextDocument(type)
        && type.identifier != LexicalConstants.pasteboardIdentifier
        && !isWebArchive(type)
    }
  }

  // UIKit synthesizes RTF and RTFD beside copied HTML; those are the selection's text, not a file.
  private static func isRichTextDocument(_ type: UTType) -> Bool {
    [UTType.rtf, .rtfd, .flatRTFD].contains { type.conforms(to: $0) }
  }

  private static func isWebArchiveProvider(_ provider: NSItemProvider) -> Bool {
    if isWebArchiveName(provider.suggestedName) { return true }
    if provider.hasItemConformingToTypeIdentifier("com.apple.webarchive") { return true }
    return provider.registeredContentTypes.contains(where: isWebArchive)
  }

  private static func isWebArchiveName(_ name: String?) -> Bool {
    guard let name, !name.isEmpty else { return false }
    return URL(fileURLWithPath: name).pathExtension.lowercased() == "webarchive"
  }

  private static func isWebArchive(_ type: UTType) -> Bool {
    if type.identifier == "com.apple.webarchive" || type.identifier == "Apple Web Archive pasteboard type" {
      return true
    }
    return type.preferredFilenameExtension?.lowercased() == "webarchive"
  }

  static func make(suggestedName: String?, type: UTType, source: URL, id: String? = nil) -> ChatAttachment? {
    guard source.isFileURL, !isWebArchiveName(source.lastPathComponent), !isWebArchiveName(suggestedName) else { return nil }
    guard let copy = store(source) else { return nil }
    var name = suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if name.isEmpty { name = source.lastPathComponent }
    if URL(fileURLWithPath: name).pathExtension.isEmpty {
      let suffix = source.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : source.pathExtension
      if !suffix.isEmpty { name += "." + suffix }
    }
    return ChatAttachment(id: id ?? UUID().uuidString, name: name, url: copy, isImage: isImage(type: type, name: name))
  }

  static func canPaste(_ providers: [NSItemProvider]) -> Bool {
    providers.contains { transferType(for: $0) != nil }
  }

  static let pastedTextName = "Text.txt"

  static func shouldPromotePastedText(_ text: String) -> Bool {
    if text.count >= 2000 { return true }
    var lines = 1
    for character in text where character.isNewline {
      lines += 1
      if lines > 15 { return true }
    }
    return false
  }

  static func makePastedTextFile(_ text: String, name: String = pastedTextName) -> ChatAttachment? {
    guard let url = store(Data(text.utf8), name: name) else { return nil }
    return ChatAttachment(id: UUID().uuidString, name: name, url: url, isImage: false)
  }

  @discardableResult
  static func paste(_ providers: [NSItemProvider], completion: @escaping ([ChatAttachment]) -> Void) -> Bool {
    let items = providers.enumerated().compactMap { index, provider in
      transferType(for: provider).map { (index, provider, $0) }
    }
    guard !items.isEmpty else { return false }
    let group = DispatchGroup()
    let pasted = ChatAttachmentCollector()
    for (index, provider, type) in items {
      group.enter()
      let suggestedName = provider.suggestedName
      if type == .fileURL {
        provider.loadObject(ofClass: NSURL.self) { object, _ in
          defer { group.leave() }
          guard let source = object as? URL, source.isFileURL,
                let item = make(suggestedName: suggestedName, type: UTType(filenameExtension: source.pathExtension) ?? .item, source: source) else { return }
          pasted.add(index, item)
        }
      } else {
        provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { source, _ in
          defer { group.leave() }
          guard let source, let item = make(suggestedName: suggestedName, type: type, source: source) else { return }
          pasted.add(index, item)
        }
      }
    }
    group.notify(queue: .main) {
      let ordered = pasted.ordered
      if !ordered.isEmpty { completion(ordered) }
    }
    return true
  }
}

final class ChatAttachmentCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [(Int, ChatAttachment)] = []

  func add(_ index: Int, _ item: ChatAttachment) {
    lock.lock()
    items.append((index, item))
    lock.unlock()
  }

  var ordered: [ChatAttachment] {
    lock.lock()
    defer { lock.unlock() }
    return items.sorted { $0.0 < $1.0 }.map(\.1)
  }
}

final class ChatAttachmentPicker: NSObject, UIDocumentPickerDelegate {
  var onPick: (([ChatAttachment]) -> Void)?

  func files(from controller: UIViewController) {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
    picker.allowsMultipleSelection = true
    picker.delegate = self
    controller.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    let picked = urls.compactMap { url -> ChatAttachment? in
      guard let copy = ChatAttachment.store(url) else { return nil }
      let name = url.lastPathComponent
      return ChatAttachment(
        id: UUID().uuidString,
        name: name,
        url: copy,
        isImage: ChatAttachment.isImage(type: UTType(filenameExtension: url.pathExtension), name: name)
      )
    }
    guard !picked.isEmpty else { return }
    onPick?(picked)
  }
}

final class ChatPhotoLibraryPicker: NSObject, PHPickerViewControllerDelegate {
  var onPick: (([ChatAttachment]) -> Void)?

  func present(from controller: UIViewController, fullScreen: Bool = false) {
    var config = PHPickerConfiguration(photoLibrary: .shared())
    config.filter = .any(of: [.images, .videos])
    config.preferredAssetRepresentationMode = .current
    config.selectionLimit = 10
    config.selection = .ordered
    let picker = PHPickerViewController(configuration: config)
    if fullScreen { picker.modalPresentationStyle = .fullScreen }
    picker.delegate = self
    controller.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard !results.isEmpty else { picker.dismiss(animated: true); return }
    let group = DispatchGroup()
    let picked = ChatAttachmentCollector()
    for (index, result) in results.enumerated() {
      let provider = result.itemProvider
      guard let type = ChatAttachment.transferType(for: provider) else { continue }
      group.enter()
      let suggestedName = provider.suggestedName
      let assetIdentifier = result.assetIdentifier
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        defer { group.leave() }
        guard let url,
          let item = ChatAttachment.make(suggestedName: suggestedName, type: type, source: url, id: assetIdentifier) else { return }
        picked.add(index, item)
      }
    }
    group.notify(queue: .main) { [weak self] in
      let ordered = picked.ordered
      picker.dismiss(animated: true) { [weak self] in
        guard !ordered.isEmpty else { return }
        self?.onPick?(ordered)
      }
    }
  }
}

final class ChatAttachmentPreview: QLPreviewController, QLPreviewControllerDataSource {
  private let urls: [URL]

  init(_ items: [ChatAttachment], index: Int) {
    urls = items.map(\.url)
    super.init(nibName: nil, bundle: nil)
    dataSource = self
    currentPreviewItemIndex = index
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { urls[index] as NSURL }
}

/// Converts local draft files to the package's display-only attachment model.
final class ChatAttachmentBar: CKAttachmentStrip {
  private var projected: [String: (source: ChatAttachment, item: CKAttachmentItem)] = [:]

  static let thumbnailRadius: CGFloat = 10

  init() {
    var style = CKAttachmentStyle()
    style.tiles = true
    style.spacing = 6
    style.maximumWidth = 180
    super.init(style: style)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private static func detail(_ url: URL) -> String? {
    guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber else { return nil }
    return ByteCountFormatter.string(fromByteCount: size.int64Value, countStyle: .file)
  }

  func handoffDestination(id: String) -> UIView? {
    layoutIfNeeded()
    guard let frame = attachmentFrame(id: id) else { return nil }
    scrollRectToVisible(frame, animated: true)
    return thumbnailView(id: id)
  }

  func render(_ attachments: [ChatAttachment], animatedRemoval: Bool = false) {
    let items = attachments.map { attachment -> CKAttachmentItem in
      if let cached = projected[attachment.id], cached.source == attachment { return cached.item }
      let type = UTType(filenameExtension: (attachment.name as NSString).pathExtension)
      let symbol: String
      if attachment.isImage { symbol = "photo" }
      else if type?.conforms(to: .movie) == true { symbol = "video" }
      else { symbol = "doc" }
      let thumbnail = attachment.isImage ? ChatAttachment.thumbnail(attachment.url)?.preparingThumbnail(of: CGSize(width: 96, height: 96)) : nil
      let item = CKAttachmentItem(id: attachment.id, name: attachment.name, symbol: symbol, thumbnail: thumbnail,
        detail: attachment.isImage ? nil : Self.detail(attachment.url),
        previewAccessibilityLabel: String.localizedStringWithFormat(String(localized: "native.chat.attachment.preview", bundle: .lody), String(describing: attachment.name)),
        removeAccessibilityLabel: String.localizedStringWithFormat(String(localized: "native.chat.attachment.remove", bundle: .lody), String(describing: attachment.name)))
      projected[attachment.id] = (attachment, item)
      return item
    }
    let ids = Set(attachments.map(\.id))
    projected = projected.filter { ids.contains($0.key) }
    super.render(items, animatedRemoval: animatedRemoval)
  }
}

extension UIPasteboard {
  func setMessageMarkdown(_ markdown: String) {
    items = [[UTType.utf8PlainText.identifier: markdown, "net.daringfireball.markdown": Data(markdown.utf8)]]
  }
}
