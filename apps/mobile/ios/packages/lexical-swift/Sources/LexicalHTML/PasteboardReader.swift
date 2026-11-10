import Foundation
import UIKit
import UniformTypeIdentifiers

public enum PasteKind: Sendable, Equatable {
  case markdown
  case html
  case plain
}

public struct PasteSource: Sendable, Equatable {
  public let kind: PasteKind
  public let text: String

  public init(kind: PasteKind, text: String) {
    self.kind = kind
    self.text = text
  }
}

public enum PasteboardReader {
  public static let markdownType = "net.daringfireball.markdown"

  public static func sources(_ providers: [NSItemProvider], plainTextOnly: Bool = false) async -> [PasteSource] {
    var sources: [PasteSource] = []
    if !plainTextOnly, let rich = providers.first(where: { hasRichText($0) }) {
      if rich.hasItemConformingToTypeIdentifier(markdownType), let text = await text(rich, markdownType) {
        sources.append(PasteSource(kind: .markdown, text: text))
      }
      if rich.hasItemConformingToTypeIdentifier(UTType.html.identifier), let html = await text(rich, UTType.html.identifier) {
        sources.append(PasteSource(kind: .html, text: html))
      } else if rich.hasItemConformingToTypeIdentifier(UTType.rtf.identifier), let data = await data(rich, UTType.rtf.identifier), let html = html(fromRTF: data) {
        sources.append(PasteSource(kind: .html, text: html))
      }
    }
    let textual = providers.filter { provider in
      [UTType.utf8PlainText, .plainText, .text].contains { provider.hasItemConformingToTypeIdentifier($0.identifier) }
    }
    var lines: [String] = []
    for provider in textual.isEmpty ? providers : textual {
      if let text = await plainText(provider), !text.isEmpty { lines.append(text) }
    }
    if !lines.isEmpty { sources.append(PasteSource(kind: .plain, text: lines.joined())) }
    return sources
  }

  private static func hasRichText(_ provider: NSItemProvider) -> Bool {
    [markdownType, UTType.html.identifier, UTType.rtf.identifier].contains { provider.hasItemConformingToTypeIdentifier($0) }
  }

  private static func plainText(_ provider: NSItemProvider) async -> String? {
    for type in [UTType.utf8PlainText.identifier, UTType.plainText.identifier] where provider.hasItemConformingToTypeIdentifier(type) {
      if let value = await text(provider, type) { return value }
    }
    guard provider.canLoadObject(ofClass: NSString.self) else { return nil }
    return await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: NSString.self) { object, _ in
        continuation.resume(returning: (object as? NSString) as String?)
      }
    }
  }

  private static func text(_ provider: NSItemProvider, _ type: String) async -> String? {
    guard let data = await data(provider, type) else { return nil }
    return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16)
  }

  private static func data(_ provider: NSItemProvider, _ type: String) async -> Data? {
    await withCheckedContinuation { continuation in
      _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
        continuation.resume(returning: data)
      }
    }
  }

  static func html(fromRTF data: Data) -> String? {
    guard let attributed = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil),
      let html = try? attributed.data(from: NSRange(location: 0, length: attributed.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.html])
    else { return nil }
    return String(data: html, encoding: .utf8)
  }
}
