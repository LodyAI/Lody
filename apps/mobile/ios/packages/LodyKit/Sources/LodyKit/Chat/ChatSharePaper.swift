import ImageIO
import Litext
import MarkdownParser
import MarkdownView
import UIKit

/// One fixed print layout is rasterized once; preview and sharing use that same JPEG.
@MainActor
final class ChatSharePaper: UIView {
  enum Failure: Error { case tooLarge, image, render }
  private static let inset: CGFloat = 48
  private static let ink = UIColor(red: 0.18, green: 0.17, blue: 0.15, alpha: 1)
  private static let light = UITraitCollection(userInterfaceStyle: .light)

  private static let paper: UIColor = {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 2
    format.preferredRange = .standard
    format.opaque = true
    let tile = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format).image { output in
      let context = output.cgContext
      UIColor(red: 0.982, green: 0.973, blue: 0.952, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
      var seed: UInt64 = 42
      func random() -> CGFloat {
        seed = seed &* 6364136223846793005 &+ 1
        return CGFloat((seed >> 32) % 10000) / 10000
      }
      for _ in 0..<4200 {
        let x = random() * 256, y = random() * 256
        context.setStrokeColor(UIColor(red: 0.46, green: 0.39, blue: 0.27, alpha: 0.025 + random() * 0.035).cgColor)
        context.setLineWidth(0.25)
        context.move(to: CGPoint(x: x, y: y))
        context.addLine(to: CGPoint(x: x + 0.4 + random() * 1.6, y: y + random() * 0.6))
        context.strokePath()
      }
    }
    return UIColor(patternImage: tile)
  }()

  static func make(_ content: ChatMessageShare, selected: Set<Int>? = nil) async throws -> ChatSharePaper {
    guard content.text.utf8.count <= 128 * 1024, content.parts.count <= 128 else { throw Failure.tooLarge }
    let paper = ChatSharePaper(frame: .zero)
    paper.overrideUserInterfaceStyle = .light
    paper.backgroundColor = Self.paper
    let width = ChatMessageShare.width - inset * 2
    let traits = light.modifyingTraits { $0.preferredContentSizeCategory = .large }
    var theme = ChatMarkdownTheme.make(traits: traits, secondary: false)
    theme.fonts.body = .systemFont(ofSize: 18)
    theme.fonts.bold = theme.fonts.body.bold
    theme.fonts.italic = theme.fonts.body.italic
    theme.colors.body = ink
    theme.colors.code = ink
    theme.spacings.paragraph = 14
    theme.spacings.headingBefore = 20
    theme.table.headerBackgroundColor = UIColor(white: 0, alpha: 0.035)
    theme.table.borderColor = UIColor(white: 0, alpha: 0.12)
    var y: CGFloat = 56
    var index = 0
    func included() -> Bool {
      defer { index += 1 }
      return selected?.contains(index) ?? true
    }
    for part in content.parts {
      try Task.checkCancellation()
      if let image = part.image, included() {
        let bitmap = try await loadImage(image: image, source: nil, content: content)
        let view = UIImageView(image: bitmap)
        let height = width * bitmap.size.height / max(1, bitmap.size.width)
        try append(view, width: width, height: height, y: &y, to: paper)
      }
      if let text = part.text {
        let parsed = MarkdownParser().parse(text)
        let chosen = parsed.document.filter { _ in included() }
        guard !chosen.isEmpty else { continue }
        let view = ShareMarkdownView()
        view.printWidth = width
        var sources = Set<String>()
        let blocks = chosen.rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
          if case let .image(source, _) = node { sources.insert(source) }
          return [node]
        }
        guard sources.count <= 16 else { throw Failure.tooLarge }
        for source in sources {
          view.images[source] = try await loadImage(image: nil, source: source, content: content)
        }
        let rewritten = blocks.rewrite { (node: MarkdownBlockNode) -> [MarkdownBlockNode] in
          guard case let .codeBlock(language, code) = node else { return [node] }
          let key = "\u{F0000}share-code:\(view.code.count)"
          view.code[key] = (language, code)
          return [.paragraph(content: [.text(key)])]
        }.rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
          if case let .image(source, _) = node { return [.text("\u{F0000}share-image:" + source)] }
          return [node]
        }
        let rendered = parsed.renderedContent(theme: theme)
        let images = view.images
        let code = view.code
        for block in rewritten {
          let view = ShareMarkdownView()
          view.printWidth = width
          view.images = images
          view.code = code
          view.overrideUserInterfaceStyle = .light
          view.setContentImmediately(MarkdownContent(blocks: [block], rendered: rendered, highlightMaps: [:]), theme: theme)
          // Tables keep every column. Expand to their natural width, then fit the
          // entire block into the page; never capture a horizontal scroll viewport.
          var layoutWidth = width
          for _ in 0..<4 {
            let height = view.boundingSize(for: layoutWidth).height
            guard height.isFinite, height <= ChatMessageShare.maximumHeight * 4 else { throw Failure.tooLarge }
            view.frame = CGRect(x: 0, y: 0, width: layoutWidth, height: height)
            view.layoutIfNeeded()
            let overflow = horizontalOverflow(view)
            if overflow <= 1 { break }
            layoutWidth += overflow
            guard layoutWidth <= 2400 else { throw Failure.tooLarge }
          }
          guard horizontalOverflow(view) <= 1 else { throw Failure.tooLarge }
          let scale = width / layoutWidth
          let height = ceil(view.bounds.height * scale)
          let container = UIView(frame: CGRect(x: 0, y: 0, width: width, height: height))
          view.transform = CGAffineTransform(scaleX: scale, y: scale)
          view.frame.origin = .zero
          container.addSubview(view)
          try append(container, width: width, height: height, y: &y, to: paper)
        }
      }
    }
    y += 24
    let model = UILabel()
    model.numberOfLines = 0
    model.font = .systemFont(ofSize: 11)
    model.textColor = UIColor(red: 0.42, green: 0.40, blue: 0.36, alpha: 1)
    model.text = content.model
    let modelHeight = max(16, model.sizeThatFits(CGSize(width: width - 65, height: .greatestFiniteMagnitude)).height)
    model.frame = CGRect(x: inset, y: y, width: width - 65, height: modelHeight)
    paper.addSubview(model)
    let brand = UILabel()
    brand.text = "Lody"
    brand.font = .systemFont(ofSize: 12, weight: .medium)
    brand.textColor = model.textColor
    brand.textAlignment = .right
    brand.frame = CGRect(x: ChatMessageShare.width - inset - 55, y: y, width: 55, height: 16)
    paper.addSubview(brand)
    let height = ceil(y + modelHeight + 48)
    guard ChatMessageShare.accepts(height: height) else { throw Failure.tooLarge }
    paper.frame.size = CGSize(width: ChatMessageShare.width, height: height)
    return paper
  }

  static func selections(_ content: ChatMessageShare) throws -> [[String: Any]] {
    guard content.text.utf8.count <= 128 * 1024, content.parts.count <= 128 else { throw Failure.tooLarge }
    var result: [[String: Any]] = []
    func append(_ kind: String, _ label: String) {
      result.append(["id": result.count, "kind": kind, "text": String(label.prefix(500)) + (label.count > 500 ? "…" : "")])
    }
    for part in content.parts {
      if let image = part.image { append("image", image.fileName) }
      guard let text = part.text else { continue }
      for block in MarkdownParser().parse(text).document {
        let kind: String
        switch block {
        case .heading: kind = "heading"
        case .codeBlock: kind = "code"
        case .table: kind = "table"
        case .blockquote: kind = "quote"
        case .bulletedList, .numberedList, .taskList: kind = "list"
        case .thematicBreak: kind = "divider"
        case .paragraph: kind = "paragraph"
        }
        var pieces: [String] = []
        _ = block.rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
          switch node {
          case let .text(text), let .code(text), let .html(text): pieces.append(text)
          case let .math(content, _): pieces.append(content)
          case .softBreak, .lineBreak: pieces.append(" ")
          default: break
          }
          return [node]
        }
        _ = block.rewrite { (node: MarkdownBlockNode) -> [MarkdownBlockNode] in
          if case let .codeBlock(_, text) = node { pieces.append(text) }
          return [node]
        }
        append(kind, pieces.joined(separator: " "))
      }
    }
    return result
  }

  private static func append(_ view: UIView, width: CGFloat, height: CGFloat, y: inout CGFloat, to paper: UIView) throws {
    guard ChatMessageShare.accepts(height: y + height + 88) else { throw Failure.tooLarge }
    view.frame = CGRect(x: inset, y: y, width: width, height: height)
    paper.addSubview(view)
    y += height + 16
  }

  private static func horizontalOverflow(_ root: UIView) -> CGFloat {
    var overflow: CGFloat = 0
    if let scroll = root as? UIScrollView { overflow = max(0, scroll.contentSize.width - scroll.bounds.width) }
    for view in root.subviews { overflow = max(overflow, horizontalOverflow(view)) }
    return overflow
  }

  private static func loadImage(image: ChatImage?, source: String?, content: ChatMessageShare) async throws -> UIImage {
    if LodyUIVerify.enabled, image.map({ ChatImageCell.isVerifyImage($0.id) }) == true { return ChatImageCell.verifyBitmap() }
    var request: URLRequest
    if let image {
      guard !content.workspace.isEmpty, !content.session.isEmpty, let token = try AuthKeychain.read() else { throw Failure.image }
      request = URLRequest(url: SessionAttachments.imageThumbnailURL(workspace: content.workspace, session: image.storageSessionId ?? content.session, imageId: image.id, width: 1080))
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    } else if let source, let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
      request = URLRequest(url: url)
    } else { throw Failure.image }
    request.timeoutInterval = 30
    let (url, response) = try await URLSession.shared.download(for: request)
    defer { try? FileManager.default.removeItem(at: url) }
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 20 * 1024 * 1024,
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let bitmap = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1080,
      ] as CFDictionary) else { throw Failure.image }
    return UIImage(cgImage: bitmap)
  }
}

private final class ShareMarkdownView: MarkdownTextView {
  var printWidth: CGFloat = 1
  var images: [String: UIImage] = [:]
  var code: [String: (String?, String)] = [:]

  override func decorate(inlineText text: NSAttributedString, theme: MarkdownTheme) -> NSAttributedString {
    let attachment = TextLabel.Attachment()
    if let (language, source) = code[text.string] {
      let view = UITextView()
      view.backgroundColor = UIColor(white: 0, alpha: 0.035)
      view.isScrollEnabled = false
      view.isEditable = false
      view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
      view.textContainer.lineFragmentPadding = 0
      view.textContainer.lineBreakMode = .byCharWrapping
      let style = NSMutableParagraphStyle()
      style.lineSpacing = 3
      style.lineBreakMode = .byCharWrapping
      let highlighted = NSMutableAttributedString(string: source, attributes: [.font: theme.fonts.code, .foregroundColor: theme.colors.code, .paragraphStyle: style])
      for (range, token) in CodeHighlighter.current.highlight(key: nil, content: source, language: language) where NSMaxRange(range) <= highlighted.length {
        highlighted.addAttribute(.foregroundColor, value: theme.syntax.color(for: token).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)), range: range)
      }
      view.attributedText = highlighted
      attachment.size = CGSize(width: printWidth, height: ceil(view.sizeThatFits(CGSize(width: printWidth, height: .greatestFiniteMagnitude)).height))
      attachment.view = view
    } else {
      let prefix = "\u{F0000}share-image:"
      guard text.string.hasPrefix(prefix), let image = images[String(text.string.dropFirst(prefix.count))] else { return text }
      attachment.size = CGSize(width: printWidth, height: printWidth * image.size.height / max(1, image.size.width))
      attachment.view = UIImageView(image: image)
    }
    return attachment.attributedString(attributes: [.font: theme.fonts.body])
  }
}
