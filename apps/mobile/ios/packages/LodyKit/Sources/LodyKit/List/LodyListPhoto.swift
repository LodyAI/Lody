import UIKit

@MainActor
enum LodyListPhoto {
  enum Shape { case circle, original }

  nonisolated static let size = CGSize(width: 36, height: 36)
  private nonisolated static let rasterScale: CGFloat = 3
  private static let cache = NSCache<NSURL, UIImage>()
  private static let originals = NSCache<NSURL, UIImage>()
  private static var waiters: [URL: [(UIImage?) -> Void]] = [:]
  private static let disk = PhotoDiskCache(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("avatars-v1\(BackendEnvironment.storageSuffix)"))
  private static let photoIO = DispatchQueue(label: "ai.lody.avatar-cache", qos: .utility)
  private static var tasks: [URL: URLSessionDataTask] = [:]

  static func url(_ value: String) -> URL? {
    guard let url = URL(string: value), url.user == nil, url.password == nil else { return nil }
    let scheme = url.scheme?.lowercased()
    if scheme == "https" { return url }
    if scheme == "data", value.hasPrefix("data:image/") { return url }
    if url.isFileURL { return url }
    return nil
  }

  static func cached(_ url: URL, shape: Shape = .circle) -> UIImage? {
    (shape == .circle ? cache : originals).object(forKey: url as NSURL)
  }

  static func image(for url: URL, shape: Shape = .circle, ready: @escaping (UIImage) -> Void) -> UIImage? {
    if let image = cached(url, shape: shape) { return image }
    if url.isFileURL || url.scheme == "data" {
      load(url) { _ in }
      return cached(url, shape: shape)
    }
    load(url) { _ in
      if let image = cached(url, shape: shape) { ready(image) }
    }
    return nil
  }

  static func prime(_ url: URL, from source: URL) {
    guard let thumbnail = (try? Data(contentsOf: source)).flatMap(decode) else { return }
    _ = store(thumbnail, for: url)
  }

  private static func store(_ thumbnail: UIImage, for url: URL) -> UIImage {
    let image = circular(thumbnail)
    originals.setObject(thumbnail, forKey: url as NSURL)
    cache.setObject(image, forKey: url as NSURL)
    return image
  }

  static func load(_ url: URL, completion: @escaping (UIImage?) -> Void) {
    if let image = cached(url) {
      completion(image)
      return
    }
    if url.isFileURL || url.scheme == "data" {
      let image = (try? Data(contentsOf: url)).flatMap(decode).map { store($0, for: url) }
      completion(image)
      return
    }
    let loading = waiters[url] != nil
    waiters[url, default: []].append(completion)
    if loading { return }
    let disk = Self.disk
    photoIO.async {
      let thumbnail = disk.read(url).flatMap(decode)
      let fresh = disk.isFresh(url)
      DispatchQueue.main.async {
        if let thumbnail, fresh { finish(url, thumbnail: thumbnail) }
        else {
          if let thumbnail {
            let image = store(thumbnail, for: url)
            waiters[url]?.forEach { $0(image) }
          }
          download(url)
        }
      }
    }
  }

  private static func finish(_ url: URL, thumbnail: UIImage?) {
    tasks[url] = nil
    let image = thumbnail.map { store($0, for: url) }
    let callbacks = waiters.removeValue(forKey: url) ?? []
    callbacks.forEach { $0(image) }
  }

  private static func download(_ url: URL) {
    let disk = Self.disk
    let io = photoIO
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.setValue("image/*", forHTTPHeaderField: "Accept")
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
      let valid = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
      let thumbnail = valid ? data.flatMap(decode) : nil
      if thumbnail != nil, let data { io.async { disk.write(data, for: url) } }
      DispatchQueue.main.async { finish(url, thumbnail: thumbnail) }
    }
    tasks[url] = task
    task.resume()
  }

  static func apply(_ content: inout UIListContentConfiguration, image: UIImage, placeholder: Bool = false) {
    content.image = image
    content.imageProperties.maximumSize = size
    content.imageProperties.reservedLayoutSize = size
    content.imageProperties.cornerRadius = size.width / 2
    content.imageProperties.tintColor = placeholder ? .tertiaryLabel : nil
  }

  static func monogram(_ text: String, side: CGFloat) -> UIImage {
    let asset = UIImageAsset()
    for style in [UIUserInterfaceStyle.light, .dark] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      asset.register(draw(text, in: CGRect(x: 0, y: 0, width: side, height: side), traits: traits), with: traits)
    }
    return asset.image(with: .current)
  }

  private static func draw(_ text: String, in bounds: CGRect, traits: UITraitCollection) -> UIImage {
    UIGraphicsImageRenderer(bounds: bounds).image { _ in
      UIColor.lodyInk.resolvedColor(with: traits).setFill()
      UIBezierPath(ovalIn: bounds).fill()
      let label = NSAttributedString(string: text, attributes: [
        .font: UIFont.systemFont(ofSize: bounds.height * 0.4, weight: .semibold),
        .foregroundColor: UIColor.lodyGround.resolvedColor(with: traits),
      ])
      let size = label.size()
      label.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }.withRenderingMode(.alwaysOriginal)
  }

  nonisolated static func circular(_ image: UIImage) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    // Decoded CGImages have scale 1; keep the thumbnail pixel budget when masking.
    format.scale = rasterScale
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).addClip()
      let scale = max(size.width / max(image.size.width, 1), size.height / max(image.size.height, 1))
      image.draw(in: CGRect(
        x: (size.width - image.size.width * scale) / 2,
        y: (size.height - image.size.height * scale) / 2,
        width: image.size.width * scale,
        height: image.size.height * scale
      ))
    }.withRenderingMode(.alwaysOriginal)
  }

  private nonisolated static func decode(_ data: Data) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(size.width * rasterScale),
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: cg, scale: 1, orientation: .up).withRenderingMode(.alwaysOriginal)
  }
}

enum LodyListGlyph {
  static let symbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
  static let reservedSize = CGSize(
    width: UIListContentConfiguration.ImageProperties.standardDimension,
    height: UIListContentConfiguration.ImageProperties.standardDimension
  )

  static var size: CGSize {
    UIImage(systemName: "square", withConfiguration: symbolConfiguration)?.size
      ?? CGSize(
        width: UIFont.preferredFont(forTextStyle: .title3).pointSize,
        height: UIFont.preferredFont(forTextStyle: .title3).pointSize
      )
  }

  static func apply(_ content: inout UIListContentConfiguration, image: UIImage?, asset: Bool) {
    content.image = image
    content.imageProperties.preferredSymbolConfiguration = symbolConfiguration
    content.imageProperties.reservedLayoutSize = reservedSize
    if asset {
      content.imageProperties.maximumSize = size
    }
  }
}
