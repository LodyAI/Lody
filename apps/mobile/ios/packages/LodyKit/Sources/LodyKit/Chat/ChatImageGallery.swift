import Foundation

struct ChatImagePreviewItem: Equatable {
  let id: String
  let image: ChatImage
  let localURI: String?
  var remoteURL: URL? = nil
}

enum ChatImageGallery {
  static func items(from rows: [ChatRow]) -> [ChatImagePreviewItem] {
    rows.flatMap { row -> [ChatImagePreviewItem] in
      if row.kind == "image", let image = row.image {
        return [ChatImagePreviewItem(id: row.id, image: image, localURI: row.localImageURI)]
      }
      if row.kind == "attachments" {
        return row.attachments.compactMap { attachment in
          guard let image = attachment.image else { return nil }
          return ChatImagePreviewItem(
            id: row.entryID + ":attachment:" + (attachment.localID ?? attachment.id),
            image: image,
            localURI: attachment.localURI
          )
        }
      }
      return []
    }
  }

  static func index(of id: String, in items: [ChatImagePreviewItem]) -> Int? {
    items.firstIndex { $0.id == id }
  }
}
