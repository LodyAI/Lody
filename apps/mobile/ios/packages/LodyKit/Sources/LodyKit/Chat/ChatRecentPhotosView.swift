import AnchoredOverlayKit
import Photos
import UIKit

final class ChatPhotoGridLayout: UICollectionViewFlowLayout {
  override func invalidationContext(forBoundsChange newBounds: CGRect) -> UICollectionViewLayoutInvalidationContext {
    let context = super.invalidationContext(forBoundsChange: newBounds)
    if let grid = collectionView, grid.bounds.width != newBounds.width,
       let flowContext = context as? UICollectionViewFlowLayoutInvalidationContext {
      // Refresh sizes before the first layout at the new width. Reusing the old
      // sizes can briefly turn three columns into two and replace visible cells.
      flowContext.invalidateFlowLayoutDelegateMetrics = true
      flowContext.invalidateFlowLayoutAttributes = true
    }
    return context
  }
}

private enum PhotoGridPresentation: String, CaseIterable {
  case inset, edgeToEdge
  static let preferenceKey = "chat.photoGridPresentation"
  var inset: CGFloat { self == .inset ? 12 : 0 }
  var cornerRadius: CGFloat { self == .inset ? 6 : 2 }
  static var saved: Self {
    Self(rawValue: UserDefaults.standard.string(forKey: preferenceKey) ?? "") ?? .edgeToEdge
  }
  @MainActor var appearance: OverlayAppearance {
    // Equal top/side spacing gives the photo and panel corners a shared center.
    let top = self == .inset ? cornerRadius + inset : 40
    return OverlayAppearance(corners: .bottomConcentric(top: top))
  }
  var title: String { String(localized: String.LocalizationValue("native.chat.attachment.grid." + rawValue), bundle: .lody) }
}

/// Adjacent controls keep their individual 44pt hit areas even though their
/// visible glass is 40pt tall. The action bar reserves the surrounding hit space.
private final class ChatPhotoActions: UIView {
  init(toggle: UIButton, confirm: UIButton) {
    super.init(frame: .zero)
    for button in [toggle, confirm] {
      button.translatesAutoresizingMaskIntoConstraints = false
      addSubview(button)
      NSLayoutConstraint.activate([
        button.topAnchor.constraint(equalTo: topAnchor),
        button.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
    }
    NSLayoutConstraint.activate([
      toggle.leadingAnchor.constraint(equalTo: leadingAnchor),
      toggle.widthAnchor.constraint(equalToConstant: 40),
      confirm.leadingAnchor.constraint(equalTo: toggle.trailingAnchor, constant: 8),
      confirm.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    subviews.contains { $0.point(inside: convert(point, to: $0), with: event) }
  }
}

private final class ChatPhotoCell: UICollectionViewCell {
  let image = UIImageView()
  private let badge = UILabel()
  private let videoMark = UIImageView(image: UIImage(systemName: "video.fill"))
  var assetID: String?
  private var selectionOrder: Int?
  override init(frame: CGRect) {
    super.init(frame: frame)
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    image.backgroundColor = .tertiarySystemFill
    image.layer.cornerRadius = 6
    image.layer.cornerCurve = .continuous
    badge.font = .systemFont(ofSize: 13, weight: .semibold)
    badge.textAlignment = .center
    badge.clipsToBounds = true
    badge.textColor = .white
    badge.layer.cornerRadius = 10
    badge.layer.borderWidth = 1.5
    badge.layer.borderColor = UIColor.white.cgColor
    badge.accessibilityElementsHidden = true
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
      badge.widthAnchor.constraint(equalToConstant: 20),
      badge.heightAnchor.constraint(equalToConstant: 20),
      badge.trailingAnchor.constraint(equalTo: image.trailingAnchor, constant: -5),
      badge.bottomAnchor.constraint(equalTo: image.bottomAnchor, constant: -5),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .image
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func refreshAccent() {
    badge.backgroundColor = selectionOrder == nil ? .clear : UIColor.lodyAccent.resolvedColor(with: traitCollection)
    image.layer.borderColor = UIColor.lodyAccent.resolvedColor(with: traitCollection).cgColor
  }
  func mark(order: Int?, video: Bool = false) {
    selectionOrder = order
    let selected = order != nil
    badge.text = order.map(String.init)
    refreshAccent()
    badge.layer.borderWidth = selected ? 0 : 1.5
    badge.layer.shadowOpacity = selected ? 0 : 0.3
    image.layer.borderWidth = selected ? 2 : 0
    videoMark.isHidden = !video
    accessibilityValue = selected ? String(localized: "native.chat.attachment.selected", bundle: .lody) : nil
  }
}

final class ChatRecentPhotosView: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, OverlayContentSafeArea, OverlayPageChrome, OverlayBoundaryHighlighting {
  static var initialAppearance: OverlayAppearance { PhotoGridPresentation.saved.appearance }
  var onAppearanceChange: ((OverlayAppearance) -> Void)?
  var overlayChrome: UIView { actionBar }
  private lazy var actions = ChatPhotoActions(toggle: layoutToggle, confirm: confirm)
  private lazy var actionBar = OverlayActionBar(leading: back, trailing: actions)
  private let layoutToggle = OverlayActionButton()
  private var presentation = PhotoGridPresentation.saved
  private var gridEdges: [NSLayoutConstraint] = []
  var onPick: (([ChatAttachment]) -> Void)?
  var onBack: (() -> Void)?
  var onLibrary: (() -> Void)?
  var onManageLimited: (() -> Void)?
  var onRequestAccess: (() -> Void)?
  private let back = OverlayActionButton()
  private let grid: UICollectionView
  private let status = UIStackView()
  private let statusLabel = UILabel()
  private let statusAction = UIButton(configuration: .filled())
  private let confirm = OverlayActionButton()
  private let manage = UIButton(configuration: .plain())
  private var assets: PHFetchResult<PHAsset>?
  private var selection: [String] = []
  private let images = PHImageManager.default()

  init() {
    let layout = ChatPhotoGridLayout()
    layout.minimumLineSpacing = 3
    layout.minimumInteritemSpacing = 3
    grid = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(frame: .zero)
    back.appearance = ChatAttachmentMenu.mediaActionAppearance
    configure()
    NotificationCenter.default.addObserver(self, selector: #selector(refreshAccent), name: .lodyAppearanceDidChange, object: nil)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: ChatRecentPhotosView, _: UITraitCollection) in
      view.refreshAccent()
    }
    refreshAccent()
  }
  deinit { NotificationCenter.default.removeObserver(self) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func refreshAccent() {
    let accent = LodyAccentChoice.current.color.resolvedColor(with: traitCollection)
    layoutToggle.accentColor = accent
    confirm.accentColor = accent
    for case let cell as ChatPhotoCell in grid.visibleCells {
      // Preserve the existing media indicator while refreshing the selection color.
      cell.refreshAccent()
    }
  }

  private func configure() {
    grid.backgroundColor = .clear
    grid.dataSource = self
    grid.delegate = self
    grid.alwaysBounceVertical = true
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
    confirm.horizontalPadding = 20
    confirm.accessibilityIdentifier = "attachment-photos-confirm"
    confirm.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      if self.selection.isEmpty { self.onLibrary?() } else { self.commit() }
    }, for: .touchUpInside)
    back.setImage(UIImage(systemName: "chevron.left"), for: .normal)
    back.accessibilityLabel = String(localized: "native.chat.attachment.back", bundle: .lody)
    back.accessibilityIdentifier = "attachment-photos-back"
    back.addAction(UIAction { [weak self] _ in self?.onBack?() }, for: .touchUpInside)
    layoutToggle.accessibilityLabel = String(localized: "native.chat.attachment.grid.options", bundle: .lody)
    layoutToggle.accessibilityIdentifier = "attachment-photos-layout"
    layoutToggle.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.setPresentation(self.presentation == .inset ? .edgeToEdge : .inset)
    }, for: .touchUpInside)
    updatePresentationControl()
    grid.accessibilityIdentifier = "attachment-photos-grid"
    grid.contentInsetAdjustmentBehavior = .never
    statusAction.accessibilityIdentifier = "attachment-photos-access"
    grid.translatesAutoresizingMaskIntoConstraints = false
    addSubview(grid)
    for item in [status, manage] {
      item.translatesAutoresizingMaskIntoConstraints = false
      overlayChrome.addSubview(item)
    }
    gridEdges = [
      grid.topAnchor.constraint(equalTo: topAnchor, constant: presentation.inset),
      grid.leadingAnchor.constraint(equalTo: leadingAnchor, constant: presentation.inset),
      trailingAnchor.constraint(equalTo: grid.trailingAnchor, constant: presentation.inset),
      bottomAnchor.constraint(equalTo: grid.bottomAnchor, constant: presentation.inset),
    ]
    NSLayoutConstraint.activate(gridEdges)
    NSLayoutConstraint.activate([
      manage.bottomAnchor.constraint(equalTo: actionBar.controlsGuide.topAnchor, constant: -8),
      manage.centerXAnchor.constraint(equalTo: overlayChrome.centerXAnchor),
      manage.heightAnchor.constraint(equalToConstant: 44),
      status.centerXAnchor.constraint(equalTo: overlayChrome.centerXAnchor),
      status.centerYAnchor.constraint(equalTo: overlayChrome.centerYAnchor, constant: -30),
      status.leadingAnchor.constraint(greaterThanOrEqualTo: overlayChrome.leadingAnchor, constant: 24),
      status.trailingAnchor.constraint(lessThanOrEqualTo: overlayChrome.trailingAnchor, constant: -24),
    ])
    updateConfirm()
    refresh()
  }

  private func updatePresentationControl() {
    let inset = presentation == .inset
    layoutToggle.actionStyle = inset ? .emphasized : .neutral
    layoutToggle.appearance = inset ? .automatic : ChatAttachmentMenu.mediaActionAppearance
    layoutToggle.configuration?.image = UIImage(systemName: inset ? "arrow.down.forward.and.arrow.up.backward" : "arrow.down.backward.and.arrow.up.forward")
    layoutToggle.isSelected = inset
    layoutToggle.accessibilityValue = presentation.title
  }

  private func setPresentation(_ mode: PhotoGridPresentation) {
    guard presentation != mode else { return }
    grid.layoutIfNeeded()
    let oldMaximum = max(-grid.adjustedContentInset.top,
      grid.contentSize.height - grid.bounds.height + grid.adjustedContentInset.bottom)
    let wasAtBottom = oldMaximum > 0 && abs(grid.contentOffset.y - oldMaximum) < 1
    let first = grid.indexPathsForVisibleItems.sorted().first
    let frame = first.flatMap { grid.layoutAttributesForItem(at: $0)?.frame }
    let relativeOffset = frame.map { (grid.contentOffset.y - $0.minY) / max(1, $0.height) } ?? 0
    presentation = mode
    UserDefaults.standard.set(mode.rawValue, forKey: PhotoGridPresentation.preferenceKey)
    updatePresentationControl()
    for edge in gridEdges { edge.constant = mode.inset }
    onAppearanceChange?(mode.appearance)
    let updates = {
      self.layoutIfNeeded()
      self.grid.layoutIfNeeded()
      self.updateInsets()
      if let first, let frame = self.grid.layoutAttributesForItem(at: first)?.frame {
        let y = frame.minY + relativeOffset * frame.height
        let minimum = -self.grid.adjustedContentInset.top
        let maximum = max(minimum, self.grid.contentSize.height - self.grid.bounds.height + self.grid.adjustedContentInset.bottom)
        self.grid.contentOffset.y = wasAtBottom ? maximum : min(maximum, max(minimum, y))
      }
      for case let cell as ChatPhotoCell in self.grid.visibleCells {
        cell.image.layer.cornerRadius = mode.cornerRadius
      }
    }
    if UIAccessibility.isReduceMotionEnabled { updates() }
    else {
      UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 1,
        initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: updates)
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
      status.isHidden = (assets?.count ?? 0) > 0
      statusLabel.text = String(localized: "native.chat.attachment.noPhotos", bundle: .lody)
      statusAction.isHidden = true
    case .notDetermined:
      assets = nil
      status.isHidden = false
      statusAction.isHidden = false
      statusLabel.text = String(localized: "native.chat.attachment.limitedAccess", bundle: .lody)
      statusAction.setTitle(String(localized: "native.chat.attachment.allowAccess", bundle: .lody), for: .normal)
    default:
      assets = nil
      status.isHidden = false
      statusAction.isHidden = false
      statusLabel.text = String(localized: "native.chat.attachment.accessDenied", bundle: .lody)
      statusAction.setTitle(String(localized: "native.chat.attachment.openSettings", bundle: .lody), for: .normal)
    }
    grid.reloadData()
    updateInsets()
  }

  private func runStatusAction() { onRequestAccess?() }

  private func manageLimited() { onManageLimited?() }

  private func finish(_ picked: [ChatAttachment]) {
    confirm.isEnabled = true
    confirm.configuration?.showsActivityIndicator = false
    grid.isUserInteractionEnabled = true
    back.isEnabled = true
    layoutToggle.isEnabled = true
    guard !picked.isEmpty else { return }
    guard window != nil, let onPick else { ChatAttachment.discardImports(picked); return }
    onPick(picked)
  }

  func overlaySafeAreaInsetsDidChange(_ insets: UIEdgeInsets) {
    actionBar.safeAreaClearance = insets
    updateInsets()
  }

  private func updateInsets() {
    grid.contentInset.bottom = max(0, actionBar.contentBottomInset - presentation.inset) + (manage.isHidden ? 0 : 52)
    grid.verticalScrollIndicatorInsets.bottom = grid.contentInset.bottom
  }

  var overlayBoundaryHighlights: [OverlayBoundaryHighlight] {
    grid.visibleCells.compactMap { cell in
      guard let cell = cell as? ChatPhotoCell,
            let id = cell.assetID, selection.contains(id) else { return nil }
      return OverlayBoundaryHighlight(view: cell.image,
        shape: .roundedRect(radius: presentation.cornerRadius), clippedTo: grid,
        color: .lodyAccent, lineWidth: 2)
    }
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    assets?.count ?? 0
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "photo", for: indexPath) as! ChatPhotoCell
    guard let asset = assets?.object(at: indexPath.item) else { return cell }
    cell.image.image = nil
    cell.image.layer.cornerRadius = presentation.cornerRadius
    cell.accessibilityIdentifier = "attachment-photo-\(indexPath.item)"
    cell.assetID = asset.localIdentifier
    cell.mark(order: selection.firstIndex(of: asset.localIdentifier).map { $0 + 1 }, video: asset.mediaType == .video)
    let indexKey = asset.mediaType == .video ? "native.chat.attachment.videoIndex" : "native.chat.attachment.photoIndex"
    cell.accessibilityLabel = String.localizedStringWithFormat(String(localized: String.LocalizationValue(indexKey), bundle: .lody), String(describing: indexPath.item + 1))
    // Request the largest layout size so switching from inset never upscales a smaller thumbnail.
    let side = max(1, (bounds.width - 6) / 3) * (window?.screen.scale ?? 2)
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.deliveryMode = .opportunistic
    images.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options) { image, _ in
      guard cell.assetID == asset.localIdentifier else { return }
      cell.image.image = image
    }
    return cell
  }

  private func thumbnailSide(in collectionView: UICollectionView) -> CGFloat {
    max(1, ((collectionView.bounds.width - 6) / 3).rounded(.down))
  }

  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let side = thumbnailSide(in: collectionView)
    return CGSize(width: side, height: side)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard let asset = assets?.object(at: indexPath.item) else { return }
    if let index = selection.firstIndex(of: asset.localIdentifier) { selection.remove(at: index) }
    else if selection.count < 10 { selection.append(asset.localIdentifier) }
    else { return }
    for path in collectionView.indexPathsForVisibleItems {
      guard let item = assets?.object(at: path.item) else { continue }
      (collectionView.cellForItem(at: path) as? ChatPhotoCell)?.mark(
        order: selection.firstIndex(of: item.localIdentifier).map { $0 + 1 }, video: item.mediaType == .video)
    }
    UISelectionFeedbackGenerator().selectionChanged()
    updateConfirm()
  }

  private func updateConfirm() {
    let title = selection.isEmpty
      ? String(localized: "native.chat.composer.photoLibrary", bundle: .lody)
      : String.localizedStringWithFormat(String(localized: "native.chat.attachment.addCount", bundle: .lody), selection.count)
    confirm.actionStyle = selection.isEmpty ? .neutral : .emphasized
    confirm.appearance = selection.isEmpty ? ChatAttachmentMenu.mediaActionAppearance : .automatic
    confirm.horizontalPadding = 20
    confirm.configuration?.title = title
    confirm.accessibilityValue = String(selection.count)
  }

  private func commit() {
    let picked = PHAsset.fetchAssets(withLocalIdentifiers: selection, options: nil)
    guard picked.count > 0 else { return }
    confirm.isEnabled = false
    grid.isUserInteractionEnabled = false
    back.isEnabled = false
    layoutToggle.isEnabled = false
    confirm.configuration?.showsActivityIndicator = true
    let group = DispatchGroup()
    let attachments = ChatAttachmentCollector()
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.version = .current
    picked.enumerateObjects { asset, index, _ in
      group.enter()
      let id = asset.localIdentifier
      let selectionIndex = self.selection.firstIndex(of: id) ?? index
      if asset.mediaType == .video {
        let resources = PHAssetResource.assetResources(for: asset)
        let resource = resources.first { $0.type == .video || $0.type == .fullSizeVideo } ?? resources.first
        guard let resource else { group.leave(); return }
        let name = resource.originalFilename
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
        let request = PHAssetResourceRequestOptions()
        request.isNetworkAccessAllowed = true
        PHAssetResourceManager.default().writeData(for: resource, toFile: destination, options: request) { error in
          defer { group.leave() }
          guard error == nil else {
            try? FileManager.default.removeItem(at: destination)
            return
          }
          attachments.add(selectionIndex, ChatAttachment(id: id, name: name, url: destination, isImage: false))
        }
        return
      }
      let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "\(UUID().uuidString).jpg"
      self.images.requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
        defer { group.leave() }
        guard let data, let url = ChatAttachment.store(data, name: name) else { return }
        attachments.add(selectionIndex, ChatAttachment(id: id, name: name, url: url, isImage: true))
      }
    }
    group.notify(queue: .main) { [weak self] in
      let picked = attachments.ordered
      guard let self else { ChatAttachment.discardImports(picked); return }
      self.finish(picked)
    }
  }
}
