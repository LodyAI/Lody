import LodyDesignSystem
import SwiftUI
import UIKit
import CoreImage

/// Web sidebar identity: the repository owner's cached avatar, gently muted.
struct RepositoryIcon: View {
  let repository: String
  var size: CGFloat = LodyIconSize.sm
  var opacity: Double = 0.6
  @State private var loaded: UIImage?
  @State private var loadedURL: URL?

  private var url: URL? { RepositoryImages.url(repository) }

  var body: some View {
    Group {
      if let url, loadedURL == url, let loaded {
        Image(uiImage: loaded).resizable().scaledToFill()
          .saturation(0.55).opacity(opacity)
      } else {
        LodyIcon.github.image.resizable().renderingMode(.template)
          .foregroundStyle(LodyColor.iconSecondary)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size / 5))
    .accessibilityHidden(true)
    .task(id: url) {
      guard let url else { return }
      if let image = LodyListPhoto.image(for: url, shape: .original, ready: { image in
        loadedURL = url
        loaded = image
      }) {
        loadedURL = url
        loaded = image
      }
    }
  }
}

/// UIKit list rows share the same muted treatment without changing user avatars.
@MainActor
enum RepositoryImages {
  static func url(_ repository: String) -> URL? {
    let parts = repository.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty,
          let owner = String(parts[0]).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
    return URL(string: "https://avatars.githubusercontent.com/\(owner)?size=96")
  }
  private static let cache = NSCache<NSURL, UIImage>()
  private static let context = CIContext()

  static func image(_ repository: String, ready: @escaping (UIImage) -> Void) -> UIImage? {
    guard let url = RepositoryImages.url(repository) else { return nil }
    return image(for: url, ready: ready)
  }

  static func image(for url: URL, ready: @escaping (UIImage) -> Void) -> UIImage? {
    if let cached = cache.object(forKey: url as NSURL) { return cached }
    func muted(_ image: UIImage) -> UIImage {
      guard let input = CIImage(image: image),
            let cg = context.createCGImage(input.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.55]), from: input.extent) else { return image }
      let size = CGSize(width: 36, height: 36)
      let result = UIGraphicsImageRenderer(size: size).image { _ in
        UIImage(cgImage: cg).draw(in: CGRect(origin: .zero, size: size), blendMode: .normal, alpha: 0.8)
      }.withRenderingMode(.alwaysOriginal)
      cache.setObject(result, forKey: url as NSURL)
      return result
    }
    return LodyListPhoto.image(for: url, shape: .original, ready: { ready(muted($0)) }).map(muted)
  }
}
