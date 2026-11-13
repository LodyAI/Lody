import ChatKit
import LodyCore
import AVFoundation
import UIKit
import UniformTypeIdentifiers

// Keep the standalone composer host offline; shortcut service behavior has its own suite.
@MainActor enum PromptShortcutsController {
  static func body(id: String) async throws -> RuntimeContract.PromptShortcut {
    throw NSError(domain: "ComposerOfflineFixture", code: 1)
  }
}

@MainActor func descendants(_ view: UIView) -> [UIView] {
  [view] + view.subviews.flatMap(descendants)
}

@MainActor func allWindows() -> [UIWindow] {
  var windows = UIApplication.shared.connectedScenes
    .compactMap { $0 as? UIWindowScene }
    .flatMap(\.windows)
  if let overlay = LodyToastOverlay.shared.hostedWindow, !windows.contains(where: { $0 === overlay }) {
    windows.append(overlay)
  }
  return windows
}

@MainActor func onMain<T>(_ body: @MainActor () -> T) -> T {
  body()
}

// An assistant may advertise no model choices; its configuration must still be reachable.
let agentOnlyComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 180))
agentOnlyComposer.cardStyle = true
var openedAgentConfig = false
agentOnlyComposer.onRunConfig = { openedAgentConfig = true }
agentOnlyComposer.setComposerState(#"{"editable":true,"canSend":false,"sending":false}"#)
agentOnlyComposer.setComposerOptions(#"{"agentName":"Kimi Code","models":[],"efforts":[]}"#)
let agentOnlyButton = descendants(agentOnlyComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-model" }!
precondition(!agentOnlyButton.isHidden, "An assistant without model capabilities must retain its configuration trigger")
precondition(agentOnlyButton.configuration?.attributedTitle?.description.contains("Kimi Code") == true, "The trigger must identify the assistant when no models are available")
agentOnlyButton.sendActions(for: .touchUpInside)
precondition(openedAgentConfig, "The assistant-only trigger must open run configuration")
agentOnlyComposer.setComposerOptions(#"{"models":[],"efforts":[]}"#)
precondition(agentOnlyButton.isHidden, "No assistant and no models must not show an empty trigger")
print("Composer: assistant-only configuration remains visible and opens")

// Width changes must keep three columns in the very first layout pass, so
// visible photos retain their cells and do not restart thumbnail requests.
@MainActor final class PhotoGridFixture: NSObject, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  var configurations = 0
  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { 60 }
  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    configurations += 1
    return collectionView.dequeueReusableCell(withReuseIdentifier: "photo", for: indexPath)
  }
  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    let side = floor((collectionView.bounds.width - 6) / 3)
    return CGSize(width: side, height: side)
  }
}
let photoLayout = ChatPhotoGridLayout()
photoLayout.minimumLineSpacing = 3
photoLayout.minimumInteritemSpacing = 3
let photoGrid = UICollectionView(frame: CGRect(x: 0, y: 0, width: 378, height: 450), collectionViewLayout: photoLayout)
let photoFixture = PhotoGridFixture()
photoGrid.dataSource = photoFixture
photoGrid.delegate = photoFixture
photoGrid.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "photo")
let photoWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
photoWindow.addSubview(photoGrid)
photoWindow.isHidden = false
photoGrid.layoutIfNeeded()
let fourthRow = [10, 11].map { IndexPath(item: $0, section: 0) }
let originalPhotoCells = fourthRow.map { photoGrid.cellForItem(at: $0)! }
let initialPhotoConfigurations = photoFixture.configurations
for width: CGFloat in [354, 378, 354, 378] {
  UIView.animate(withDuration: 0.28) {
    photoGrid.bounds.size.width = width
    photoGrid.layoutIfNeeded()
  }
  let side = floor((width - 6) / 3)
  for (index, path) in fourthRow.enumerated() {
    let frame = photoLayout.layoutAttributesForItem(at: path)!.frame
    precondition(frame.minY == 3 * (side + 3) && frame.width == side,
      "Photo resizing must use the new three-column metrics on its first pass")
    precondition(photoGrid.cellForItem(at: path) === originalPhotoCells[index],
      "Resizing must retain fourth-row photo cells instead of fading replacement cells")
  }
  precondition(photoFixture.configurations == initialPhotoConfigurations,
    "Resizing visible photos must not reconfigure cells or restart thumbnails")
  RunLoop.main.run(until: Date().addingTimeInterval(0.32))
}
photoWindow.isHidden = true
print("Photos: repeated width changes retain three columns and visible cell identities")

// Camera results use the same temporary-file/preview path as other attachments.
let capture = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 48)).image { context in
  UIColor.systemBlue.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 32, height: 48))
}
let capturedPhoto = ChatCameraCapture.store(capture.jpegData(compressionQuality: 0.9)!)!
precondition(capturedPhoto.isImage && capturedPhoto.url.isFileURL)
precondition(ChatAttachment.thumbnail(capturedPhoto.url) != nil, "Captured photo must persist as a previewable attachment")
try FileManager.default.removeItem(at: capturedPhoto.url)
precondition(ChatCameraCapture.store(Data("invalid image".utf8)) == nil, "Invalid capture must not become an attachment")
print("Camera: valid JPEG storage and invalid image rejection pass")

// The overlay camera fills its continuously resizing container.
let overlayCamera = ChatAttachmentOverlayCameraView(session: AVCaptureSession())
overlayCamera.setExpanded(true)
for size in [CGSize(width: 280, height: 300), CGSize(width: 390, height: 524)] {
  overlayCamera.frame = CGRect(origin: .zero, size: size)
  overlayCamera.setNeedsLayout()
  overlayCamera.layoutIfNeeded()
  precondition(overlayCamera.previewLayer.frame == overlayCamera.bounds,
    "Camera preview must fill the overlay viewport")
  let controls = descendants(overlayCamera).filter { $0.accessibilityIdentifier == "camera-shutter" }
  precondition(controls.count == 1, "Camera must retain one shutter while resizing")
}
print("Camera: overlay viewport resizing passes")

let handoffBar = ChatAttachmentBar()
handoffBar.frame = CGRect(x: 0, y: 0, width: 200, height: 34)
let handoffURL = FileManager.default.temporaryDirectory.appendingPathComponent("handoff-photo.png")
try! UIGraphicsImageRenderer(size: CGSize(width: 30, height: 40)).image { context in
  UIColor.systemBlue.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 30, height: 40))
}.pngData()!.write(to: handoffURL)
let handoffFiles = (0..<4).map { ChatAttachment(id: "file-\($0)", name: "notes-\($0).txt", url: URL(fileURLWithPath: "/tmp/notes-\($0).txt"), isImage: false) }
let handoffItem = ChatAttachment(id: "handoff", name: "photo.png", url: handoffURL, isImage: true)
handoffBar.render(handoffFiles + [handoffItem])
handoffBar.layoutIfNeeded()
let handoffTarget = handoffBar.handoffDestination(id: handoffItem.id)!
let handoffPill = handoffBar.attachmentFrame(id: handoffItem.id)!
let handoffTargetFrame = handoffTarget.convert(handoffTarget.bounds, to: handoffBar)
precondition(abs(handoffTargetFrame.width - handoffPill.width) < 0.5 && abs(handoffTargetFrame.height - handoffPill.height) < 0.5
  && abs(handoffTargetFrame.midX - handoffPill.midX) < 0.5,
  "The photo must land in its tile's full-bleed thumbnail; got \(handoffTargetFrame) in \(handoffPill)")
precondition(handoffBar.handoffDestination(id: handoffFiles[0].id) == nil, "File pills have no thumbnail to land in")
precondition(handoffBar.handoffDestination(id: "missing") == nil)
try? FileManager.default.removeItem(at: handoffURL)
print("Attachments: ChatKit thumbnail handoff target and reveal pass")

let composer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
let initialScroll = UIScrollView()
initialScroll.bottomEdgeEffect.isHidden = true
composer.attachScrollEdge(to: initialScroll)
let scrollInteraction = composer.interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }.first!
precondition(scrollInteraction.scrollView === initialScroll && scrollInteraction.edge == .bottom)
precondition(!initialScroll.bottomEdgeEffect.isHidden && initialScroll.bottomEdgeEffect.style == .soft,
  "Attaching a composer must enable soft occlusion")
let replacementScroll = UIScrollView()
composer.attachScrollEdge(to: replacementScroll)
precondition(scrollInteraction.scrollView === replacementScroll && replacementScroll.bottomEdgeEffect.style == .soft,
  "Moving the composer to another host must configure the new scroll view")
composer.attachScrollEdge(to: nil)
precondition(scrollInteraction.scrollView == nil,
  "Detaching the composer must release its scroll target")
print("Composer scroll edge: direct attachment, host replacement and detachment pass")
composer.setInputIdentifier("create-session-input")
var height: CGFloat = 0
composer.onHeightChange = { height = $0 }
let ready = #"{"editable":true,"canSend":true,"sending":false,"notice":"","reconnect":false,"placeholder":"任务"}"#

@MainActor func verifyCollapsedTypography(_ category: UIContentSizeCategory, expectedPointSize: CGFloat) {
  var scaledComposer: ChatComposerView!
  UITraitCollection(preferredContentSizeCategory: category).performAsCurrent {
    scaledComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
  }
  scaledComposer.setComposerState(ready)
  scaledComposer.layoutIfNeeded()
  let scaledInput = descendants(scaledComposer).compactMap { $0 as? UITextView }.first!
  let placeholder = descendants(scaledComposer).compactMap { $0 as? UILabel }.first { $0.text == "任务" }!
  precondition(abs(scaledInput.font!.pointSize - expectedPointSize) < 0.1, "Composer font must respect the app-supported scale limit")
  precondition(abs(scaledInput.bounds.height - 48) < 0.5, "An empty collapsed composer must remain one 48-point row")
  let inputLineMidY = scaledInput.textContainerInset.top + scaledInput.font!.lineHeight / 2
  precondition(abs(inputLineMidY - scaledInput.bounds.midY) < 0.5, "Collapsed input text must be vertically centered")
  precondition(abs(placeholder.frame.midY - scaledInput.frame.midY) < 0.5, "Collapsed placeholder must be vertically centered")
}

verifyCollapsedTypography(.extraSmall, expectedPointSize: 14)
verifyCollapsedTypography(.accessibilityExtraExtraExtraLarge, expectedPointSize: 23)
print("Composer typography: supported minimum and maximum sizes stay centered in one row")

composer.setComposerState(ready)
composer.layoutIfNeeded()
let input = descendants(composer).compactMap { $0 as? UITextView }.first!
let send = descendants(composer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
// A standalone simulator executable has no UIApplication event loop. Invoke the
// real button's registered target action directly.
@MainActor func tapSend() {
  for action in send.actions(forTarget: composer, forControlEvent: .touchUpInside) ?? [] {
    composer.perform(NSSelectorFromString(action))
  }
}
precondition(!send.isEnabled, "Empty draft must not send")
precondition(input.accessibilityIdentifier == "create-session-input")
composer.setInitialDraft("保留这个草稿 🐈")
var sent: [String] = []
composer.onSend = { sent.append($0["text"] as! String) }
tapSend()
tapSend()
precondition(sent == ["保留这个草稿 🐈"], "Double tap must send only once")
precondition(input.text.isEmpty && !send.isEnabled, "Pending draft must clear visibly and lock send")
composer.setComposerState(ready)
composer.restoreDraft(token: 1)
precondition(input.text == sent[0] && send.isEnabled, "Rejected creation must restore the exact draft")
tapSend()
composer.clearDraft(token: 1)
precondition(input.text.isEmpty && !send.isEnabled, "Accepted draft must stay cleared")
input.text = String(repeating: "多行输入\n", count: 50)
composer.textViewDidChange(input)
precondition(!input.isScrollEnabled && height == 64, "A resting long draft must stay one capsule; got \(height)")
composer.setComposerState(#"{"editable":false,"canSend":true,"sending":false,"notice":"结果待确认","reconnect":false,"placeholder":"任务"}"#)
precondition(!input.isEditable && !send.isEnabled, "Uncertain creation must prevent retry")
print("Composer: empty input, double send, restore, accept, multiline and uncertain state passed")

let actionComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
let actionWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
actionWindow.addSubview(actionComposer)
actionWindow.isHidden = false
actionComposer.setComposerState(ready)
actionComposer.layoutIfNeeded()
let actionInput = descendants(actionComposer).compactMap { $0 as? UITextView }.first!
actionInput.text = "Send this"
actionComposer.textViewDidChange(actionInput)
let actionButton = descendants(actionComposer).compactMap { $0 as? UIButton }.first {
  $0.accessibilityIdentifier == "session-send"
}!
let actionVisual = descendants(actionButton).first { $0.accessibilityIdentifier == "session-action-visual" }
precondition(
  actionVisual?.backgroundColor?.resolvedColor(with: actionComposer.traitCollection).isEqual(UIColor.lodyAccent.resolvedColor(with: actionComposer.traitCollection)) == true,
  "An actionable Send must render as an accent circular control"
)
let originalAccent = UserDefaults.standard.object(forKey: "accentColor")
for legacy in ["purple", "#FFFFAA", "#123ABC"] {
  UserDefaults.standard.set(legacy, forKey: "accentColor")
  for style in [UIUserInterfaceStyle.light, .dark] {
    for host in [composer, actionComposer] {
      host.overrideUserInterfaceStyle = style
      host.setComposerState(ready)
      let visual = descendants(host).first { $0.accessibilityIdentifier == "session-action-visual" }!
      let traits = host.traitCollection
      precondition(visual.backgroundColor?.resolvedColor(with: traits) == UIColor.lodyInk.resolvedColor(with: traits),
        "Legacy accent preferences cannot recolor Send in either host")
      let symbol = descendants(visual).compactMap { $0 as? UIImageView }.first!
      precondition(symbol.tintColor.resolvedColor(with: traits) == UIColor.lodyGround.resolvedColor(with: traits),
        "Send uses contrasting Ground in light and dark mode")
    }
  }
}
UserDefaults.standard.set(originalAccent, forKey: "accentColor")
print("Composer: fixed Ink ignores legacy preferences in both hosts and appearances")

actionInput.text = ""
actionComposer.textViewDidChange(actionInput)
actionComposer.setComposerState(
  #"{"editable":true,"canSend":true,"sending":false,"running":true,"canStop":true,"notice":"","reconnect":false,"placeholder":"任务"}"#
)
for style in [UIUserInterfaceStyle.light, .dark] {
  actionComposer.overrideUserInterfaceStyle = style
  let traits = actionComposer.traitCollection
  precondition(actionVisual?.backgroundColor?.resolvedColor(with: traits) == UIColor.lodyInk.resolvedColor(with: traits),
    "Stop must render as an Ink circular control in both appearances")
  let symbol = descendants(actionVisual!).compactMap { $0 as? UIImageView }.first!
  precondition(symbol.tintColor.resolvedColor(with: traits) == UIColor.lodyGround.resolvedColor(with: traits),
    "Stop uses the same contrasting Ground glyph as Send")
}
actionComposer.setComposerState(
  #"{"editable":true,"canSend":true,"sending":false,"running":true,"canStop":true,"stopping":true,"notice":"","reconnect":false,"placeholder":"任务"}"#
)
precondition(
  actionVisual?.isHidden == false
    && actionVisual?.backgroundColor?.isEqual(UIColor.systemGray) == true,
  "Loading must keep the circular control visible and turn it gray"
)
let actionProgress = descendants(actionButton).first {
  $0.accessibilityIdentifier == "session-action-progress"
}
precondition(
  actionProgress?.isHidden == false
    && actionProgress?.layer.animation(forKey: "composer.loading.rotation") != nil,
  "Loading must replace the action symbol with a rotating white arc"
)
precondition(
  !descendants(actionButton).compactMap { $0 as? UIActivityIndicatorView }.contains { $0.isAnimating },
  "Loading must not fall back to the detached activity indicator"
)
actionInput.text = "Next"
actionComposer.textViewDidChange(actionInput)
actionComposer.setComposerState(ready)
let actionContent = descendants(actionButton).first {
  $0.accessibilityIdentifier == "session-action-content"
}
precondition(
  actionContent?.layer.animationKeys()?.isEmpty == false,
  "Action-state replacement must animate the icon content"
)
print("Composer action: Send is blue, Stop is red and Loading is a gray circle with a rotating arc")

let attachmentComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 106))
attachmentComposer.setComposerState(ready)
attachmentComposer.setInitialAttachments(#"[{"id":"synthetic-file","name":"test.txt","uri":"file:///tmp/lody-composer-test.txt","kind":"file"}]"#)
let attachButton = descendants(attachmentComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-attach" }!
precondition(attachButton.isEnabled, "An attachment draft must still allow adding attachments")
let attachmentSend = descendants(attachmentComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
precondition(attachmentSend.isEnabled, "Attachment-only drafts must be sendable")
var sentAttachments: [[String: String]] = []
attachmentComposer.onSend = { sentAttachments = $0["attachments"] as! [[String: String]] }
@MainActor func sendAttachment() {
  for action in attachmentSend.actions(forTarget: attachmentComposer, forControlEvent: .touchUpInside) ?? [] {
    attachmentComposer.perform(NSSelectorFromString(action))
  }
}
sendAttachment()
precondition(sentAttachments.first?["id"] == "synthetic-file", "First turn must carry the picked file")
attachmentComposer.restoreDraft(token: 1)
precondition(attachmentSend.isEnabled, "Upload failure must restore attachment-only draft")
sentAttachments = []
sendAttachment()
precondition(sentAttachments.first?["uri"] == "file:///tmp/lody-composer-test.txt", "Retry must preserve the original attachment URI")
print("Composer: plus menu and attachment-only send/restore/retry passed")

let restingComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
let restingWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
restingWindow.addSubview(restingComposer)
restingWindow.isHidden = false
restingComposer.onHeightChange = { restingComposer.frame.size.height = $0 }
restingComposer.setComposerState(ready)
restingComposer.setInitialAttachments(#"[{"id":"resting-file","name":"notes.txt","uri":"file:///tmp/lody-composer-resting.txt","kind":"file"}]"#)
restingComposer.setInitialDraft("first line of the draft\nsecond line\nthird line")
restingComposer.layoutIfNeeded()
let restingInput = descendants(restingComposer).compactMap { $0 as? UITextView }.first!
let restingSurface = sequence(first: restingInput.superview, next: { $0?.superview }).lazy.compactMap { $0 as? UIVisualEffectView }.first!
precondition(abs(restingSurface.bounds.height - 48) < 0.5, "A resting multi-line draft must stay a 48-point capsule; got \(restingSurface.bounds.height)")
let restingStack = descendants(restingComposer).first { $0.accessibilityIdentifier == "session-attachment-stack" }
precondition(restingStack.map { !$0.isHidden && $0.isDescendant(of: restingSurface) } == true, "Resting attachments must stack inside the capsule")
let restingStackFrame = restingStack!.convert(restingStack!.bounds, to: restingInput)
precondition(restingInput.textContainerInset.left >= restingStackFrame.maxX + 4, "Resting draft text must start after the attachment stack")
let restingSend = descendants(restingComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
precondition(!restingSend.isHidden && restingSend.isEnabled, "A resting draft must offer Send")
precondition(restingInput.becomeFirstResponder())
RunLoop.current.run(until: Date().addingTimeInterval(0.35))
restingComposer.layoutIfNeeded()
precondition(restingStack!.isHidden && restingInput.bounds.height >= 132, "Opening the sheet must replace the stack with the full draft")
let restingBar = descendants(restingComposer).compactMap { $0 as? ChatAttachmentBar }.first!
precondition(restingBar.isDescendant(of: restingSurface) && !restingBar.isHidden, "The open sheet must host the attachment row")
precondition(restingBar.convert(restingBar.bounds, to: restingSurface).maxY <= restingInput.convert(restingInput.bounds, to: restingSurface).minY + 0.5,
  "The attachment row must sit above the text")
let restingTile = restingBar.attachmentFrame(id: "resting-file")!
precondition(abs(restingTile.height - 80) < 0.5, "Sheet attachments must be 80-point tiles; got \(restingTile)")
let restingTextEdge = restingInput.convert(CGPoint(x: restingInput.textContainerInset.left + restingInput.textContainer.lineFragmentPadding, y: 0), to: restingBar).x
precondition(abs(restingTile.minX - restingTextEdge) < 0.5, "Attachment and visible text must share their leading edge")
let restingRemove = descendants(restingBar).compactMap { $0 as? UIButton }.first {
  $0.accessibilityLabel == String.localizedStringWithFormat(String(localized: "native.chat.attachment.remove", bundle: .lody), String(describing: "notes.txt"))
}!
let restingRemoveFrame = restingRemove.convert(restingRemove.bounds, to: restingBar)
precondition(restingTile.contains(restingRemoveFrame) && restingRemoveFrame.midX > restingTile.midX && restingRemoveFrame.midY < restingTile.midY,
  "The remove badge must sit inside the tile's top-right corner; got \(restingRemoveFrame) in \(restingTile)")
restingInput.text = String(repeating: "多行输入\n", count: 50)
restingComposer.textViewDidChange(restingInput)
restingComposer.layoutIfNeeded()
precondition(restingInput.isScrollEnabled && abs(restingInput.bounds.height - 140) < 0.5, "A focused long draft must stop growing at the inline cap and scroll; got \(restingInput.isScrollEnabled) \(restingInput.bounds.height) responder \(restingInput.isFirstResponder)")
restingInput.resignFirstResponder()
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
print("Composer: resting draft keeps one capsule with stacked attachments and Send")

let pasteComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
pasteComposer.setComposerState(ready)
let pasteInput = descendants(pasteComposer).compactMap { $0 as? UITextView }.first!
let pasteSend = descendants(pasteComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
let source = FileManager.default.temporaryDirectory.appendingPathComponent("lody-paste-source.txt")
try! Data("clipboard file".utf8).write(to: source)
let fileProvider = NSItemProvider(contentsOf: source)!
precondition(pasteInput.canPaste([fileProvider]), "A copied file must enable the system Paste action")
UIPasteboard.general.setObjects([source as NSURL])
precondition(pasteInput.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil), "A copied file must expose Paste in the edit menu")
pasteInput.paste(itemProviders: [fileProvider])
let deadline = Date().addingTimeInterval(3)
while !pasteSend.isEnabled && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
precondition(pasteSend.isEnabled, "Pasting a file must add a sendable attachment")
var pastedAttachments: [[String: String]] = []
pasteComposer.onSend = { pastedAttachments = $0["attachments"] as! [[String: String]] }
for action in pasteSend.actions(forTarget: pasteComposer, forControlEvent: .touchUpInside) ?? [] {
  pasteComposer.perform(NSSelectorFromString(action))
}
precondition(pastedAttachments.first?["name"] == source.lastPathComponent, "A pasted file must retain its name")
let pastedURL = URL(string: pastedAttachments.first!["uri"]!)!
precondition(pastedURL != source && (try? Data(contentsOf: pastedURL)) == Data("clipboard file".utf8), "A pasted file must be copied before the provider expires")
let textProvider = NSItemProvider(object: "normal text paste" as NSString)
pasteComposer.restoreDraft(token: 1)
pasteInput.text = ""
pasteInput.paste(itemProviders: [textProvider])
let textDeadline = Date().addingTimeInterval(3)
while pasteInput.text.isEmpty && Date() < textDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
precondition(pasteInput.text == "normal text paste", "Ordinary text paste must keep UIKit behavior")
UIPasteboard.general.items = []
print("Composer paste: file attachment and ordinary text fallback passed")

let webArchiveType = UTType("com.apple.webarchive")!
let selection = NSItemProvider()
selection.registerDataRepresentation(forTypeIdentifier: webArchiveType.identifier, visibility: .all) { completion in
  completion(Data("webarchive-bytes".utf8), nil)
  return nil
}
selection.registerObject("lodyUserBubble" as NSString, visibility: .all)
precondition(ChatAttachment.transferType(for: selection) == nil,
  "A copied web selection must not become a file attachment")
precondition(!ChatAttachment.canPaste([selection]),
  "A copied web selection must not claim Paste as an attachment")
pasteComposer.restoreDraft(token: 1)
pasteInput.text = ""
pasteInput.paste(itemProviders: [selection])
let webDeadline = Date().addingTimeInterval(3)
while pasteInput.text != "lodyUserBubble" && Date() < webDeadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
precondition(pasteInput.text == "lodyUserBubble", "Copied in-app text must paste as text, not a webarchive file")

let archiveFile = FileManager.default.temporaryDirectory.appendingPathComponent("selection.webarchive")
try! Data("webarchive-bytes".utf8).write(to: archiveFile)
let archiveFileProvider = NSItemProvider(contentsOf: archiveFile)!
archiveFileProvider.suggestedName = archiveFile.lastPathComponent
let archiveText = NSItemProvider(object: "lodyUserBubble" as NSString)
precondition(ChatAttachment.transferType(for: archiveFileProvider) == nil,
  "A webarchive file URL must not become an attachment")
precondition(!ChatAttachment.canPaste([archiveFileProvider, archiveText]),
  "A split webarchive + text paste must not claim the paste as an attachment")
pasteComposer.restoreDraft(token: 1)
pasteInput.text = ""
pasteInput.paste(itemProviders: [archiveFileProvider, archiveText])
let splitDeadline = Date().addingTimeInterval(3)
while pasteInput.text != "lodyUserBubble" && Date() < splitDeadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
precondition(pasteInput.text == "lodyUserBubble", "A split webarchive pasteboard must insert the copied text, got \(pasteInput.text!.debugDescription)")
print("Composer paste: webarchive selections stay text")

pasteComposer.restoreDraft(token: 1)
pasteInput.text = "round trip"
pasteInput.selectedRange = NSRange(location: 0, length: 10)
pasteInput.copy(nil)
precondition(!ChatAttachment.canPaste(UIPasteboard.general.itemProviders),
  "Text copied from the composer must not claim Paste as an attachment")
UIPasteboard.general.items = []
print("Composer paste: in-composer copy is not an attachment")

precondition(!ChatAttachment.shouldPromotePastedText("hello"))
precondition(!ChatAttachment.shouldPromotePastedText(String(repeating: "x", count: 1999)))
precondition(ChatAttachment.shouldPromotePastedText(String(repeating: "x", count: 2000)))
precondition(!ChatAttachment.shouldPromotePastedText((1...15).map { "line \($0)" }.joined(separator: "\n")))
precondition(ChatAttachment.shouldPromotePastedText((1...16).map { "line \($0)" }.joined(separator: "\n")))
let promoted = ChatAttachment.makePastedTextFile("long body")
precondition(promoted?.name == "Text.txt" && promoted?.isImage == false)
precondition((try? String(contentsOf: promoted!.url, encoding: .utf8)) == "long body")
print("Composer paste: long text promotion threshold passed")

let longBody = (1...16).map { "line \($0)" }.joined(separator: "\n")
let longProvider = NSItemProvider(object: longBody as NSString)
let longComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
longComposer.setComposerState(ready)
let longInput = descendants(longComposer).compactMap { $0 as? UITextView }.first!
let longSend = descendants(longComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
longInput.paste(itemProviders: [longProvider])
let longDeadline = Date().addingTimeInterval(3)
while !longSend.isEnabled && Date() < longDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
precondition(longInput.text.isEmpty, "Long pasted text must not fill the composer")
precondition(longSend.isEnabled, "Long pasted text becomes a sendable text file")
LodyToastOverlay.shared.dismiss()
RunLoop.current.run(until: Date().addingTimeInterval(0.3))

let plainComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
plainComposer.setComposerState(ready)
let plainInput = descendants(plainComposer).compactMap { $0 as? UITextView }.first!
let plainAction = NSSelectorFromString("pastePlainText:")
let mixedPlainProvider = NSItemProvider(object: longBody as NSString)
for type in [UTType.rtf, UTType.flatRTFD, UTType.png] {
  mixedPlainProvider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
    completion(Data([0, 1, 2]), nil)
    return nil
  }
}
UIPasteboard.general.setItemProviders([mixedPlainProvider], localOnly: true, expirationDate: nil)
precondition(plainInput.canPerformAction(plainAction, withSender: nil))
let plainMenu = plainComposer.textView(plainInput, editMenuForTextIn: NSRange(location: 0, length: 0), suggestedActions: [])!
precondition(plainMenu.children.first?.title == String(localized: "native.chat.composer.pastePlainText", bundle: .lody))
plainInput.text = "before replace after"
plainInput.selectedRange = NSRange(location: 7, length: 7)
(plainInput as! ChatComposerInput).pastePlainText(from: [mixedPlainProvider])
let expectedPlain = "before " + longBody + " after"
let plainDeadline = Date().addingTimeInterval(3)
while plainInput.text != expectedPlain && Date() < plainDeadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
precondition(plainInput.text == expectedPlain, "Plain paste must replace selection and keep long text inline: \(plainInput.text ?? "nil")")
var plainPayload: [String: Any] = [:]
plainComposer.onSend = { plainPayload = $0 }
plainComposer.perform(NSSelectorFromString("submit"))
precondition(plainPayload["text"] as? String == expectedPlain)
precondition((plainPayload["attachments"] as? [[String: String]])?.isEmpty == true,
  "Plain paste must ignore rich/image representations and bypass text-file promotion")
plainInput.isEditable = false
precondition(!plainInput.canPerformAction(plainAction, withSender: nil))
plainInput.isEditable = true
UIPasteboard.general.items = [[UTType.png.identifier: Data([0, 1, 2])]]
precondition(!plainInput.canPerformAction(plainAction, withSender: nil))
precondition(plainComposer.textView(plainInput, editMenuForTextIn: .init(location: 0, length: 0), suggestedActions: [])!.children.isEmpty)
print("Composer paste: explicit plain text ignores attachments and preserves selected-range insertion")

let undoComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
undoComposer.setComposerState(ready)
let undoWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
undoWindow.addSubview(undoComposer)
undoWindow.isHidden = false
let undoInput = descendants(undoComposer).compactMap { $0 as? UITextView }.first!
undoInput.text = "keep me"
undoInput.selectedRange = NSRange(location: (undoInput.text as NSString).length, length: 0)
undoInput.paste(itemProviders: [longProvider])
let undoDeadline = Date().addingTimeInterval(3)
var undo: UIButton?
while Date() < undoDeadline {
  undo = allWindows().flatMap(descendants).compactMap { $0 as? UIButton }
    .first { $0.accessibilityIdentifier == "lody.toast.undo" }
  if undo != nil { break }
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
precondition(undoInput.text == "keep me", "Long pasted text must leave the existing draft in place")
precondition(undo != nil, "Long paste must offer an undo toast action")
LodyToastOverlay.shared.performFrontAction()
let restoredDeadline = Date().addingTimeInterval(1)
while !undoInput.text.contains(longBody) && Date() < restoredDeadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
}
precondition(undoInput.text.contains("keep me") && undoInput.text.contains(longBody),
  "Undo must insert the pasted text back into the composer")
precondition(undoInput.text.count == "keep me".count + longBody.count)
print("Composer paste: long text becomes a file with undo")

let movie = FileManager.default.temporaryDirectory.appendingPathComponent("IMG_3933.mov")
try! Data("video-bytes".utf8).write(to: movie)
let poster = FileManager.default.temporaryDirectory.appendingPathComponent("IMG_3933.png")
try! UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { context in
  UIColor.red.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
}.write(to: poster)
let videoProvider = NSItemProvider()
videoProvider.suggestedName = "IMG_3933"
videoProvider.registerFileRepresentation(forTypeIdentifier: UTType.png.identifier, fileOptions: [], visibility: .all) { completion in
  completion(poster, false, nil)
  return nil
}
videoProvider.registerFileRepresentation(forTypeIdentifier: UTType.mpeg4Movie.identifier, fileOptions: [], visibility: .all) { completion in
  completion(movie, false, nil)
  return nil
}
let videoComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
videoComposer.setComposerState(ready)
let videoInput = descendants(videoComposer).compactMap { $0 as? UITextView }.first!
let videoSend = descendants(videoComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
precondition(videoInput.canPaste([videoProvider]), "A copied video must enable Paste")
videoInput.paste(itemProviders: [videoProvider])
let videoDeadline = Date().addingTimeInterval(3)
while !videoSend.isEnabled && Date() < videoDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
precondition(videoSend.isEnabled, "Pasting a video must add a sendable attachment")
var videoAttachments: [[String: String]] = []
videoComposer.onSend = { videoAttachments = $0["attachments"] as! [[String: String]] }
for action in videoSend.actions(forTarget: videoComposer, forControlEvent: .touchUpInside) ?? [] {
  videoComposer.perform(NSSelectorFromString(action))
}
precondition(videoAttachments.first?["kind"] == "file", "A video must stay a file attachment, not an extracted poster image")
precondition(videoAttachments.first?["name"]?.hasSuffix(".mov") == true || videoAttachments.first?["name"]?.hasSuffix(".mp4") == true, "A pasted video must keep a video filename")
let videoURL = URL(string: videoAttachments.first!["uri"]!)!
precondition((try? Data(contentsOf: videoURL)) == Data("video-bytes".utf8), "A pasted video must keep the movie bytes, not a PNG poster")
print("Composer paste: video with an image poster stays a file")

let draftComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
draftComposer.setComposerState(ready)
let draftInput = descendants(draftComposer).compactMap { $0 as? UITextView }.first!
var savedDrafts: [String] = []
draftComposer.onDraftChange = { savedDrafts.append($0) }
draftComposer.setStoredDraft("上次没发出去的话")
precondition(draftInput.text == "上次没发出去的话", "Empty input must restore the stored draft")
draftComposer.setStoredDraft("其他会话的草稿")
precondition(draftInput.text == "上次没发出去的话", "A stored draft must never overwrite typed text")
draftComposer.textViewDidEndEditing(draftInput)
precondition(savedDrafts.count == 1 && savedDrafts[0].contains("\"lexical\""), "Ending editing must persist the draft as an editor state envelope")
draftComposer.setComposerState(#"{"editable":true,"canSend":true,"sending":true,"notice":"","reconnect":false,"placeholder":"任务"}"#)
draftComposer.clearDraft(token: 1)
precondition(savedDrafts.last == "" && draftInput.text.isEmpty, "Sending must clear the stored draft")
print("Composer: stored draft restore, no-overwrite, save on end editing and clear on send passed")

let handoffComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
handoffComposer.setComposerState(ready)
let handoffInput = descendants(handoffComposer).compactMap { $0 as? UITextView }.first!
let handoffSend = descendants(handoffComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
let transferred = try! JSONDecoder().decode(ChatPendingSend.self, from: Data(#"{"id":"handoff","text":"移交的草稿","attachments":[],"status":"正在发送…"}"#.utf8))
handoffComposer.setPendingSend(transferred)
precondition(handoffInput.text.isEmpty && !handoffSend.isEnabled, "A transferred send locks the destination composer without exposing the draft")
var rejected = transferred
rejected.failed = true
handoffComposer.setPendingSend(rejected)
precondition(handoffInput.text.isEmpty, "Failed sends stay in the transcript rather than jumping back into the composer")
handoffInput.text = "用户继续修改"
handoffComposer.setPendingSend(rejected)
precondition(handoffInput.text == "用户继续修改", "Repeated failed props must not replace user edits")
var generatedID = ""
var generatedStartedAt: Double = 0
let beforeNativeSend = Date().timeIntervalSince1970 * 1000
handoffComposer.onSend = {
  generatedID = $0["id"] as! String
  generatedStartedAt = $0["startedAt"] as? Double ?? 0
}
handoffComposer.textViewDidChange(handoffInput)
for action in handoffSend.actions(forTarget: handoffComposer, forControlEvent: .touchUpInside) ?? [] {
  handoffComposer.perform(NSSelectorFromString(action))
}
let afterNativeSend = Date().timeIntervalSince1970 * 1000
precondition(UUID(uuidString: generatedID) != nil, "The native click must generate a dispatch identity before emitting send")
precondition((beforeNativeSend...afterNativeSend).contains(generatedStartedAt),
  "The native send event must carry the timer's durable submission clock")
print("Composer handoff: destination ownership, failed retention, no-overwrite and send identity passed")

let panelComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
actionWindow.addSubview(panelComposer)
panelComposer.sendHandoff = false
panelComposer.setComposerState(ready)
let panelInput = descendants(panelComposer).compactMap { $0 as? UITextView }.first!
let panelSend = descendants(panelComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
panelInput.text = "Keep this draft visible"
panelComposer.textViewDidChange(panelInput)
var panelPayload: [String: Any] = [:]
panelComposer.onSend = { panelPayload = $0 }
for action in panelSend.actions(forTarget: panelComposer, forControlEvent: .touchUpInside) ?? [] {
  panelComposer.perform(NSSelectorFromString(action))
}
precondition(panelPayload["text"] as? String == "Keep this draft visible")
precondition(!ChatSendHandoff.isWaiting(id: panelPayload["id"] as! String),
  "Cross-container creation must not leave a flying copy in the window")
precondition(panelInput.text == "Keep this draft visible" && !panelInput.isEditable && !panelSend.isEnabled,
  "Cross-container sends retain and lock the source draft until dismissal")
panelComposer.restoreDraft(token: 1)
precondition(panelInput.text == "Keep this draft visible" && panelInput.isEditable && panelSend.isEnabled,
  "Rejected creation unlocks the same draft without duplicating it")
panelComposer.removeFromSuperview()

handoffComposer.clearDraft(token: 1)
handoffInput.text = "下一条草稿"
handoffComposer.clearDraft(token: 2)
precondition(handoffInput.text == "下一条草稿", "A delayed acknowledgement cannot erase a new draft")

let acknowledged = try! JSONDecoder().decode(ChatPendingSend.self, from: Data(#"{"id":"acknowledged","text":"已送达","attachments":[],"status":"等待回复…"}"#.utf8))
handoffComposer.setPendingSend(acknowledged)
handoffComposer.clearDraft(token: 3)
handoffComposer.setPendingSend(acknowledged)
handoffInput.text = "下一条"
handoffComposer.textViewDidChange(handoffInput)
precondition(handoffSend.isEnabled, "A status update for an acknowledged ID must never reacquire the draft lock")

let retiredComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
retiredComposer.setComposerState(ready)
let retiredInput = descendants(retiredComposer).compactMap { $0 as? UITextView }.first!
let retiredSend = descendants(retiredComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
retiredComposer.setPendingSend(transferred)
retiredComposer.clearPendingSend(id: "another-send")
precondition(!retiredSend.isEnabled, "A different send must not release the pending composer")
retiredComposer.clearPendingSend(id: transferred.id)
retiredInput.text = "已完成后继续发送"
retiredComposer.textViewDidChange(retiredInput)
precondition(retiredSend.isEnabled, "Retiring the published send must release the composer without a token transition")

let typingComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
typingComposer.setComposerState(ready)
let typingInput = descendants(typingComposer).compactMap { $0 as? UITextView }.first!
let typingSend = descendants(typingComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
typingComposer.setPendingSend(transferred)
precondition(typingInput.isEditable && !typingSend.isEnabled, "Pending sends must keep input editable while preventing duplicate submission")
typingInput.text = "下一条新草稿"
typingComposer.textViewDidChange(typingInput)
typingComposer.setPendingSend(rejected)
precondition(typingInput.text == "下一条新草稿", "Failure must preserve the next draft while the transcript owns retry")
precondition(typingSend.isEnabled, "A definite failure must release the pending composer lock for the next draft")
print("Composer continuity: editable pending input and no failed-draft jump passed")
for action in typingSend.actions(forTarget: typingComposer, forControlEvent: .touchUpInside) ?? [] {
  typingComposer.perform(NSSelectorFromString(action))
}
typingInput.text = "第三条草稿"
typingComposer.textViewDidChange(typingInput)
typingComposer.clearDraft(token: 1)
precondition(typingInput.text == "第三条草稿" && typingSend.isEnabled, "Acknowledgement must release the sent draft while retaining text typed during delivery")

for storedFirst in [true, false] {
  let restoredComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
  restoredComposer.setComposerState(ready)
  let restoredInput = descendants(restoredComposer).compactMap { $0 as? UITextView }.first!
  if storedFirst { restoredComposer.setStoredDraft("重开后继续写的下一条") }
  restoredComposer.setPendingSend(transferred)
  if !storedFirst { restoredComposer.setStoredDraft("重开后继续写的下一条") }
  precondition(restoredInput.text == "重开后继续写的下一条", "Pending and next-draft hydration must preserve text in either order")
}
var persistedTyping: [String] = []
typingComposer.onDraftChange = { persistedTyping.append($0) }
for action in typingSend.actions(forTarget: typingComposer, forControlEvent: .touchUpInside) ?? [] {
  typingComposer.perform(NSSelectorFromString(action))
}
precondition(persistedTyping.last == "", "Sending must immediately clear the current draft store while the outbox retains the sent content")
typingComposer.textViewDidEndEditing(typingInput)
precondition(persistedTyping.last == "", "An empty current input must never persist the pending message as a new draft")
print("Composer persistence: either hydration order and current-only draft writes passed")

// A cancelled throw must reveal its destination and never adopt stale content.
// This executable has no render server; UI checks exercise real snapshot pixels.
final class HandoffWindow: UIWindow {
  override func resizableSnapshotView(from rect: CGRect, afterScreenUpdates afterUpdates: Bool, withCapInsets capInsets: UIEdgeInsets) -> UIView? { UIView(frame: rect) }
}
let throwWindow = HandoffWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let throwInput = UITextView(frame: CGRect(x: 16, y: 700, width: 350, height: 60))
throwInput.text = "Preserve this message"
throwWindow.addSubview(throwInput)
let throwTarget = ChatMessageContent(frame: CGRect(x: 200, y: 100, width: 170, height: 45))
throwTarget.label.setText(NSAttributedString(string: throwInput.text))
throwWindow.addSubview(throwTarget)
onMain { ChatSendHandoff.begin(id: "cancel-throw", source: throwInput) }
onMain { ChatSendHandoff.hold(id: "cancel-throw", target: throwTarget) }
precondition(throwTarget.isHidden, "The destination must not duplicate the flying message")
onMain { ChatSendHandoff.deliver(id: "cancel-throw", to: throwTarget) }
let flyingText = throwWindow.subviews.compactMap { $0 as? ChatMessageContent }.first { $0 !== throwTarget }
precondition(flyingText != nil && flyingText!.label.bounds.width > 0 && flyingText!.label.bounds.height > 0,
  "The hidden background layer must not skip the flying text layout")
onMain {
  ChatSendHandoff.begin(id: "cancel-throw:attachment:offscreen", source: throwInput)
  ChatSendHandoff.cancelWaitingAttachments(id: "cancel-throw")
}
precondition(!ChatSendHandoff.hasWaitingAttachments(id: "cancel-throw") && throwTarget.isHidden,
  "Offscreen attachment cleanup must remove waiting copies without interrupting a visible flight")
onMain { ChatSendHandoff.cancel(id: "cancel-throw") }
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
precondition(!throwTarget.isHidden, "Cancellation must reveal the destination")
precondition(throwWindow.subviews.count == 2, "Cancellation must remove every flight overlay")
print("Send throw: cancellation reveals target, removes overlays without replacing destination content")

var settledTurns: [String] = []
ChatSendHandoff.onSettled = { settledTurns.append($0) }
onMain { ChatSendHandoff.begin(id: "status-throw", source: throwInput) }
precondition(onMain { ChatSendHandoff.isInFlight(id: "status-throw") }, "A waiting copy is in flight")
precondition(settledTurns.isEmpty, "Flight start must not reveal status")
onMain {
  ChatSendHandoff.hold(id: "status-throw", target: throwTarget)
  ChatSendHandoff.deliver(id: "status-throw", to: throwTarget)
}
precondition(onMain { ChatSendHandoff.isInFlight(id: "status-throw") }, "Delivery must hide status until the throw lands")
precondition(settledTurns.isEmpty, "A moving copy must not reveal status")
onMain { ChatSendHandoff.cancel(id: "status-throw") }
precondition(onMain { !ChatSendHandoff.isInFlight(id: "status-throw") })
precondition(settledTurns == ["status-throw"], "Settling must reveal status once")
settledTurns.removeAll()
onMain {
  ChatSendHandoff.begin(id: "status-throw", source: throwInput)
  ChatSendHandoff.begin(id: "status-throw:attachment:a", source: throwInput)
}
precondition(onMain { ChatSendHandoff.isInFlight(id: "status-throw") })
onMain { ChatSendHandoff.cancel(id: "status-throw", includingAttachments: false) }
precondition(onMain { ChatSendHandoff.isInFlight(id: "status-throw") }, "Attachment copies keep the turn in flight")
precondition(settledTurns.isEmpty, "Status waits until every copy lands")
onMain { ChatSendHandoff.cancel(id: "status-throw:attachment:a") }
precondition(onMain { !ChatSendHandoff.isInFlight(id: "status-throw") })
precondition(settledTurns == ["status-throw"], "The last copy settling reveals status")
ChatSendHandoff.onSettled = nil
final class StatusHost: UIView, ChatSendHandoffSettling {
  var settled: [String] = []
  func handoffDidSettle(_ id: String) { settled.append(id) }
}
let statusHost = StatusHost(frame: throwWindow.bounds)
throwWindow.addSubview(statusHost)
let hostedInput = UITextView(frame: CGRect(x: 16, y: 700, width: 350, height: 60))
statusHost.addSubview(hostedInput)
onMain { ChatSendHandoff.begin(id: "owner-throw", source: hostedInput) }
onMain { ChatSendHandoff.cancel(id: "owner-throw") }
precondition(statusHost.settled == ["owner-throw"], "The transcript host must insert status after its own throw settles")
print("Send throw: status waits until every copy settles")

let relayComposer = ChatComposerView(frame: composer.frame)
relayComposer.setComposerState(ready)
relayComposer.setInitialDraft("Keep until adopted")
let relayInput = descendants(relayComposer).compactMap { $0 as? UITextView }.first!
var relayPayload: [String: Any]?
var relayDispatches = 0
relayComposer.prepareSend = { payload in
  relayPayload = payload
  relayComposer.relaying = true
  relayDispatches += 1
  return true
}
relayComposer.perform(NSSelectorFromString("submit"))
relayComposer.perform(NSSelectorFromString("submit"))
relayComposer.setComposerState(#"{"editable":true,"canSend":false,"sending":true}"#)
precondition(relayInput.text == "Keep until adopted" && relayDispatches == 1,
  "Preparing a destination must preserve the draft and dispatch only once")
relayComposer.onSend = { _ in preconditionFailure("Adoption cannot dispatch the creation twice") }
relayComposer.commitSend(relayPayload!)
precondition(relayInput.text.isEmpty, "Only adoption consumes the source draft")
relayComposer.restoreDraft(token: 1)
precondition(relayInput.text == "Keep until adopted", "An adopted send must remain restorable")
print("Composer relay: prepare preserves draft, adoption consumes once, failure restores")

// Pushed creation keeps focus until navigation removes the form.
throwWindow.isHidden = false
for dismisses in [false, true] {
  let creationComposer = ChatComposerView(frame: CGRect(x: 0, y: 500, width: 390, height: 180))
  creationComposer.cardStyle = true
  creationComposer.dismissesKeyboardOnSend = dismisses
  throwWindow.addSubview(creationComposer)
  creationComposer.setComposerState(ready)
  creationComposer.setInitialDraft("Creation keyboard handoff")
  let creationInput = descendants(creationComposer).compactMap { $0 as? UITextView }.first!
  precondition(creationInput.becomeFirstResponder())
  creationComposer.commitSend(["id": "creation-focus-\(dismisses)", "queue": false])
  precondition(creationInput.isFirstResponder == !dismisses,
    "Only the pushed creation host retains focus through its send")
  precondition(creationInput.text.isEmpty, "Retaining focus must still consume the draft")
  creationComposer.restoreDraft(token: 1)
  precondition(creationInput.text == "Creation keyboard handoff", "Failed creation restores the draft")
  ChatSendHandoff.cancel(id: "creation-focus-\(dismisses)")
  creationInput.resignFirstResponder()
  creationComposer.removeFromSuperview()
}
print("Composer: pushed creation retains focus, ordinary send dismisses, failure restores")

let queueComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 244))
let runningState = #"{"editable":true,"canSend":true,"sending":false,"running":true,"canStop":true,"notice":"","reconnect":false,"placeholder":"任务"}"#
queueComposer.setComposerState(runningState)
let queueInput = descendants(queueComposer).compactMap { $0 as? UITextView }.first!
let queueSend = descendants(queueComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-stop" }!
var stopCalls = 0
var queuePayload: [String: Any] = [:]
queueComposer.onStop = { stopCalls += 1 }
queueComposer.onSend = { queuePayload = $0 }
@MainActor func tapQueueAction() {
  for action in queueSend.actions(forTarget: queueComposer, forControlEvent: .touchUpInside) ?? [] {
    queueComposer.perform(NSSelectorFromString(action))
  }
}
tapQueueAction()
precondition(stopCalls == 1 && queuePayload.isEmpty, "Empty running input must stop without creating a message")
queueInput.text = "  "
queueComposer.textViewDidChange(queueInput)
precondition(queueSend.accessibilityIdentifier == "session-stop", "Whitespace is not a draft")
queueInput.text = "Next instruction"
queueComposer.textViewDidChange(queueInput)
precondition(queueSend.accessibilityIdentifier == "session-send" && queueSend.isEnabled, "Typing switches Stop to Send")
tapQueueAction()
precondition(queuePayload["queue"] as? Bool == true && queueInput.text.isEmpty, "Busy submission must queue and clear the draft")
queueComposer.clearDraft(token: 1)
precondition(queueSend.accessibilityIdentifier == "session-stop" && queueSend.isEnabled, "Queue ACK restores Stop")
queueComposer.setQueue((1...4).map { ChatQueuedDraft(id: "q\($0)", text: "Queued \($0)") })
queueComposer.layoutIfNeeded()
let queuePanel = descendants(queueComposer).first { $0.accessibilityIdentifier == "session-queue" }!
precondition(queuePanel.bounds.height == 132 && !queuePanel.isHidden, "Long plain queues stay compact at three 44 pt rows and scroll")
queueComposer.setQueue([
  ChatQueuedDraft(id: "q1", text: "Queued 1"),
  ChatQueuedDraft(id: "q2", text: "Queued 2", attachments: ["shot.png"]),
])
queueComposer.layoutIfNeeded()
let queuedRows = descendants(queuePanel).compactMap { $0 as? UILabel }
precondition(queuedRows.contains { $0.text == "shot.png" }, "Queued attachments must show their file names")
precondition(queuePanel.bounds.height > 44 + 44, "An attachment row is taller than a plain row")
queueComposer.setQueue([ChatQueuedDraft(id: "q3", text: "", attachments: ["shot.png"])])
queueComposer.layoutIfNeeded()
precondition(
  descendants(queuePanel).compactMap { ($0 as? UILabel)?.text }.contains(String(localized: "native.chat.row.queuedAttachmentsOnly", bundle: .lody)),
  "An attachment-only queued turn needs a message placeholder"
)
queueComposer.setQueue([])
precondition(queuePanel.isHidden, "Drained queue must leave no empty card")
queueComposer.setInitialAttachments(#"[{"id":"queue-file","name":"next.txt","uri":"file:///tmp/next.txt","kind":"file"}]"#)
precondition(queueSend.accessibilityIdentifier == "session-send" && queueSend.isEnabled, "An attachment switches Stop to Send even with empty text")
print("Queue composer: Stop, whitespace, typing, queued submission, ACK, bounded queue and attachment-only input passed")

let guideWindow = HandoffWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let guideComposer = ChatComposerView(frame: CGRect(x: 0, y: 600, width: 390, height: 244))
guideWindow.addSubview(guideComposer)
guideWindow.isHidden = false
guideComposer.setComposerState(#"{"editable":true,"canSend":true,"sending":false,"running":true,"canStop":true,"steerInterrupts":false,"queuedMessageBehavior":"guide","notice":"","reconnect":false,"placeholder":"任务"}"#)
let guideInput = descendants(guideComposer).compactMap { $0 as? UITextView }.first!
let guideSend = descendants(guideComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-stop" || $0.accessibilityIdentifier == "session-send" }!
var guidePayload: [String: Any] = [:]
guideComposer.onSend = { guidePayload = $0 }
guideInput.text = "Steer now"
guideComposer.textViewDidChange(guideInput)
precondition(guideSend.accessibilityIdentifier == "session-send" && guideSend.isEnabled, "Guide still sends from a running composer")
@MainActor func tapGuideAction() {
  for action in guideSend.actions(forTarget: guideComposer, forControlEvent: .touchUpInside) ?? [] {
    guideComposer.perform(NSSelectorFromString(action))
  }
}
tapGuideAction()
precondition(guidePayload["queue"] as? Bool == false, "Guide must not mark the send as queued")
precondition(guidePayload["guide"] as? Bool == true, "Guide must mark the send for steer delivery")
precondition(guideInput.text.isEmpty, "Guide send must clear the draft")
precondition(onMain { ChatSendHandoff.isWaiting(id: guidePayload["id"] as! String) }, "Guide send must fly from the composer, not sit in the queue")
onMain { ChatSendHandoff.cancel(id: guidePayload["id"] as! String) }
print("Guide composer: busy send skips the queue and starts a straight handoff")

// A steered queue row hands its frame to the send animation instead of vanishing.
let steerWindow = HandoffWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let steerComposer = ChatComposerView(frame: CGRect(x: 0, y: 600, width: 390, height: 244))
steerWindow.addSubview(steerComposer)
steerWindow.isHidden = false
steerComposer.setComposerState(runningState)
steerComposer.setQueue([ChatQueuedDraft(id: "s1", text: "Steer me"), ChatQueuedDraft(id: "s2", text: "Stay queued")])
steerComposer.layoutIfNeeded()
steerComposer.setQueue([ChatQueuedDraft(id: "s2", text: "Stay queued")])
precondition(onMain { ChatSendHandoff.isWaiting(id: "s1") }, "A steered row must start its flight before leaving the queue")
precondition(onMain { !ChatSendHandoff.isWaiting(id: "s2") }, "A row that stays queued must not fly")
let steerTarget = ChatMessageContent(frame: CGRect(x: 200, y: 120, width: 170, height: 45))
steerTarget.label.setText(NSAttributedString(string: "Steer me"))
steerWindow.addSubview(steerTarget)
onMain { ChatSendHandoff.hold(id: "s1", target: steerTarget) }
onMain { ChatSendHandoff.deliver(id: "s1", to: steerTarget) }
let steerFlight = steerWindow.subviews.compactMap { $0 as? ChatMessageContent }.first { $0 !== steerTarget }
precondition(steerFlight?.layer.animation(forKey: "throw.scale") == nil, "A steered message slides straight, without the throw squash")
precondition(steerFlight?.layer.animation(forKey: "throw.position") != nil, "A steered message must animate to its landed row")
onMain { ChatSendHandoff.cancel(id: "s1") }
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
precondition(!steerTarget.isHidden, "Cancelling a steer flight must reveal the landed row")
print("Steer flight: departing queue rows slide straight into the transcript and clean up on cancellation")


let modelComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 120))
modelComposer.setComposerState(ready)
modelComposer.setComposerOptions(#"{"modelId":"gpt","models":[{"id":"gpt","title":"GPT"}],"effort":"medium","efforts":[{"id":"medium","title":"Medium"}]}"#)
let modelButton = descendants(modelComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-model" }!
precondition(
  modelButton.configuration?.preferredSymbolConfigurationForImage
    == UIImage.SymbolConfiguration(pointSize: 5, weight: .medium),
  "The model trigger chevron must use the compact 5-point symbol size"
)
print("Composer: model trigger chevron stays compact")

let glassComposer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
let glassWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
glassWindow.addSubview(glassComposer)
glassWindow.isHidden = false
glassComposer.onHeightChange = { height in
  glassComposer.frame.size.height = height
}
glassComposer.setComposerState(ready)
glassComposer.setComposerOptions(
  #"{"modelId":"gpt","models":[{"id":"gpt","title":"GPT"}],"effort":"medium","efforts":[{"id":"medium","title":"Medium"}]}"#
)
glassComposer.layoutIfNeeded()

let glassInput = descendants(glassComposer).compactMap { $0 as? UITextView }.first!
let glassAttach = descendants(glassComposer).compactMap { $0 as? UIButton }.first {
  $0.accessibilityIdentifier == "session-attach"
}!
let glassSend = descendants(glassComposer).compactMap { $0 as? UIButton }.first {
  $0.accessibilityIdentifier == "session-send"
}!
let glassModel = descendants(glassComposer).compactMap { $0 as? UIButton }.first {
  $0.accessibilityIdentifier == "session-model"
}!
let glassInputSurface = sequence(first: glassInput.superview, next: { $0?.superview }).lazy.compactMap { $0 as? UIVisualEffectView }.first!
glassComposer.layoutIfNeeded()

@MainActor func assertGlassCapsule(_ label: String) {
  let surface = glassInputSurface.convert(glassInputSurface.bounds, to: glassComposer)
  let attach = glassAttach.convert(glassAttach.bounds, to: glassInputSurface)
  precondition(abs(surface.minX - 20) < 0.5 && abs(glassComposer.bounds.maxX - surface.maxX - 20) < 0.5 && abs(surface.height - 48) < 0.5,
    "\(label): the resting composer must be one 48-point capsule aligned with the transcript's 20-point side insets; got \(surface)")
  precondition(glassAttach.isDescendant(of: glassInputSurface) && abs(attach.minX - 2) < 0.5 && abs(attach.midY - surface.height / 2) < 0.5,
    "\(label): Add must sit at the capsule's leading end; got \(attach)")
  precondition(glassSend.isHidden, "\(label): an empty resting capsule must not show Send")
}

assertGlassCapsule("rest")
glassComposer.setMentionItems("[]")
precondition(glassInput.becomeFirstResponder(), "The glass composer input must accept focus")
RunLoop.current.run(until: Date().addingTimeInterval(0.35))
glassComposer.layoutIfNeeded()

let mentionEntry = descendants(glassComposer).first { $0.accessibilityIdentifier == "session-mention" }!
glassComposer.setComposerState(ready)
precondition(!mentionEntry.isHidden, "Ordinary composer state updates must not erase the separately loaded reference catalog")
let focusedSheetFrame = glassInputSurface.convert(glassInputSurface.bounds, to: glassComposer)
precondition(abs(focusedSheetFrame.minX) < 0.5 && abs(focusedSheetFrame.maxX - glassComposer.bounds.maxX) < 0.5
  && focusedSheetFrame.maxY >= glassComposer.bounds.maxY + 30,
  "Focus must turn the capsule into an edge-to-edge sheet whose material continues behind the keyboard's rounded corners; got \(focusedSheetFrame)")
precondition(glassSend.convert(glassSend.bounds, to: glassComposer).maxY <= glassComposer.bounds.maxY + 0.5,
  "Sheet controls must stay above the keyboard edge")
precondition(glassInput.bounds.height >= 132, "The focused text area must start at five lines; got \(glassInput.bounds.height)")
let focusedAttachFrame = glassAttach.convert(glassAttach.bounds, to: glassComposer)
glassInputSurface.transform = CGAffineTransform(scaleX: 1.05, y: 1.05)
let pressedAttachFrame = glassAttach.convert(glassAttach.bounds, to: glassComposer)
precondition(abs(pressedAttachFrame.width - focusedAttachFrame.width * 1.05) < 0.5,
  "Pressing the sheet glass must scale the toolbar Add along with its content")
glassInputSurface.transform = .identity

let attachCenter = glassAttach.convert(CGPoint(x: glassAttach.bounds.midX, y: glassAttach.bounds.midY), to: glassInputSurface)
let sendCenter = glassSend.convert(CGPoint(x: glassSend.bounds.midX, y: glassSend.bounds.midY), to: glassInputSurface)
let modelFrame = glassModel.convert(glassModel.bounds, to: glassInputSurface)
let sendFrame = glassSend.convert(glassSend.bounds, to: glassInputSurface)
let attachInset = attachCenter.x
let sendInset = glassInputSurface.bounds.maxX - sendCenter.x
let baselineDelta = attachCenter.y - sendCenter.y
print("Composer sheet metrics: add \(attachInset), send \(sendInset), baseline \(baselineDelta)")
precondition(abs(attachInset - 30) < 0.5 && abs(sendInset - 24) < 0.5 && abs(baselineDelta) < 0.5 && !glassSend.isHidden,
  "Toolbar Add must center 30 points in and Send 24 points in on one baseline; got add \(attachInset), send \(sendInset), baseline \(baselineDelta)")
precondition(attachCenter.y > glassInput.convert(glassInput.bounds, to: glassInputSurface).maxY,
  "The toolbar must sit below the text")
precondition(!glassModel.isHidden && modelFrame.midX > glassInputSurface.bounds.midX && modelFrame.maxX <= sendFrame.minX + 0.5,
  "The focused model selector must remain on the trailing side before Send")
print("Composer glass: focus turns the capsule into an edge-to-edge sheet with a balanced toolbar")
glassInput.text = "@"
glassInput.selectedRange = NSRange(location: 1, length: 0)
glassComposer.textViewDidChange(glassInput)
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
glassComposer.layoutIfNeeded()
let sheetMentions = descendants(glassComposer).compactMap { $0 as? ChatMentionPanel }.first!
precondition(!sheetMentions.isHidden && sheetMentions.isDescendant(of: glassInputSurface) && sheetMentions.effect == nil,
  "Mention results must open inside the sheet, on the sheet's own material")
precondition(sheetMentions.convert(sheetMentions.bounds, to: glassInputSurface).maxY <= glassInput.convert(glassInput.bounds, to: glassInputSurface).minY + 0.5,
  "Mention results must sit above the text")
precondition(abs(sheetMentions.convert(sheetMentions.bounds, to: glassInputSurface).width - glassInputSurface.bounds.width) < 0.5,
  "Mention results must span the sheet")
glassInput.text = ""
glassComposer.textViewDidChange(glassInput)
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
print("Composer mentions: results open inside the sheet above the text")
glassComposer.allowsFullScreen = true
glassComposer.layoutIfNeeded()
let grabber = descendants(glassComposer).first { $0.accessibilityIdentifier == "session-grabber" }
precondition(grabber.map { !$0.isHidden && $0.isDescendant(of: glassInputSurface) } == true, "A full-screen-capable sheet must show its grabber")
let grabberFrame = grabber!.convert(grabber!.bounds, to: glassInputSurface)
precondition(grabberFrame.minY < 1 && grabberFrame.maxY <= glassInput.convert(glassInput.bounds, to: glassInputSurface).minY + 0.5,
  "The grabber must lead the sheet; got \(grabberFrame)")
let firstLine = glassInputSurface.convert(CGPoint(x: glassInputSurface.bounds.midX, y: grabberFrame.maxY + 4), to: glassComposer)
precondition(glassComposer.hitTest(firstLine, with: nil)?.isDescendant(of: glassInput) == true,
  "A touch on the first text line must reach the text, not the grabber")
precondition(ChatComposerView.grabberRelease(fromFullScreen: false, progress: 0, translation: 40, velocity: 1500) == .close,
  "A fast downward flick from the default sheet must close it")
precondition(ChatComposerView.grabberRelease(fromFullScreen: false, progress: 0, translation: 70, velocity: 0) == .close,
  "A long downward drag from the default sheet must close it")
precondition(ChatComposerView.grabberRelease(fromFullScreen: true, progress: 0.8, translation: 40, velocity: 1500) == .sheet,
  "A fast downward flick from full screen returns to the default sheet")
precondition(ChatComposerView.grabberRelease(fromFullScreen: false, progress: 0.2, translation: -30, velocity: -900) == .fullScreen,
  "A fast upward flick opens full screen")
precondition(ChatComposerView.grabberRelease(fromFullScreen: false, progress: 0.6, translation: -100, velocity: 0) == .fullScreen,
  "Releasing past halfway opens full screen")
precondition(!descendants(glassComposer).contains { $0.accessibilityIdentifier == "session-expand" }, "The grabber replaces the expand button")
_ = grabber!.accessibilityActivate()
RunLoop.current.run(until: Date().addingTimeInterval(0.6))
glassComposer.layoutIfNeeded()
precondition(grabber!.accessibilityLabel == String(localized: "native.chat.composer.collapse", bundle: .lody),
  "Activating the grabber must open full screen")
_ = grabber!.accessibilityActivate()
RunLoop.current.run(until: Date().addingTimeInterval(0.6))
glassComposer.layoutIfNeeded()
precondition(grabber!.accessibilityLabel == String(localized: "native.chat.composer.expand", bundle: .lody),
  "Activating the grabber again must return to the default sheet")
glassComposer.allowsFullScreen = false
glassComposer.layoutIfNeeded()
precondition(grabber!.isHidden, "Hosts without full screen have no grabber")
print("Composer grabber: toggles full screen and replaces the expand button")
glassInput.resignFirstResponder()
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
glassComposer.layoutIfNeeded()
assertGlassCapsule("dismissed")
glassInput.becomeFirstResponder()
RunLoop.current.run(until: Date().addingTimeInterval(0.05))
glassInput.resignFirstResponder()
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
glassComposer.layoutIfNeeded()
assertGlassCapsule("cancelled opening")

// A trigger belongs to the active caret token, never email or selected prose.
assert(ChatMentionPanel.activeRange(text: "😀 @auth", selection: NSRange(location: 8, length: 0)) == NSRange(location: 3, length: 5))
assert(ChatMentionPanel.activeRange(text: "mail@host", selection: NSRange(location: 9, length: 0)) == nil)
assert(ChatMentionPanel.activeRange(text: "@auth ", selection: NSRange(location: 6, length: 0)) == nil)
assert(ChatMentionPanel.activeRange(text: "@auth", selection: NSRange(location: 1, length: 3)) == nil)

assert(ChatMentionPanel.activeRange(text: "😀 $auth", selection: NSRange(location: 8, length: 0)) == NSRange(location: 3, length: 5))
assert(ChatMentionPanel.activeRange(text: "/compact", selection: NSRange(location: 8, length: 0)) == NSRange(location: 0, length: 8))
assert(ChatMentionPanel.activeRange(text: "read /tmp", selection: NSRange(location: 9, length: 0)) == nil)
assert(ChatMentionPanel.activeRange(text: "/tmp/file", selection: NSRange(location: 9, length: 0)) == nil)

// A cancelled exit must not later hide a reopened picker or clear its layout space.
let referenceWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let referenceInput = UITextView(frame: CGRect(x: 0, y: 400, width: 390, height: 60))
let referencePanel = ChatMentionPanel(frame: CGRect(x: 16, y: 280, width: 358, height: 112))
referenceWindow.addSubview(referenceInput)
referenceWindow.addSubview(referencePanel)
referenceWindow.isHidden = false
precondition(referenceInput.becomeFirstResponder())
let referenceItems = [ChatMentionItem(path: "src", name: "src", kind: "directory", subtitle: "Project files")]
@MainActor func referenceText(_ text: String) {
  referenceInput.text = text
  referenceInput.selectedRange = NSRange(location: (text as NSString).length, length: 0)
  referencePanel.update(input: referenceInput, items: referenceItems)
}
referenceText("@")
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
precondition(!referencePanel.isHidden && referencePanel.alpha == 1)
referenceText("")
precondition(!referencePanel.isHidden && referencePanel.panelHeight > 0 && !referencePanel.isUserInteractionEnabled,
             "An exiting panel must retain its content and layout space until its animation finishes")
RunLoop.current.run(until: Date().addingTimeInterval(0.03))
referenceText("@")
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
precondition(!referencePanel.isHidden && referencePanel.alpha == 1 && referencePanel.panelHeight > 0,
             "An interrupted exit must leave the reopened panel visible and usable")
referenceText("ordinary text")
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
precondition(referencePanel.isHidden && referencePanel.panelHeight == 0,
             "A completed exit must release the reserved layout space")
referenceInput.text = "@"
referenceInput.selectedRange = NSRange(location: 1, length: 0)
referencePanel.update(input: referenceInput, items: [])
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
precondition(!referencePanel.isHidden && referencePanel.panelHeight > 0,
             "The real reference entry must remain usable while its catalog is loading or empty")
let referenceList = descendants(referencePanel).compactMap { $0 as? UICollectionView }.first!
referencePanel.collectionView(referenceList, didSelectItemAt: IndexPath(item: 1, section: 0))
let skill = ChatMentionItem(path: "/Users/test/skills/auth/SKILL.md", name: "auth-review", kind: "skill", subtitle: "Auth", insertText: "$auth-review")
referencePanel.finishBrowse(path: skill.path, selectedItem: skill)
precondition(referenceInput.text == skill.insertText! + " ",
             "A remotely selected skill must insert only its short token even when the inline catalog has not arrived")
print("References: empty catalog browse and remote skill insertion passed")
precondition(referenceInput.becomeFirstResponder())
referenceInput.text = "/"
referenceInput.selectedRange = NSRange(location: 1, length: 0)
referencePanel.update(input: referenceInput, items: [skill])
RunLoop.current.run(until: Date().addingTimeInterval(0.4))
precondition(referencePanel.isHidden, "An agent without commands must not show an empty slash menu")
let command = ChatMentionItem(path: "compact", name: "compact", kind: "cmd", subtitle: "Compact", insertText: "/compact")
referencePanel.update(input: referenceInput, items: [skill, command])
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
precondition(!referencePanel.isHidden)
precondition(referencePanel.collectionView(referenceList, numberOfItemsInSection: 0) == 1, "Slash must open commands directly")
referencePanel.collectionView(referenceList, didSelectItemAt: IndexPath(item: 0, section: 0))
precondition(referenceInput.text == "/compact ")
referenceInput.text = "$"
referenceInput.selectedRange = NSRange(location: 1, length: 0)
referencePanel.update(input: referenceInput, items: [skill, command])
precondition(referencePanel.collectionView(referenceList, numberOfItemsInSection: 0) == 1, "Dollar must open skills directly")
referencePanel.collectionView(referenceList, didSelectItemAt: IndexPath(item: 0, section: 0))
precondition(referenceInput.text == "$auth-review ")

referenceText("@")
referencePanel.removeFromSuperview()
RunLoop.current.run(until: Date().addingTimeInterval(0.25))
precondition(referencePanel.isHidden && referencePanel.panelHeight == 0,
             "Removing the host must cancel a queued entrance")
print("Reference motion: delayed removal, interrupted exit, and host teardown passed")

let prDraft = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 402, height: 180))
prDraft.setInitialDraft("Existing draft")
var savedPRDraft = ""
prDraft.onDraftChange = { savedPRDraft = $0 }
let prInput = descendants(prDraft).compactMap { $0 as? UITextView }.first!
prDraft.appendDraft(#"{"id":"pr-1","text":"Investigate CI"}"#)
precondition(prInput.text == "Existing draft\n\nInvestigate CI" && savedPRDraft.contains("\"lexical\""))
prDraft.appendDraft(#"{"id":"pr-1","text":"Investigate CI"}"#)
precondition(prInput.text == "Existing draft\n\nInvestigate CI", "A prop replay must not append twice")
print("PR investigation: existing draft preserved, appended text saved and prop replay ignored")

let materialWindow = HandoffWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
let materialComposer = ChatComposerView(frame: CGRect(x: 0, y: 500, width: 390, height: 200))
materialWindow.addSubview(materialComposer)
materialWindow.isHidden = false
materialComposer.setComposerState(ready)
var materialHeight: CGFloat = 0
materialComposer.onHeightChange = { materialHeight = $0 }
materialComposer.setQueue([ChatQueuedDraft(id: "material-queue", text: "Last queued turn")])
materialComposer.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
let materialQueue = descendants(materialComposer).first { $0.accessibilityIdentifier == "session-queue" } as! CKGlassSurface
let withQueue = materialHeight
materialComposer.setQueue([])
precondition(!materialQueue.isHidden && !materialQueue.isUserInteractionEnabled && materialHeight == withQueue,
  "The last queue card must keep its space until its glass leaves")
precondition(materialComposer.retiringQueueHeight == 44,
  "Retiring glass must stop reserving transcript space before the message flies")
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
precondition(materialQueue.isHidden && materialHeight == withQueue - 44 && materialComposer.retiringQueueHeight == 0)
ChatSendHandoff.cancel(id: "material-queue")

let materialInput = descendants(materialComposer).compactMap { $0 as? UITextView }.first!
precondition(materialInput.becomeFirstResponder(), "The attachment row lives in the open sheet")
RunLoop.main.run(until: Date().addingTimeInterval(0.35))
materialComposer.setInitialAttachments(#"[{"id":"remove-a","name":"a.txt","uri":"file:///tmp/a.txt","kind":"file"},{"id":"keep-b","name":"b.txt","uri":"file:///tmp/b.txt","kind":"file"}]"#)
materialComposer.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
let materialBar = descendants(materialComposer).compactMap { $0 as? ChatAttachmentBar }.first!
let retained = descendants(materialBar).compactMap { $0 as? UIButton }.first {
  $0.accessibilityLabel == String.localizedStringWithFormat(String(localized: "native.chat.attachment.preview", bundle: .lody), String(describing: "b.txt"))
}!
@MainActor func removeMaterialAttachment(_ name: String) {
  let button = descendants(materialBar).compactMap { $0 as? UIButton }.first {
    $0.accessibilityLabel == String.localizedStringWithFormat(String(localized: "native.chat.attachment.remove", bundle: .lody), String(describing: name))
  }!
  button.sendActions(for: .touchUpInside)
}
removeMaterialAttachment("a.txt")
precondition(materialBar.attachmentFrame(id: "remove-a") == nil && retained.window != nil,
  "Deleting a pill updates the draft immediately and preserves the other native control")
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
precondition(materialBar.attachmentFrame(id: "keep-b") != nil)
let withAttachment = materialHeight
removeMaterialAttachment("b.txt")
precondition(materialBar.hasVisiblePills && materialHeight == withAttachment,
  "The final attachment reserves its height through dematerialization")
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
precondition(!materialBar.hasVisiblePills && materialHeight == withAttachment - 88, "The emptied attachment row releases its 8-point inset and 80-point tile height; got \(withAttachment - materialHeight)")
materialInput.resignFirstResponder()
print("Glass hosts: queue and final attachment retain their space through exit; unrelated pills retain identity")

let barComposer = ChatComposerView(frame: CGRect(x: 0, y: 600, width: 390, height: 108))
materialWindow.addSubview(barComposer)
barComposer.onHeightChange = { barComposer.frame.size.height = $0 }
let actionBar = descendants(barComposer).compactMap { $0 as? ChatActionBarView }.first!
@MainActor func barState(_ extra: [String: Any]) {
  var state: [String: Any] = ["editable": true, "canSend": true, "sending": false, "running": false, "placeholder": "Task"]
  state.merge(extra) { $1 }
  barComposer.setComposerState(String(decoding: try! JSONSerialization.data(withJSONObject: state), as: UTF8.self))
  barComposer.layoutIfNeeded()
}
barState([:])
precondition(actionBar.isHidden && actionBar.bounds.height < 0.5, "Without content the action bar leaves the composer")
let barContent: [String: Any] = [
  "items": [["id": "machine", "symbol": "desktopcomputer", "accessibilityLabel": "Studio, Online", "actions": []]],
  "context": ["label": "#7", "symbol": "arrow.triangle.pull", "tint": "open", "accessibilityLabel": "lody/zed #7", "actions": []],
  "diff": ["added": 12, "removed": 3, "accessibilityLabel": "+12 −3", "tap": true],
  "primary": ["label": "Commit & Push", "more": [["id": "merge", "title": "Merge", "symbol": "arrow.triangle.merge"]], "moreLabel": "More actions"],
]
barState(["actionBar": barContent])
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
barComposer.layoutIfNeeded()
precondition(!actionBar.isHidden && abs(actionBar.bounds.height - ChatActionBarView.rowHeight) < 0.5,
  "The action bar keeps its capsules on one row at the default text size")
var barActions: [String] = []
barComposer.onPreview = { barActions.append($0) }
actionBar.onAction?("act")
actionBar.onAction?("more:merge")
precondition(barActions == ["bar:act", "bar:more:merge"], "Bar actions reach the session as bar: ids")
barState(["actionBar": barContent, "running": true])
precondition(!actionBar.isHidden, "The bar stays while the agent runs")
barComposer.removeFromSuperview()
print("Action bar: hidden without content, one row of capsules, survives running, actions routed as bar: ids")

let orderComposer = ChatComposerView(frame: CGRect(x: 0, y: 300, width: 390, height: 300))
materialWindow.addSubview(orderComposer)
orderComposer.onHeightChange = { orderComposer.frame.size.height = $0 }
let orderState: [String: Any] = [
  "editable": true, "canSend": true, "sending": false, "running": true, "canStop": true,
  "notice": "Machine disconnected. Tap to reconnect.", "reconnect": true, "placeholder": "Task",
  "actionBar": ["primary": ["label": "Commit & Push", "more": [], "moreLabel": "More actions"]],
]
orderComposer.setComposerState(String(decoding: try! JSONSerialization.data(withJSONObject: orderState), as: UTF8.self))
orderComposer.setQueue([ChatQueuedDraft(id: "order-queue", text: "Then run pnpm check")])
orderComposer.layoutIfNeeded()
RunLoop.main.run(until: Date().addingTimeInterval(0.4))
orderComposer.layoutIfNeeded()
@MainActor func orderFrame(_ view: UIView) -> CGRect { view.convert(view.bounds, to: orderComposer) }
let orderNotice = descendants(orderComposer).compactMap { $0 as? UIButton }.first { $0.title(for: .normal) == "Machine disconnected. Tap to reconnect." }!
let orderChips = descendants(orderComposer).compactMap { $0 as? ChatActionBarView }.first!
let orderQueue = descendants(orderComposer).first { $0.accessibilityIdentifier == "session-queue" }!
let orderInput = descendants(orderComposer).compactMap { $0 as? UITextView }.first!
let orderSurface = sequence(first: orderInput.superview, next: { $0?.superview }).lazy.compactMap { $0 as? UIVisualEffectView }.first!
precondition(!orderChips.isHidden && !orderQueue.isHidden && !orderNotice.isHidden, "The order fixture must show notice, action bar and queue")
precondition(orderFrame(orderNotice).maxY <= orderFrame(orderChips).minY + 0.5, "The notice must sit above the action bar")
precondition(orderFrame(orderChips).maxY <= orderFrame(orderQueue).minY + 0.5, "The queue must sit below the action bar")
precondition(orderFrame(orderQueue).maxY <= orderFrame(orderSurface).minY + 0.5, "The queue must sit directly above the capsule")
precondition(abs(orderFrame(orderQueue).minX - 16) < 0.5 && abs(orderComposer.bounds.maxX - orderFrame(orderQueue).maxX - 16) < 0.5,
  "The queue card keeps 16-point side insets")
orderComposer.removeFromSuperview()
print("Composer order: notice, action bar, queue, then the capsule")

@MainActor func makeRichComposer() -> (ChatComposerView, ChatComposerInput) {
  let composer = ChatComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
  let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
  window.addSubview(composer)
  window.isHidden = false
  composer.setComposerState(ready)
  composer.layoutIfNeeded()
  let input = descendants(composer).compactMap { $0 as? ChatComposerInput }.first!
  precondition(input.becomeFirstResponder())
  return (composer, input)
}
@MainActor func typeInto(_ input: ChatComposerInput, _ text: String) {
  for character in text { input.insertText(String(character)) }
}
@MainActor func tapSend(on composer: ChatComposerView) {
  let button = descendants(composer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
  for action in button.actions(forTarget: composer, forControlEvent: .touchUpInside) ?? [] {
    composer.perform(NSSelectorFromString(action))
  }
}

let (richComposer, richInput) = makeRichComposer()
precondition(richInput.textLayoutManager != nil, "The composer must stay on TextKit 2")
var richSent: [String] = []
richComposer.onSend = { richSent.append($0["text"] as! String) }
typeInto(richInput, "**bold** and `code`")
precondition(richInput.text == "bold and code", "Markdown shortcuts must format in place instead of leaving tags")
typeInto(richInput, "\nnext")
tapSend(on: richComposer)
precondition(richSent == ["**bold** and `code`\nnext"], "The sent body must be Markdown with the newline the user typed")
richComposer.setComposerState(ready)
richComposer.restoreDraft(token: 1)
precondition(richInput.text == "bold and code\nnext", "A rejected send must restore the draft")
tapSend(on: richComposer)
precondition(richSent.last == "**bold** and `code`\nnext", "A restored draft must keep its formatting")
print("Rich composer: shortcuts, Markdown body, typed newlines and formatted restore passed")

let (envelopeComposer, envelopeInput) = makeRichComposer()
var storedDrafts: [String] = []
envelopeComposer.onDraftChange = { storedDrafts.append($0) }
typeInto(envelopeInput, "**keep**")
envelopeComposer.textViewDidEndEditing(envelopeInput)
precondition(storedDrafts.last?.contains("\"lexical\"") == true, "Drafts must persist the editor state envelope")
let (restoredComposer, restoredInput) = makeRichComposer()
restoredComposer.setStoredDraft(storedDrafts.last!)
var restoredSent: [String] = []
restoredComposer.onSend = { restoredSent.append($0["text"] as! String) }
precondition(restoredInput.text == "keep", "An envelope draft must restore its document, not its JSON")
tapSend(on: restoredComposer)
precondition(restoredSent == ["**keep**"], "A restored envelope draft must keep its formatting")
let (legacyComposer, legacyInput) = makeRichComposer()
legacyComposer.setStoredDraft("plain *text*\nline two")
var legacySent: [String] = []
legacyComposer.onSend = { legacySent.append($0["text"] as! String) }
precondition(legacyInput.text == "plain *text*\nline two", "A plain-text draft from an older build must restore verbatim")
tapSend(on: legacyComposer)
precondition(legacySent == ["plain *text*\nline two"], "Plain drafts must send exactly what was stored")
print("Rich composer: envelope and legacy draft restoration passed")

let (chipComposer, chipInput) = makeRichComposer()
let chipPanel = ChatMentionPanel(frame: CGRect(x: 16, y: 280, width: 358, height: 112))
chipComposer.window!.addSubview(chipPanel)
chipInput.text = "/"
chipInput.selectedRange = NSRange(location: 1, length: 0)
let chipCommand = ChatMentionItem(path: "compact", name: "compact", kind: "cmd", subtitle: "Compact", insertText: "/compact")
chipPanel.update(input: chipInput, items: [chipCommand])
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
let chipList = descendants(chipPanel).compactMap { $0 as? UICollectionView }.first!
chipPanel.collectionView(chipList, didSelectItemAt: IndexPath(item: 0, section: 0))
precondition(chipInput.text == "/compact ", "A reference must insert exactly its token")
precondition(chipInput.referenceTokens == ["/compact"], "An inserted reference must become a chip node")
typeInto(chipInput, "now")
var chipSent: [String] = []
chipComposer.onSend = { chipSent.append($0["text"] as! String) }
tapSend(on: chipComposer)
precondition(chipSent == ["/compact now"], "A chip must send the same token text as before")
chipComposer.setComposerState(ready)
chipComposer.restoreDraft(token: 1)
precondition(chipInput.referenceTokens == ["/compact"], "A restored draft must keep its chips")
for _ in 0..<5 { chipInput.deleteBackward() }
precondition(chipInput.text == "", "Deleting into a chip must remove the whole token")
print("Rich composer: reference chips insert, send, restore and delete as one token")

let (retryComposer, retryInput) = makeRichComposer()
var retrySent: [String] = []
retryComposer.onSend = { retrySent.append($0["text"] as! String) }
typeInto(retryInput, "**bold** first")
tapSend(on: retryComposer)
retryComposer.setComposerState(ready)
typeInto(retryInput, "second")
retryComposer.restoreDraft(token: 1)
precondition(retryInput.text == "second", "A failed send must not overwrite text typed after it")
retryComposer.perform(NSSelectorFromString("reconnect"))
tapSend(on: retryComposer)
precondition(retrySent.last?.contains("**bold** first") == true, "Retrying a failed send must keep its Markdown, got \(retrySent)")
print("Rich composer: retried failed send keeps its Markdown")

let (historyComposer, historyInput) = makeRichComposer()
let historySend = descendants(historyComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }!
typeInto(historyInput, "undo me")
precondition(historySend.isEnabled && historyInput.undoManager?.canUndo == true, "Typing in the composer must be undoable")
historyInput.undoManager?.undo()
precondition(historyInput.text == "", "Undo must revert typing, got \(historyInput.text!)")
precondition(!historySend.isEnabled, "Undo must refresh the composer like any other edit")
historyInput.undoManager?.redo()
precondition(historyInput.text == "undo me" && historySend.isEnabled, "Redo must restore the typed text")
print("Rich composer: undo and redo revert typing and refresh the composer")

@MainActor func richProvider(_ representations: [(String, String)]) -> NSItemProvider {
  let provider = NSItemProvider()
  for (type, value) in representations {
    provider.registerDataRepresentation(forTypeIdentifier: type, visibility: .all) { completion in
      completion(Data(value.utf8), nil)
      return nil
    }
  }
  return provider
}
@MainActor func waitFor(_ condition: () -> Bool) {
  let deadline = Date().addingTimeInterval(3)
  while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
}

let (htmlComposer, htmlInput) = makeRichComposer()
var htmlSent: [String] = []
htmlComposer.onSend = { htmlSent.append($0["text"] as! String) }
htmlInput.paste(itemProviders: [richProvider([(UTType.html.identifier, "<p>Use <b>bold</b> and <code>code</code></p><ul><li>one</li></ul>"), (UTType.utf8PlainText.identifier, "Use bold and code\none")])])
waitFor { htmlInput.text.contains("one") }
tapSend(on: htmlComposer)
precondition(htmlSent.last == "Use **bold** and `code`\n- one", "HTML must paste as formatted nodes, got \(htmlSent)")

let (mdComposer, mdInput) = makeRichComposer()
var mdSent: [String] = []
mdComposer.onSend = { mdSent.append($0["text"] as! String) }
mdInput.paste(itemProviders: [richProvider([("net.daringfireball.markdown", "# Title\n**strong**"), (UTType.utf8PlainText.identifier, "# Title\n**strong**")])])
waitFor { mdInput.text.contains("strong") }
precondition(mdInput.text == "Title\nstrong", "Markdown-typed content must render, got \(mdInput.text!)")
tapSend(on: mdComposer)
precondition(mdSent.last == "# Title\n**strong**")

let (literalComposer, literalInput) = makeRichComposer()
literalInput.paste(itemProviders: [richProvider([(UTType.utf8PlainText.identifier, "def f(): # **not** bold")])])
waitFor { literalInput.text.contains("bold") }
precondition(literalInput.text == "def f(): # **not** bold", "Unmarked plain text must stay literal, got \(literalInput.text!)")
let safariProvider = richProvider([(UTType.html.identifier, "<b>web</b>"), (UTType.flatRTFD.identifier, "rtfd"), (UTType.rtf.identifier, "rtf"), (UTType.utf8PlainText.identifier, "web")])
precondition(!ChatAttachment.canPaste([safariProvider]), "Rich text selections must not claim Paste as an attachment")
let (safariComposer, safariInput) = makeRichComposer()
var safariSent: [String] = []
safariComposer.onSend = { safariSent.append($0["text"] as! String) }
safariInput.paste(itemProviders: [safariProvider])
waitFor { safariInput.text.contains("web") }
tapSend(on: safariComposer)
precondition(safariSent.last == "**web**", "A Safari-style selection must paste as formatted text, got \(safariSent)")
print("Rich composer: HTML and Markdown paste as nodes, plain text stays literal")

let (codeComposer, codeInput) = makeRichComposer()
typeInto(codeInput, "```")
typeInto(codeInput, " ")
codeInput.paste(itemProviders: [richProvider([(UTType.html.identifier, "<b>x</b>"), (UTType.utf8PlainText.identifier, "**x**")])])
waitFor { codeInput.text.contains("x") }
var codeSent: [String] = []
codeComposer.onSend = { codeSent.append($0["text"] as! String) }
tapSend(on: codeComposer)
precondition(codeSent.last == "```\n**x**\n```", "Pasting inside code must insert plain text, got \(codeSent)")

let (undoPasteComposer, undoPasteInput) = makeRichComposer()
typeInto(undoPasteInput, "base ")
undoPasteInput.paste(itemProviders: [richProvider([(UTType.html.identifier, "<i>one</i> <b>two</b>"), (UTType.utf8PlainText.identifier, "one two")])])
waitFor { undoPasteInput.text.contains("two") }
undoPasteInput.undoManager?.undo()
precondition(undoPasteInput.text == "base ", "One undo must remove the whole paste, got \(undoPasteInput.text!)")
_ = undoPasteComposer
print("Rich composer: code blocks take plain text and a paste is one undo step")

let (longRichComposer, longRichInput) = makeRichComposer()
let longRichHTML = (1...16).map { "<p><b>row \($0)</b></p>" }.joined()
longRichInput.paste(itemProviders: [richProvider([(UTType.html.identifier, longRichHTML), (UTType.utf8PlainText.identifier, "rows")])])
var longRichUndo: UIButton?
waitFor {
  longRichUndo = allWindows().flatMap(descendants).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "lody.toast.undo" }
  return longRichUndo != nil
}
var longRichSent: [[String: String]] = []
longRichComposer.onSend = { longRichSent = $0["attachments"] as! [[String: String]] }
precondition(longRichInput.text.isEmpty && longRichUndo != nil, "Long rich pastes must become a file with undo")
LodyToastOverlay.shared.performFrontAction()
waitFor { longRichInput.text.contains("row 16") }
var longRichText: [String] = []
longRichComposer.onSend = { longRichText.append($0["text"] as! String) }
tapSend(on: longRichComposer)
precondition(longRichText.last?.hasPrefix("**row 1**\n**row 2**") == true, "Undo must re-insert the formatted nodes, got \(longRichText)")

let (fileComposer, fileInput) = makeRichComposer()
var fileAttachments: [[String: String]] = []
fileComposer.onSend = { fileAttachments = $0["attachments"] as! [[String: String]] }
fileInput.paste(itemProviders: [richProvider([(UTType.html.identifier, longRichHTML), (UTType.utf8PlainText.identifier, "rows")])])
waitFor { descendants(fileComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }?.isEnabled == true }
LodyToastOverlay.shared.dismiss()
tapSend(on: fileComposer)
let fileURL = URL(string: fileAttachments.first?["uri"] ?? "")
precondition(fileAttachments.first?["name"] == "Text.md", "Rich long pastes are Markdown files, got \(fileAttachments)")
precondition(fileURL.flatMap { try? String(contentsOf: $0, encoding: .utf8) }?.hasPrefix("**row 1**") == true, "The file must hold the Markdown")

let (limitComposer, limitInput) = makeRichComposer()
typeInto(limitInput, "x")
limitInput.pastePlainText(from: [richProvider([(UTType.utf8PlainText.identifier, String(repeating: "y", count: 32000))])])
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
precondition(limitInput.text == "x", "A paste past 32,000 characters must be rejected")
_ = limitComposer
print("Rich composer: long rich pastes become Text.md with formatted undo; the limit uses Markdown length")

let copyBoard = UIPasteboard.withUniqueName()
copyBoard.setMessageMarkdown("**copied**")
precondition(copyBoard.contains(pasteboardTypes: ["net.daringfireball.markdown", UTType.utf8PlainText.identifier]), "Copied messages must carry Markdown")
print("Rich composer: copied messages carry the Markdown type")

let (logComposer, logInput) = makeRichComposer()
var logAttachments: [[String: String]] = []
logComposer.onSend = { logAttachments = $0["attachments"] as! [[String: String]] }
logInput.paste(itemProviders: [richProvider([(UTType.utf8PlainText.identifier, (1...3000).map { "log \($0)" }.joined(separator: "\n"))])])
waitFor { descendants(logComposer).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "session-send" }?.isEnabled == true }
LodyToastOverlay.shared.dismiss()
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
tapSend(on: logComposer)
precondition(logAttachments.first?["name"] == "Text.txt" && logInput.text.isEmpty, "A 3,000-line log must become Text.txt, got \(logAttachments)")

let (bigComposer, bigInput) = makeRichComposer()
bigInput.paste(itemProviders: [richProvider([(UTType.utf8PlainText.identifier, String(repeating: "z", count: 40000))])])
var bigUndo: UIButton?
waitFor {
  bigUndo = allWindows().flatMap(descendants).compactMap { $0 as? UIButton }.first { $0.accessibilityIdentifier == "lody.toast.undo" }
  return bigUndo != nil
}
LodyToastOverlay.shared.performFrontAction()
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
var bigAttachments: [[String: String]] = []
bigComposer.onSend = { bigAttachments = $0["attachments"] as! [[String: String]] }
tapSend(on: bigComposer)
precondition(bigAttachments.first?["name"] == "Text.txt", "Undo that cannot insert must keep the file, got \(bigAttachments)")
print("Rich composer: huge logs become Text.txt and a refused undo keeps the file")

// Friendly labels must never replace ordinary prose or confuse equal display names.
let (_, referenceInput) = makeRichComposer()
referenceInput.text = "@Same title "
referenceInput.insertReference("@session:first", label: "@Same title", replacing: NSRange(location: (referenceInput.text as NSString).length, length: 0))
referenceInput.insertReference("@session:second", label: "@Same title", replacing: NSRange(location: (referenceInput.text as NSString).length, length: 0))
precondition(referenceInput.markdown == "@Same title @session:first @session:second ")
let savedReferences = referenceInput.draftEnvelope
referenceInput.text = ""
referenceInput.restoreDraft(savedReferences)
precondition(referenceInput.markdown == "@Same title @session:first @session:second ")
precondition(!referenceInput.text.contains("session:"))
print("Mention labels: identical titles retain distinct tokens across draft restoration")
