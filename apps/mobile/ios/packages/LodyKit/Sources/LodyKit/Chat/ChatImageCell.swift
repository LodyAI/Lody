import UIKit

/// A separate row keeps image geometry out of text measurement and message bubbles.
final class ChatImageCell: UICollectionViewCell {
  private var photo = UIImageView()
  var compact = false
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let failure = UILabel()
  private var image: ChatImage?
  private var workspace = ""
  private var session = ""
  private var handoffEntryID: String?
  private var requestURL: URL?
  private var requestID = UUID()
  private var task: URLSessionDataTask?

  override init(frame: CGRect) {
    super.init(frame: frame)
    photo.contentMode = .scaleAspectFit
    photo.backgroundColor = .lodyInset
    photo.layer.cornerRadius = 16
    photo.layer.cornerCurve = .continuous
    photo.clipsToBounds = true
    photo.layer.borderWidth = 0.5
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (cell: ChatImageCell, _) in cell.setNeedsLayout() }
    failure.text = String(localized: "native.chat.image.failed", bundle: .lody)
    failure.font = .preferredFont(forTextStyle: .caption1)
    failure.textColor = .secondaryLabel
    failure.textAlignment = .center
    failure.isHidden = true
    contentView.addSubview(photo)
    photo.addSubview(spinner)
    photo.addSubview(failure)
    isAccessibilityElement = true
    accessibilityTraits = [.image, .button]
    accessibilityHint = String(localized: "native.chat.image.openPreview", bundle: .lody)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func size(_ image: ChatImage, width: CGFloat) -> CGSize {
    let ratio = max(0.1, min(10, (image.width ?? 4) / (image.height ?? 3)))
    let maximum = min(240, width * 0.84)
    return ratio >= 1 ? CGSize(width: maximum, height: maximum / ratio) : CGSize(width: maximum * ratio, height: maximum)
  }
  func configure(_ row: ChatRow, workspace: String, session: String) {
    guard let image = row.image else { return }
    let hadLocalImage = requestURL?.isFileURL == true && handoffEntryID == row.entryID
    self.image = image
    self.workspace = workspace
    self.session = session
    if row.localImageURI != nil { handoffEntryID = row.entryID }
    else if !hadLocalImage { handoffEntryID = nil }
    accessibilityIdentifier = row.id
    accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.image.label", bundle: .lody), String(describing: image.fileName))
    setNeedsLayout()
    if let uri = row.localImageURI, let url = URL(string: uri), url.isFileURL {
      if requestURL == url, photo.image != nil { return }
      task?.cancel(); task = nil; requestURL = url; requestID = UUID()
      photo.image = ChatAttachment.thumbnail(url)
      spinner.stopAnimating(); failure.isHidden = photo.image != nil
      return
    }
    if LodyUIVerify.enabled, Self.isVerifyImage(image.id) {
      task?.cancel(); task = nil; requestURL = nil; requestID = UUID()
      photo.image = Self.verifyBitmap()
      spinner.stopAnimating(); failure.isHidden = true
      return
    }
    guard !workspace.isEmpty, !session.isEmpty, !image.id.isEmpty else {
      task?.cancel(); task = nil; requestURL = nil; requestID = UUID()
      photo.image = nil; spinner.stopAnimating(); failure.isHidden = false
      return
    }
    let storage = image.storageSessionId ?? session
    let thumbnail = SessionAttachments.imageThumbnailURL(
      workspace: workspace, session: storage, imageId: image.id, width: 768
    )
    let original = SessionAttachments.imageDownloadURL(
      workspace: workspace, session: storage, imageId: image.id
    )
    if requestURL == thumbnail && (task != nil || photo.image != nil) { return }
    if requestURL == original && (task != nil || photo.image != nil) { return }
    let requestID = UUID(); self.requestID = requestID
    task?.cancel(); requestURL = thumbnail
    if !hadLocalImage { photo.image = nil }
    failure.isHidden = true
    guard let token = try? AuthKeychain.read() else { failure.isHidden = false; return }
    fetch(thumbnail, fallback: original, requestID: requestID, token: token)
  }

  private func fetch(_ url: URL, fallback: URL?, requestID: UUID, token: String) {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("image/*,*/*", forHTTPHeaderField: "Accept")
    spinner.startAnimating()
    task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let valid = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
      let decoded = valid ? data.flatMap(UIImage.init(data:)) : nil
      DispatchQueue.main.async {
        guard let self, self.requestID == requestID else { return }
        if let decoded {
          self.task = nil
          self.spinner.stopAnimating()
          self.photo.image = decoded
          self.failure.isHidden = true
          return
        }
        if let fallback {
          self.requestURL = fallback
          self.fetch(fallback, fallback: nil, requestID: requestID, token: token)
          return
        }
        self.task = nil
        self.spinner.stopAnimating()
        self.failure.isHidden = self.photo.image != nil
      }
    }
    task?.resume()
  }
  override func prepareForReuse() {
    super.prepareForReuse()
    task?.cancel(); task = nil; requestURL = nil; requestID = UUID()
    photo.image = nil; spinner.stopAnimating(); failure.isHidden = true
  }

  var zoomSource: UIView { photo }
  var displayedImage: UIImage? { photo.image }

  static func isVerifyImage(_ id: String) -> Bool {
    id.hasPrefix("ui-verify-image")
  }

  static func verifyBitmap() -> UIImage {
    UIGraphicsImageRenderer(size: CGSize(width: 600, height: 400)).image { context in
      UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 600, height: 400))
      UIColor.white.setFill(); context.fill(CGRect(x: 100, y: 100, width: 400, height: 200))
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let image else { return }
    photo.layer.borderColor = UIColor.separator.resolvedColor(with: traitCollection).cgColor
    let size = compact ? contentView.bounds.size : Self.size(image, width: contentView.bounds.width)
    photo.frame = CGRect(x: 0, y: compact ? 0 : 6, width: size.width, height: size.height)
    spinner.center = CGPoint(x: size.width / 2, y: size.height / 2)
    failure.frame = photo.bounds.insetBy(dx: 4, dy: 4)
  }
}
