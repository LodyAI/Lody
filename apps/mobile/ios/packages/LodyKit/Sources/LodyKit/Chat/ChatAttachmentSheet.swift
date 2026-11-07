#if LODY_SHARE_EXTENSION
import AVFoundation
import Photos
import UIKit

private final class ChatPhotoCell: UICollectionViewCell {
  let image = UIImageView()
  private let badge = UIImageView()
  private let videoMark = UIImageView(image: UIImage(systemName: "video.fill"))
  var assetID: String?
  override init(frame: CGRect) {
    super.init(frame: frame)
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    image.backgroundColor = .tertiarySystemFill
    image.layer.cornerRadius = 6
    image.layer.cornerCurve = .continuous
    badge.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 20)
    badge.layer.shadowRadius = 2
    badge.layer.shadowOffset = .zero
    videoMark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)
    videoMark.tintColor = .white
    videoMark.layer.shadowOpacity = 0.45
    videoMark.layer.shadowRadius = 2
    videoMark.layer.shadowOffset = .zero
    videoMark.isHidden = true
    contentView.addSubview(image)
    contentView.addSubview(videoMark)
    contentView.addSubview(badge)
    image.translatesAutoresizingMaskIntoConstraints = false
    videoMark.translatesAutoresizingMaskIntoConstraints = false
    badge.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      image.topAnchor.constraint(equalTo: contentView.topAnchor), image.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      image.leadingAnchor.constraint(equalTo: contentView.leadingAnchor), image.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      videoMark.leadingAnchor.constraint(equalTo: image.leadingAnchor, constant: 6),
      videoMark.bottomAnchor.constraint(equalTo: image.bottomAnchor, constant: -6),
      badge.trailingAnchor.constraint(equalTo: image.trailingAnchor, constant: -5),
      badge.bottomAnchor.constraint(equalTo: image.bottomAnchor, constant: -5),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .image
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func mark(selected: Bool, video: Bool = false) {
    badge.image = UIImage(systemName: selected ? "checkmark.circle.fill" : "circle")
    badge.tintColor = selected ? .lodyAccent : .white.withAlphaComponent(0.9)
    badge.layer.shadowOpacity = selected ? 0 : 0.3
    image.layer.borderWidth = selected ? 2 : 0
    image.layer.borderColor = UIColor.lodyAccent.resolvedColor(with: traitCollection).cgColor
    videoMark.isHidden = !video
    accessibilityValue = selected ? String(localized: "native.chat.attachment.selected", bundle: .lody) : nil
  }
}

final class ChatAttachmentSheet: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  var onPick: (([ChatAttachment]) -> Void)?
  private let grid: UICollectionView
  private let status = UIStackView()
  private let statusLabel = UILabel()
  private let statusAction = UIButton(configuration: .filled())
  private let confirm = UIButton(configuration: .filled())
  private let confirmFade = LodyEdgeFade()
  private let manage = UIButton(configuration: .plain())
  private let footer = UIStackView()
  private let camera = ChatCameraCapture()
  private let cameraLibrary = ChatPhotoLibraryPicker()
  private lazy var cameraView = ChatAttachmentCameraView(
    session: camera.session,
    dismissKey: cameraOnly ? "native.close" : "native.chat.camera.collapse"
  )
  private var captured: [ChatAttachment] = []
  private var reviewing: ChatAttachment?
  private var handedOff = Set<String>()
  private var cameraExpanded = false
  private var cameraAnimating = false
  private var visible = false
  private let cameraOnly: Bool
  private var cameraCell: UICollectionViewCell?
  private var assets: PHFetchResult<PHAsset>?
  private var selection: [String] = []
  private let images = PHImageManager.default()

  init(cameraOnly: Bool = false) {
    self.cameraOnly = cameraOnly
    self.cameraExpanded = cameraOnly
    let layout = UICollectionViewFlowLayout()
    layout.minimumLineSpacing = 3
    layout.minimumInteritemSpacing = 3
    layout.sectionInset = UIEdgeInsets(top: 24, left: 16, bottom: 0, right: 16)
    grid = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = cameraOnly ? .fullScreen : .pageSheet
    sheetPresentationController?.detents = [.custom(identifier: .init("cameraAspect")) { [weak self] context in
      guard let self else { return context.maximumDetentValue }
      return min(context.maximumDetentValue, self.view.bounds.width * 4 / 3 - self.view.safeAreaInsets.bottom)
    }]
    sheetPresentationController?.prefersGrabberVisible = true
    sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = false
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var prefersStatusBarHidden: Bool { cameraOnly }
  override var prefersHomeIndicatorAutoHidden: Bool { cameraOnly }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    configureCamera()
    if cameraOnly {
      view.backgroundColor = .black
      view.accessibilityIdentifier = "camera-fullscreen"
      cameraView.setExpanded(true)
      cameraView.letterboxed = true
      view.addSubview(cameraView)
      return
    }
    grid.backgroundColor = .clear
    grid.dataSource = self
    grid.delegate = self
    grid.alwaysBounceVertical = true
    grid.accessibilityIdentifier = "attachment-grid"
    grid.contentInsetAdjustmentBehavior = .never
    view.clipsToBounds = true
    view.accessibilityIdentifier = "attachment-sheet"
    grid.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "camera")
    grid.register(UICollectionReusableView.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionFooter, withReuseIdentifier: "status")
    LodyScrollEdges.navigation(grid)
    grid.bottomEdgeEffect.isHidden = true
    grid.register(ChatPhotoCell.self, forCellWithReuseIdentifier: "photo")
    statusLabel.numberOfLines = 0
    statusLabel.textAlignment = .center
    statusLabel.font = .systemFont(ofSize: 15)
    statusLabel.textColor = .secondaryLabel
    statusAction.addAction(UIAction { [weak self] _ in self?.runStatusAction() }, for: .touchUpInside)
    status.axis = .vertical
    status.spacing = 16
    status.alignment = .center
    status.addArrangedSubview(statusLabel)
    status.addArrangedSubview(statusAction)
    manage.setTitle(String(localized: "native.chat.attachment.managePhotos", bundle: .lody), for: .normal)
    manage.isHidden = true
    manage.addAction(UIAction { [weak self] _ in self?.manageLimited() }, for: .touchUpInside)
    confirm.configuration?.cornerStyle = .capsule
    confirm.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 28, bottom: 14, trailing: 28)
    confirm.isHidden = true
    confirm.accessibilityIdentifier = "attachment-confirm"
    confirm.addAction(UIAction { [weak self] _ in self?.commit() }, for: .touchUpInside)
    footer.axis = .vertical
    footer.spacing = 8
    footer.alignment = .center
    footer.addArrangedSubview(manage)
    footer.addArrangedSubview(confirm)
    confirmFade.isHidden = true
    for item in [grid, confirmFade, footer] {
      item.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(item)
    }
    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: view.topAnchor),
      grid.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      grid.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      grid.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      confirmFade.topAnchor.constraint(equalTo: confirm.topAnchor, constant: -LodyEdgeFade.overlap),
      confirmFade.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      confirmFade.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      confirmFade.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      footer.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
      footer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
      confirm.heightAnchor.constraint(equalToConstant: 50),
      manage.heightAnchor.constraint(equalToConstant: 44),
    ])
    LodyScrollEdges.bind(grid, to: self)
    refresh()
  }

  deinit {
    for photo in captured where !handedOff.contains(photo.id) { try? FileManager.default.removeItem(at: photo.url) }
    if let reviewing { try? FileManager.default.removeItem(at: reviewing.url) }
    NotificationCenter.default.removeObserver(self)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    visible = true
    updateCameraSession()
    if cameraOnly { updateCameraSession(requestPermission: true) }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    visible = false
    camera.setActive(false)
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    if !cameraOnly { sheetPresentationController?.invalidateDetents() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let footerHeight = footer.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize).height
    grid.contentInset.bottom = view.safeAreaInsets.bottom + 12 + footerHeight
    grid.verticalScrollIndicatorInsets.bottom = grid.contentInset.bottom
    if cameraExpanded && !cameraAnimating {
      cameraView.controlInsets = view.safeAreaInsets
      cameraView.frame = view.bounds
      cameraView.setNeedsLayout()
    }
    updateCameraSession()
  }

  private func configureCamera() {
    camera.onReady = { [weak self] device, canFlip in
      guard let self, self.visible, self.reviewing == nil else { return }
      self.cameraView.setReady(device: device, canFlip: canFlip)
    }
    camera.onError = { [weak self] key in
      guard let self, self.visible else { return }
      self.cameraView.showError(key)
    }
    camera.onPhoto = { [weak self] photo in
      guard let self, self.visible, self.cameraExpanded, self.reviewing == nil else {
        try? FileManager.default.removeItem(at: photo.url)
        return
      }
      self.reviewing = photo
      self.cameraView.setPhoto(photo)
      self.camera.setActive(false)
      UIAccessibility.post(notification: .layoutChanged, argument: self.cameraView)
    }
    cameraView.onCollapse = { [weak self] in
      guard let self else { return }
      if self.cameraOnly {
        self.discardReview()
        self.dismiss(animated: true)
      } else {
        self.collapseCamera()
      }
    }
    cameraView.onShutter = { [weak self] flash, angle in self?.camera.capture(flash: flash, angle: angle) }
    cameraView.onLibrary = { [weak self] in
      guard let self else { return }
      if self.cameraOnly {
        self.cameraLibrary.present(from: self, fullScreen: true)
      } else {
        self.collapseCamera()
      }
    }
    cameraLibrary.onPick = { [weak self] picked in self?.finish(picked) }
    cameraView.onFlip = { [weak self] in self?.camera.flip() }
    cameraView.onFocus = { [weak self] point in self?.camera.focus(at: point) }
    cameraView.onRetry = { [weak self] in
      guard let self else { return }
      if !ChatCameraCapture.fixture && AVCaptureDevice.authorizationStatus(for: .video) == .denied {
        self.openSettings()
      } else {
        self.camera.setActive(false)
        self.updateCameraSession(requestPermission: true)
      }
    }
    cameraView.onRetake = { [weak self] in
      self?.discardReview()
      self?.updateCameraSession()
    }
    cameraView.onAdd = { [weak self] in
      guard let self, let photo = self.reviewing else { return }
      self.reviewing = nil
      if self.cameraOnly {
        self.finish([photo])
        return
      }
      self.captured.insert(photo, at: 0)
      self.selection.append(photo.id)
      self.collapseCamera()
    }
    NotificationCenter.default.addObserver(self, selector: #selector(cameraPaused), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(cameraResumed), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  @objc private func cameraPaused() { camera.setActive(false) }
  @objc private func cameraResumed() { updateCameraSession() }

  private func mountCameraTile() {
    guard !cameraExpanded, let cell = cameraCell else { return }
    cameraView.removeFromSuperview()
    cameraView.frame = cell.contentView.bounds
    cameraView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cameraView.layer.cornerRadius = 6
    cameraView.isUserInteractionEnabled = false
    cameraView.setExpanded(false)
    cell.contentView.addSubview(cameraView)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { updateCameraSession() }

  func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    if indexPath.item == 0 { updateCameraSession() }
  }

  func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    if indexPath.item == 0 {
      // A reload can retire the old cell after displaying its replacement.
      DispatchQueue.main.async { [weak self] in self?.updateCameraSession() }
    }
  }

  private func updateCameraSession(requestPermission: Bool = false) {
    let tile = grid.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: 0, section: 0))?.frame
    guard visible, view.window?.windowScene?.activationState == .foregroundActive, reviewing == nil,
      cameraExpanded || tile?.intersects(grid.bounds) == true else {
      camera.setActive(false)
      return
    }
    if ChatCameraCapture.fixture { camera.setActive(true); return }
    guard AVCaptureDevice.default(for: .video) != nil else {
      camera.setActive(false)
      cameraView.showError("native.chat.camera.unavailable", action: nil)
      return
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      camera.setActive(true)
    case .notDetermined:
      cameraView.showError("native.chat.camera.permission", action: "native.chat.camera.allow")
      if requestPermission {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
          DispatchQueue.main.async { self?.updateCameraSession() }
        }
      }
    case .denied:
      camera.setActive(false)
      cameraView.showError("native.chat.camera.denied", action: "native.chat.attachment.openSettings")
    default:
      camera.setActive(false)
      cameraView.showError("native.chat.camera.restricted", action: nil)
    }
  }

  private func openSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    view.window?.windowScene?.open(url, options: nil)
  }

  private var selectedImages: Int {
    var count = captured.filter { selection.contains($0.id) }.count
    assets?.enumerateObjects { asset, _, _ in
      if asset.mediaType == .image && self.selection.contains(asset.localIdentifier) { count += 1 }
    }
    return count
  }

  private func expandCamera() {
    guard !cameraExpanded, !cameraAnimating else { return }
    guard selection.count < 10, selectedImages < 8 else {
      let alert = UIAlertController(title: String(localized: "native.chat.composer.takePhoto", bundle: .lody),
        message: String(localized: "native.attachment.error.limit", bundle: .lody), preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: String(localized: "native.close", bundle: .lody), style: .cancel))
      present(alert, animated: true)
      return
    }
    grid.setContentOffset(CGPoint(x: 0, y: 0), animated: false)
    grid.layoutIfNeeded()
    guard let cell = grid.cellForItem(at: IndexPath(item: 0, section: 0)) else { return }
    cameraCell = cell
    let origin = cell.contentView.convert(cell.contentView.bounds, to: view)
    cameraExpanded = true
    cameraAnimating = true
    grid.isScrollEnabled = false
    grid.accessibilityElementsHidden = true
    status.accessibilityElementsHidden = true
    footer.accessibilityElementsHidden = true
    LodyScrollEdges.unbind(grid, from: self)
    cameraView.removeFromSuperview()
    cameraView.autoresizingMask = []
    cameraView.frame = origin
    cameraView.controlInsets = view.safeAreaInsets
    cameraView.isUserInteractionEnabled = true
    view.addSubview(cameraView)
    cameraView.prepareTransition(viewport: view.bounds.size)
    let duration = UIAccessibility.isReduceMotionEnabled ? 0 : 0.42
    UIView.animate(withDuration: duration, delay: 0, usingSpringWithDamping: 0.92, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
      self.cameraView.frame = self.view.bounds
      self.cameraView.layer.cornerRadius = 0
      self.cameraView.layoutIfNeeded()
      self.cameraView.setExpanded(true)
      self.view.backgroundColor = .black
      self.grid.alpha = 0
      self.status.alpha = 0
      self.footer.alpha = 0
    } completion: { _ in
      self.cameraAnimating = false
      self.cameraView.prepareTransition(viewport: nil)
      self.updateCameraSession(requestPermission: true)
      UIAccessibility.post(notification: .layoutChanged, argument: self.cameraView)
    }
  }

  private func discardReview() {
    if let reviewing { try? FileManager.default.removeItem(at: reviewing.url) }
    reviewing = nil
    cameraView.setPhoto(nil)
  }

  private func collapseCamera() {
    guard cameraExpanded, !cameraAnimating else { return }
    discardReview()
    cameraAnimating = true
    cameraView.prepareTransition(viewport: view.bounds.size)
    let destination = cameraCell?.contentView.convert(cameraCell?.contentView.bounds ?? .zero, to: view) ?? .zero
    UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.38, delay: 0,
      usingSpringWithDamping: 0.95, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
      self.cameraView.setExpanded(false)
      self.cameraView.frame = destination
      self.cameraView.layer.cornerRadius = 6
      self.view.backgroundColor = .lodyBackground
      self.grid.alpha = 1
      self.cameraView.layoutIfNeeded()
      self.status.alpha = 1
      self.footer.alpha = 1
    } completion: { _ in
      self.cameraExpanded = false
      self.cameraAnimating = false
      self.grid.isScrollEnabled = true
      self.grid.accessibilityElementsHidden = false
      self.status.accessibilityElementsHidden = false
      self.footer.accessibilityElementsHidden = false
      self.mountCameraTile()
      self.cameraView.prepareTransition(viewport: nil)
      self.refresh()
      LodyScrollEdges.bind(self.grid, to: self)
      self.updateCameraSession()
      UIAccessibility.post(notification: .layoutChanged, argument: self.cameraCell)
    }
  }

  private func refresh() {
    let auth = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    manage.isHidden = auth != .limited
    switch auth {
    case .authorized, .limited:
      let options = PHFetchOptions()
      options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
      options.fetchLimit = 60
      options.predicate = NSPredicate(
        format: "mediaType == %d OR mediaType == %d",
        PHAssetMediaType.image.rawValue,
        PHAssetMediaType.video.rawValue
      )
      assets = PHAsset.fetchAssets(with: options)
      status.isHidden = true
      loadLibraryThumbnail()
    case .notDetermined:
      assets = nil
      status.isHidden = false
      statusLabel.text = String(localized: "native.chat.attachment.limitedAccess", bundle: .lody)
      statusAction.setTitle(String(localized: "native.chat.attachment.allowAccess", bundle: .lody), for: .normal)
    default:
      assets = nil
      status.isHidden = false
      statusLabel.text = String(localized: "native.chat.attachment.accessDenied", bundle: .lody)
      statusAction.setTitle(String(localized: "native.chat.attachment.openSettings", bundle: .lody), for: .normal)
    }
    grid.reloadData()
    updateConfirm()
  }

  private func loadLibraryThumbnail() {
    guard let asset = assets?.firstObject else { return }
    let options = PHImageRequestOptions()
    options.deliveryMode = .opportunistic
    options.resizeMode = .fast
    images.requestImage(for: asset, targetSize: CGSize(width: 156, height: 156), contentMode: .aspectFill,
      options: options) { [weak self] image, _ in
      guard let image else { return }
      self?.cameraView.setLibraryThumbnail(image)
    }
  }

  private func runStatusAction() {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .notDetermined:
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
        DispatchQueue.main.async { self?.refresh() }
      }
    default:
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      view.window?.windowScene?.open(url, options: nil)
    }
  }

  private func manageLimited() {
    PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: self) { [weak self] _ in
      DispatchQueue.main.async { self?.refresh() }
    }
  }

  private func finish(_ picked: [ChatAttachment]) {
    handedOff = Set(picked.map(\.id))
    dismiss(animated: true) { [onPick] in onPick?(picked) }
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    1 + captured.count + (assets?.count ?? 0)
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    if indexPath.item == 0 {
      let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "camera", for: indexPath)
      cell.backgroundColor = .secondarySystemBackground
      cell.layer.cornerRadius = 6
      cell.clipsToBounds = true
      cell.isAccessibilityElement = true
      cell.accessibilityTraits = .button
      cell.accessibilityIdentifier = "attachment-camera"
      cell.accessibilityLabel = String(localized: "native.chat.composer.takePhoto", bundle: .lody)
      cameraCell = cell
      if !cameraExpanded { mountCameraTile() }
      return cell
    }
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "photo", for: indexPath) as! ChatPhotoCell
    cell.image.image = nil
    cell.accessibilityIdentifier = nil
    if indexPath.item <= captured.count {
      let photo = captured[indexPath.item - 1]
      cell.assetID = photo.id
      cell.image.image = ChatAttachment.thumbnail(photo.url)
      cell.accessibilityIdentifier = "captured-photo:" + photo.id
      cell.accessibilityLabel = photo.name
      cell.mark(selected: selection.contains(photo.id))
      return cell
    }
    guard let asset = assets?.object(at: indexPath.item - captured.count - 1) else { return cell }
    cell.assetID = asset.localIdentifier
    cell.mark(selected: selection.contains(asset.localIdentifier), video: asset.mediaType == .video)
    let indexKey = asset.mediaType == .video ? "native.chat.attachment.videoIndex" : "native.chat.attachment.photoIndex"
    cell.accessibilityLabel = String.localizedStringWithFormat(String(localized: String.LocalizationValue(indexKey), bundle: .lody), String(describing: indexPath.item + 1))
    let side = thumbnailSide(in: collectionView) * (view.window?.screen.scale ?? 2)
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.deliveryMode = .opportunistic
    images.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options) { image, _ in
      guard cell.assetID == asset.localIdentifier else { return }
      cell.image.image = image
    }
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout,
    referenceSizeForFooterInSection section: Int) -> CGSize {
    CGSize(width: collectionView.bounds.width, height: status.isHidden ? 0 : 160)
  }

  func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String,
    at indexPath: IndexPath) -> UICollectionReusableView {
    let container = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: "status", for: indexPath)
    if status.superview !== container {
      status.removeFromSuperview()
      status.translatesAutoresizingMaskIntoConstraints = false
      container.addSubview(status)
      NSLayoutConstraint.activate([
        status.centerXAnchor.constraint(equalTo: container.centerXAnchor),
        status.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        status.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 32),
        status.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -32),
        statusAction.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
      ])
    }
    return container
  }

  private func thumbnailSide(in collectionView: UICollectionView) -> CGFloat {
    max(1, ((collectionView.bounds.width - 38) / 3).rounded(.down))
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let side = thumbnailSide(in: collectionView)
    return CGSize(width: side, height: side)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    if indexPath.item == 0 { expandCamera(); return }
    let id: String
    var video = false
    if indexPath.item <= captured.count {
      id = captured[indexPath.item - 1].id
    } else {
      guard let asset = assets?.object(at: indexPath.item - captured.count - 1) else { return }
      id = asset.localIdentifier
      video = asset.mediaType == .video
    }
    if let index = selection.firstIndex(of: id) { selection.remove(at: index) }
    else if selection.count < 10 && (video || selectedImages < 8) { selection.append(id) }
    else { return }
    (collectionView.cellForItem(at: indexPath) as? ChatPhotoCell)?.mark(selected: selection.contains(id), video: video)
    UISelectionFeedbackGenerator().selectionChanged()
    updateConfirm()
  }

  private func updateConfirm() {
    let visible = !selection.isEmpty
    confirmFade.isHidden = !visible
    if visible {
      confirm.setTitle(
        String.localizedStringWithFormat(String(localized: "native.chat.attachment.addCount", bundle: .lody), selection.count),
        for: .normal
      )
    }
    confirm.isHidden = !visible
    view.setNeedsLayout()
  }

  private func commit() {
    guard !selection.isEmpty else { return }
    let local = Dictionary(uniqueKeysWithValues: captured.map { ($0.id, $0) })
    let libraryIDs = selection.filter { local[$0] == nil }
    var library: [String: PHAsset] = [:]
    // Even an empty Photos fetch can request library permission. Camera-only sends never read it.
    if !libraryIDs.isEmpty {
      let picked = PHAsset.fetchAssets(withLocalIdentifiers: libraryIDs, options: nil)
      picked.enumerateObjects { asset, _, _ in library[asset.localIdentifier] = asset }
    }
    isModalInPresentation = true
    confirm.isEnabled = false
    confirm.configuration?.showsActivityIndicator = true
    let group = DispatchGroup()
    let attachments = ChatAttachmentCollector()
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.version = .current
    for (index, id) in selection.enumerated() {
      if let photo = local[id] { attachments.add(index, photo); continue }
      guard let asset = library[id] else { continue }
      group.enter()
      if asset.mediaType == .video {
        let resources = PHAssetResource.assetResources(for: asset)
        let resource = resources.first { $0.type == .video || $0.type == .fullSizeVideo } ?? resources.first
        guard let resource else { group.leave(); continue }
        let name = resource.originalFilename
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
        let request = PHAssetResourceRequestOptions()
        request.isNetworkAccessAllowed = true
        PHAssetResourceManager.default().writeData(for: resource, toFile: destination, options: request) { error in
          defer { group.leave() }
          guard error == nil else { return }
          attachments.add(index, ChatAttachment(id: id, name: name, url: destination, isImage: false))
        }
        continue
      }
      let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "\(UUID().uuidString).jpg"
      self.images.requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
        defer { group.leave() }
        guard let data, let url = ChatAttachment.store(data, name: name) else { return }
        attachments.add(index, ChatAttachment(id: id, name: name, url: url, isImage: true))
      }
    }
    group.notify(queue: .main) { [weak self] in
      guard let self else {
        for photo in attachments.ordered { try? FileManager.default.removeItem(at: photo.url) }
        return
      }
      guard attachments.ordered.count == self.selection.count else {
        for photo in attachments.ordered where local[photo.id] == nil { try? FileManager.default.removeItem(at: photo.url) }
        self.isModalInPresentation = false
        self.confirm.isEnabled = true
        self.confirm.configuration?.showsActivityIndicator = false
        let alert = UIAlertController(title: String(localized: "native.chat.composer.attach", bundle: .lody),
          message: String(localized: "native.chat.attachment.loadFailed", bundle: .lody), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "native.close", bundle: .lody), style: .cancel))
        self.present(alert, animated: true)
        return
      }
      self.finish(attachments.ordered)
    }
  }
}

#endif
