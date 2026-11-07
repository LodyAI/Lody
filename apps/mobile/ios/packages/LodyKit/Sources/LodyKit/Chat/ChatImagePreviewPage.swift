import UIKit

final class ChatImagePreviewPage: UIView, UIScrollViewDelegate {
  let scroll = UIScrollView()
  let photo = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let retry = UIButton(type: .system)
  private var item: ChatImagePreviewItem?
  private var workspace = ""
  private var session = ""
  private var safeTop: CGFloat = 0
  private var safeBottom: CGFloat = 0
  private var task: URLSessionDataTask?
  private var requestID = UUID()
  private var laidOutSize = CGSize.zero

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroll.delegate = self
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = ChatImagePreviewGeometry.maxScale
    scroll.contentInsetAdjustmentBehavior = .never
    scroll.showsHorizontalScrollIndicator = false
    scroll.showsVerticalScrollIndicator = false
    addSubview(scroll)
    photo.contentMode = .scaleAspectFit
    photo.clipsToBounds = true
    photo.layer.cornerCurve = .continuous
    photo.isAccessibilityElement = true
    photo.accessibilityTraits = .image
    scroll.addSubview(photo)
    spinner.color = .white
    addSubview(spinner)
    retry.setTitle(String(localized: "native.chat.image.retry", bundle: .lody), for: .normal)
    retry.tintColor = .white
    retry.backgroundColor = UIColor(white: 0.15, alpha: 0.9)
    retry.layer.cornerRadius = 12
    retry.addAction(UIAction { [weak self] _ in self?.reload() }, for: .touchUpInside)
    addSubview(retry)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  deinit { task?.cancel() }

  func configure(
    item: ChatImagePreviewItem,
    placeholder: UIImage?,
    workspace: String,
    session: String,
    safeTop: CGFloat,
    safeBottom: CGFloat
  ) {
    let same = self.item == item && self.workspace == workspace && self.session == session
    self.item = item
    self.workspace = workspace
    self.session = session
    self.safeTop = safeTop
    self.safeBottom = safeBottom
    photo.accessibilityLabel = item.image.fileName
    if let placeholder { photo.image = placeholder }
    if same, photo.image != nil, task == nil { return }
    reload()
  }

  func reload() {
    task?.cancel()
    retry.isHidden = true
    guard let item else { return }
    if let uri = item.localURI, let url = URL(string: uri), url.isFileURL {
      requestID = UUID()
      photo.image = ChatAttachment.thumbnail(url) ?? photo.image
      spinner.stopAnimating()
      retry.isHidden = photo.image != nil
      layoutImage()
      return
    }
    if LodyUIVerify.enabled, ChatImageCell.isVerifyImage(item.image.id) {
      requestID = UUID()
      photo.image = ChatImageCell.verifyBitmap()
      spinner.stopAnimating()
      retry.isHidden = true
      layoutImage()
      return
    }
    if let remote = item.remoteURL {
      fetch(remote, fallback: nil)
      return
    }
    guard !workspace.isEmpty, !session.isEmpty, !item.image.id.isEmpty else {
      spinner.stopAnimating()
      retry.isHidden = photo.image != nil
      layoutImage()
      return
    }
    let storage = item.image.storageSessionId ?? session
    let thumbnail = SessionAttachments.imageThumbnailURL(
      workspace: workspace, session: storage, imageId: item.image.id, width: 768
    )
    let original = SessionAttachments.imageDownloadURL(
      workspace: workspace, session: storage, imageId: item.image.id
    )
    fetch(thumbnail, fallback: original)
  }

  func resetZoom() {
    scroll.zoomScale = 1
    centerPhoto()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scroll.frame = bounds
    spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    retry.frame = CGRect(x: 24, y: bounds.midY + 36, width: bounds.width - 48, height: 44)
    if laidOutSize != bounds.size {
      laidOutSize = bounds.size
      layoutImage()
    } else {
      centerPhoto()
    }
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { photo }
  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centerPhoto()
    let scale = max(scroll.zoomScale, 0.01)
    photo.layer.cornerRadius = ChatImagePreviewGeometry.cornerRadius / scale
    photo.accessibilityValue = "\(Int(scroll.zoomScale * 100))%"
  }

  private func fetch(_ url: URL, fallback: URL?) {
    guard let token = try? AuthKeychain.read() else {
      spinner.stopAnimating()
      retry.isHidden = photo.image != nil
      return
    }
    let requestID = UUID()
    self.requestID = requestID
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("image/*,*/*", forHTTPHeaderField: "Accept")
    spinner.startAnimating()
    task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let valid = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
      let image = valid ? data.flatMap(UIImage.init(data:)) : nil
      DispatchQueue.main.async {
        guard let self, self.requestID == requestID else { return }
        self.spinner.stopAnimating()
        if let image {
          self.task = nil
          self.photo.image = image
          self.retry.isHidden = true
          self.layoutImage()
          return
        }
        if let fallback {
          self.fetch(fallback, fallback: nil)
          return
        }
        self.task = nil
        self.retry.isHidden = self.photo.image != nil
      }
    }
    task?.resume()
  }

  private func layoutImage() {
    scroll.zoomScale = 1
    let image = photo.image?.size ?? CGSize(width: 1, height: 1)
    let box = ChatImagePreviewGeometry.box(
      viewport: ChatImagePreviewGeometry.Size(width: bounds.width, height: bounds.height),
      safeTop: safeTop,
      safeBottom: safeBottom
    )
    let fit = ChatImagePreviewGeometry.fitWithin(
      ChatImagePreviewGeometry.Size(width: image.width, height: image.height), in: box
    )
    photo.frame = CGRect(origin: .zero, size: CGSize(width: fit.width, height: fit.height))
    photo.layer.cornerRadius = ChatImagePreviewGeometry.cornerRadius
    scroll.contentSize = photo.frame.size
    centerPhoto()
  }

  private func centerPhoto() {
    let x = max(0, (scroll.bounds.width - photo.frame.width) / 2)
    let y = max(0, (scroll.bounds.height - photo.frame.height) / 2)
    scroll.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    photo.accessibilityValue = "\(Int(scroll.zoomScale * 100))%"
  }
}
