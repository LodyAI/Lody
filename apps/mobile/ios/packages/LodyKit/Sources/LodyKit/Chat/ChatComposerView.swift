#if !LODY_SHARE_EXTENSION
import AnchoredOverlayKit
import AVFoundation
import Photos
#endif
import ChatKit
import EditorHistoryPlugin
import Lexical
import LexicalHTML
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown
import LodyDesignSystem
import UIKit
import UniformTypeIdentifiers

private struct ChatComposerState: Decodable {
  var mentionItems: [ChatMentionItem]?
  var actionBar: ChatActionBarState?
#if !LODY_SHARE_EXTENSION
  var usage: ChatSessionUsage?
#endif
  var editable = true
  var canSend = false
  var sending = false
  var running: Bool?
  var canStop: Bool?
  var stopping: Bool?
  var controlling: Bool?
  var steerID: String?
  var steerInterrupts: Bool?
  var queuedMessageBehavior: String?
  var notice = ""
  var quotaNotice: String?
  var reconnect = false
  var connection: String?
  var placeholder = String(localized: "native.chat.composer.placeholder", bundle: .lody)
}

struct ChatQueuedDraft: Equatable {
  let id: String
  let text: String
  var canSteer = true
  var attachments: [String] = []

  static func rowHeight(_ draft: ChatQueuedDraft) -> CGFloat {
    let caption = draft.attachments.isEmpty ? 0 : ceil(UIFont.dynamic(of: 12).lineHeight) + 2
    return max(44, ceil(UIFont.dynamic(of: 15).lineHeight) + caption + 10)
  }

  static func panelHeight(_ drafts: [ChatQueuedDraft]) -> CGFloat {
    drafts.prefix(3).reduce(0) { $0 + rowHeight($1) }
  }
}

private final class ChatQueueView: CKGlassSurface {
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var rendered: [ChatQueuedDraft] = []
  private var buttons: [String: UIButton] = [:]
  private var rows: [String: UIView] = [:]
  var onSteer: ((String) -> Void)?
  var onHeightChange: (() -> Void)?
  private(set) var panelHeight: CGFloat = 0

  init() {
    super.init(interactive: true)
    accessibilityIdentifier = "session-queue"
    onHidden = { [weak self] in
      guard let self else { return }
      self.panelHeight = 0
      self.onHeightChange?()
    }
    cornerConfiguration = .corners(radius: .fixed(20))
    stack.axis = .vertical
    scroll.addSubview(stack)
    contentView.addSubview(scroll)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: contentView.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
    ])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func render(_ drafts: [ChatQueuedDraft], enabled: Bool, steeringID: String, firstOnly: Bool) {
    if rendered != drafts {
      // A row that leaves the queue is on its way into the transcript: hand its
      // frame to the send animation before the row disappears.
      for draft in rendered where !drafts.contains(where: { $0.id == draft.id }) {
        guard let row = rows[draft.id], !draft.text.isEmpty else { continue }
        ChatSendHandoff.begin(id: draft.id, source: row, straight: true)
      }
      rendered = drafts
      stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
      buttons.removeAll()
      rows.removeAll()
      for draft in drafts {
        let text = UILabel()
        text.text = draft.text.isEmpty ? String(localized: "native.chat.row.queuedAttachmentsOnly", bundle: .lody) : draft.text
        text.font = .dynamic(of: 15)
        text.textColor = draft.text.isEmpty ? .tertiaryLabel : .secondaryLabel
        text.accessibilityIdentifier = draft.id + ":queued"
        text.accessibilityLabel = ([String(localized: "native.chat.row.queued", bundle: .lody) + ": " + draft.text] + draft.attachments)
          .filter { !$0.isEmpty }.joined(separator: ", ")
        let body = UIStackView(arrangedSubviews: [text])
        body.axis = .vertical
        body.spacing = 2
        if !draft.attachments.isEmpty { body.addArrangedSubview(Self.caption(draft.attachments)) }
        let button = UIButton(type: .system)
        button.configuration = .plain()
        button.setImage(
          UIImage(systemName: "arrow.up.circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .medium)),
          for: .normal
        )
        button.accessibilityIdentifier = draft.id + ":steer"
        button.accessibilityLabel = String(localized: "native.chat.composer.steer", bundle: .lody) + ": " + draft.text
        button.addAction(UIAction { [weak self] _ in self?.onSteer?(draft.id) }, for: .touchUpInside)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [body, button])
        row.alignment = .center
        row.spacing = 8
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = .init(top: 4, leading: 16, bottom: 4, trailing: 2)
        if !stack.arrangedSubviews.isEmpty {
          let separator = UIView()
          separator.backgroundColor = .separator
          separator.translatesAutoresizingMaskIntoConstraints = false
          row.addSubview(separator)
          NSLayoutConstraint.activate([
            separator.topAnchor.constraint(equalTo: row.topAnchor),
            separator.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
            separator.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
          ])
        }
        stack.addArrangedSubview(row)
        row.heightAnchor.constraint(equalToConstant: ChatQueuedDraft.rowHeight(draft)).isActive = true
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        button.widthAnchor.constraint(equalToConstant: 44).isActive = true
        buttons[draft.id] = button
        rows[draft.id] = row
      }
    }
    let first = drafts.first(where: \.canSteer)?.id
    for draft in drafts {
      let waiting = steeringID == draft.id || !draft.canSteer
      buttons[draft.id]?.isEnabled = enabled && draft.canSteer && (!firstOnly || draft.id == first)
      buttons[draft.id]?.accessibilityHint = waiting ? String(localized: "native.chat.composer.steering", bundle: .lody) : nil
    }
    if !drafts.isEmpty { panelHeight = ChatQueuedDraft.panelHeight(drafts) }
    setVisible(!drafts.isEmpty)
  }

  private static func caption(_ attachments: [String]) -> UIView {
    let clip = UIImageView(image: UIImage(systemName: "paperclip", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .regular)))
    clip.tintColor = .tertiaryLabel
    clip.setContentHuggingPriority(.required, for: .horizontal)
    let names = UILabel()
    names.text = attachments.joined(separator: " · ")
    names.font = .dynamic(of: 12)
    names.textColor = .tertiaryLabel
    names.lineBreakMode = .byTruncatingMiddle
    let line = UIStackView(arrangedSubviews: [clip, names])
    line.alignment = .center
    line.spacing = 4
    return line
  }
}

struct ComposerPaste {
  let trial: RichPaste.Trial
  let plainText: String?

  var fileName: String { trial.source == .plain ? ChatAttachment.pastedTextName : "Text.md" }
  var fileText: String { trial.source == .plain ? plainText ?? trial.markdown : trial.markdown }
}

// The editor is only touched on the main actor; the trial runs on a headless peer.
private final class ComposerPasteJob: @unchecked Sendable {
  let editor: Editor
  let providers: [NSItemProvider]

  init(editor: Editor, providers: [NSItemProvider]) {
    self.editor = editor
    self.providers = providers
  }
}

final class ChatComposerInput: TextView {
  var onPasteItems: (([NSItemProvider]) -> Bool)?
  var onPasteLongText: ((ComposerPaste) -> Bool)?

  static func makeEditorView() -> LexicalView {
    let theme = Theme()
    theme.root = [.font: UIFont.dynamic(of: 17), .foregroundColor: UIColor.label]
    theme.code = [
      .paddingHead: 8.0, .paddingTail: -8.0,
      .codeBlockCustomDrawing: CodeBlockCustomDrawingAttributes(background: .secondarySystemFill, border: .separator, borderWidth: 0.5),
    ]
    theme.quote = [
      .paddingHead: 12.0,
      .quoteCustomDrawing: QuoteCustomDrawingAttributes(barColor: .separator, barWidth: 3, rounded: true, barInsets: .zero),
    ]
    setContentFonts(of: theme, body: UIFont.dynamic(of: 17))
    let history = EditorHistoryPlugin()
    let config = EditorConfig(theme: theme, plugins: [ListPlugin(), LinkPlugin(), MarkdownShortcutPlugin(), history])
    let view = LexicalView(editorConfig: config, featureFlags: FeatureFlags(), textViewType: ChatComposerInput.self)
    try? view.editor.registerNode(nodeType: .lodyReference, class: ChatReferenceNode.self)
    (view.textView as? ChatComposerInput)?.history = history
    return view
  }

  // Matches ChatMarkdownTheme's title font, which the transcript uses for every heading level.
  private static func setContentFonts(of theme: Theme, body: UIFont) {
    let code = UIFont.monospacedSystemFont(ofSize: body.pointSize, weight: .regular)
    theme.setValue(.text, forSubtype: TextNodeThemeSubtype.code, value: [.font: code, .backgroundColor: UIColor.tertiarySystemFill])
    theme.code?[.font] = code
    let font = UIFont.systemFont(ofSize: body.pointSize * 20 / 17, weight: .semibold)
    for tag in ["h1", "h2", "h3", "h4", "h5", "h6"] {
      theme.setValue(.heading, forSubtype: tag, value: [.font: font])
    }
  }

  private var history: EditorHistoryPlugin? {
    didSet {
      guard let undoManager = history?.undoManager else { return }
      for name in [Notification.Name.NSUndoManagerDidUndoChange, .NSUndoManagerDidRedoChange] {
        NotificationCenter.default.addObserver(self, selector: #selector(historyDidChange), name: name, object: undoManager)
      }
    }
  }

  override var undoManager: UndoManager? {
    history?.undoManager ?? super.undoManager
  }

  @objc private func historyDidChange() {
    delegate?.textViewDidChange?(self)
  }

  override var font: UIFont? {
    didSet {
      guard let font, (editor.getTheme().root?[.font] as? UIFont) != font else { return }
      editor.getTheme().root?[.font] = font
      Self.setContentFonts(of: editor.getTheme(), body: font)
      try? editor.update { editor.dirtyType = .fullReconcile }
    }
  }

  /// A reference chip's label to the token the agent receives, for chips that show something
  /// friendlier than their token (an Agent Role reads "🧪 Reviewer" but sends `@role:<id>`).
  private(set) var labelledReferences: [String: String] = [:]

  /// The text sent: each labelled chip's token restored in place, chip by chip in order.
  var markdown: String {
    let legacy = labelledReferences
    let exporter = MarkdownExporter(transformers: [.textMatch { node, _, _ in
      guard let reference = node as? ChatReferenceNode else { return nil }
      return reference.referenceToken ?? legacy[reference.getTextContent()] ?? reference.getTextContent()
    }] + MarkdownExporter.gfm.transformers, escapesText: false, preservesNewlines: true)
    return (try? exporter.export(editor)) ?? (text ?? "")
  }

  /// The labels of the chips in the editor, in document order.
  private var referenceLabels: [String] {
    var labels: [String] = []
    try? editor.read {
      func collect(_ node: Node) {
        if let reference = node as? ChatReferenceNode { labels.append(reference.getTextContent()) }
        (node as? ElementNode)?.getChildren().forEach(collect)
      }
      getRoot().map(collect)
    }
    return labels
  }

  func hydrateReferences(_ items: [ChatMentionItem]) {
    let labels = Dictionary(items.filter { $0.kind == "session" || $0.kind == "role" }.map { item in
      (item.insertText ?? "@" + item.path, item.kind == "session" ? "@" + item.name : ChatRoleLabel(emoji: item.emoji ?? "🪼", name: item.name).text)
    }, uniquingKeysWith: { first, _ in first })
    var needsUpdate = false
    try? editor.read {
      func inspect(_ node: Node) {
        if let reference = node as? ChatReferenceNode {
          let token = reference.referenceToken ?? labelledReferences[reference.getTextContent()] ?? reference.getTextContent()
          if let label = labels[token], label != reference.getTextContent() { needsUpdate = true }
        }
        (node as? ElementNode)?.getChildren().forEach(inspect)
      }
      getRoot().map(inspect)
    }
    guard needsUpdate else { return }
    try? editor.update {
      func visit(_ node: Node) throws {
        if let reference = node as? ChatReferenceNode {
          let token = reference.referenceToken ?? labelledReferences[reference.getTextContent()] ?? reference.getTextContent()
          if let label = labels[token], label != reference.getTextContent() {
            let writable: ChatReferenceNode = try reference.getWritable()
            writable.referenceToken = token
            try writable.setText(label)
          }
        }
        for child in (node as? ElementNode)?.getChildren() ?? [] { try visit(child) }
      }
      if let root = getRoot() { try visit(root) }
    }
  }

  var serializedState: String? {
    text.isEmpty ? nil : try? editor.getEditorState().toJSON()
  }

  // Drafts persist the editor state; anything else is plain text from an older build.
  var draftEnvelope: String {
    guard let state = serializedState, let json = try? JSONSerialization.jsonObject(with: Data(state.utf8)) else { return text ?? "" }
    var envelope: [String: Any] = ["v": 1, "lexical": json]
    // Labelled chips keep their tokens across restores.
    if !labelledReferences.isEmpty { envelope["references"] = labelledReferences }
    guard let data = try? JSONSerialization.data(withJSONObject: envelope), let value = String(data: data, encoding: .utf8) else { return text ?? "" }
    return value
  }

  func restoreDraft(_ stored: String) {
    if let data = stored.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      object["v"] as? Int == 1, let lexical = object["lexical"], let state = try? JSONSerialization.data(withJSONObject: lexical),
      let json = String(data: state, encoding: .utf8), restore(state: json) {
      labelledReferences = (object["references"] as? [String: String]) ?? [:]
      return
    }
    text = stored
  }

  @discardableResult
  func restore(state json: String) -> Bool {
    guard let state = try? EditorState.fromJSON(json: json, editor: editor), (try? editor.setEditorState(state)) != nil else { return false }
    try? editor.update { _ = try getRoot()?.selectEnd() }
    return true
  }

  func appendParagraphs(_ value: String) {
    guard !text.isEmpty else {
      text = value
      return
    }
    try? editor.update {
      guard let root = getRoot() else { return }
      var last: ParagraphNode?
      for line in [""] + value.components(separatedBy: "\n") {
        let paragraph = createParagraphNode()
        if !line.isEmpty { try paragraph.append([createTextNode(text: line)]) }
        try root.append([paragraph])
        last = paragraph
      }
      _ = try last?.selectEnd()
    }
  }

  /// Inserts a reference chip over `range`. With a `label` the chip shows it and sends `token`.
  func insertReference(_ token: String, label: String? = nil, replacing range: NSRange) {
    insertSegments([ChatComposerSegment(text: label ?? token, token: label == nil ? nil : token, reference: true)], replacing: range)
  }

  /// Inserts text and reference chips over `range` (a prompt shortcut's body, with its references
  /// as chips), then a space.
  func insertSegments(_ segments: [ChatComposerSegment], replacing range: NSRange) {
    selectedRange = range
    for segment in segments where segment.reference {
      if let token = segment.token, token != segment.text { labelledReferences[segment.text] = token }
    }
    try? editor.update {
      guard let selection = try getSelection() as? RangeSelection else { return }
      var nodes: [Node] = []
      for segment in segments where !segment.text.isEmpty {
        if segment.reference {
          let node = ChatReferenceNode(text: segment.text, key: nil)
          node.referenceToken = segment.token ?? segment.text
          nodes.append(node)
          continue
        }
        // A body's newlines become line breaks.
        let lines = segment.text.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
          if index > 0 { nodes.append(createLineBreakNode()) }
          if !line.isEmpty { nodes.append(createTextNode(text: line)) }
        }
      }
      nodes.append(createTextNode(text: " "))
      _ = try selection.insertNodes(nodes: nodes, selectStart: false)
    }
    delegate?.textViewDidChange?(self)
  }

  var referenceTokens: [String] {
    var tokens: [String] = []
    try? editor.read {
      func collect(_ node: Node) {
        if let reference = node as? ChatReferenceNode { tokens.append(reference.getTextContent()) }
        (node as? ElementNode)?.getChildren().forEach(collect)
      }
      getRoot().map(collect)
    }
    return tokens
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(pastePlainText(_:)) { return isEditable && UIPasteboard.general.hasStrings }
    if action == #selector(paste(_:)), isEditable, UIPasteboard.general.numberOfItems > 0 { return true }
    return super.canPerformAction(action, withSender: sender)
  }

  override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
    ChatAttachment.canPaste(itemProviders) || super.canPaste(itemProviders)
  }

  override func paste(itemProviders: [NSItemProvider]) {
    pasteContent(itemProviders, plainTextOnly: false)
  }

  override func paste(_ sender: Any?) {
    pasteContent(UIPasteboard.general.itemProviders, plainTextOnly: false)
  }

  @objc func pastePlainText(_ sender: Any?) {
    pastePlainText(from: UIPasteboard.general.itemProviders)
  }

  func pastePlainText(from providers: [NSItemProvider]) {
    pasteContent(providers, plainTextOnly: true)
  }

  private func pasteContent(_ providers: [NSItemProvider], plainTextOnly: Bool) {
    guard isEditable else { return }
    if !plainTextOnly, onPasteItems?(providers) == true { return }
    unmarkText()
    let job = ComposerPasteJob(editor: editor, providers: providers)
    let plain = plainTextOnly || ((try? RichPaste.gfm.prefersPlainText(in: editor)) ?? false)
    Task { @MainActor [weak self] in
      let sources = await PasteboardReader.sources(job.providers, plainTextOnly: plain)
      let trial = await Task.detached { try? RichPaste.gfm.trial(sources, for: job.editor) }.value
      guard let self, self.isEditable else { return }
      guard let trial else {
        if !plainTextOnly && sources.isEmpty { self.pasteProviders(providers) }
        return
      }
      let paste = ComposerPaste(trial: trial, plainText: sources.first { $0.kind == .plain }?.text)
      if !plainTextOnly, ChatAttachment.shouldPromotePastedText(trial.markdown), self.onPasteLongText?(paste) == true { return }
      self.insertPaste(paste)
    }
  }

  @discardableResult
  func insertPaste(_ paste: ComposerPaste, at location: Int? = nil) -> Bool {
    if let location { selectedRange = NSRange(location: min(location, (text as NSString).length), length: 0) }
    guard delegate?.textView?(self, shouldChangeTextIn: selectedRange, replacementText: paste.trial.markdown) != false,
      (try? RichPaste.gfm.insert(paste.trial, into: editor)) != nil
    else { return false }
    delegate?.textViewDidChange?(self)
    return true
  }

  private func pasteProviders(_ providers: [NSItemProvider]) {
    super.paste(itemProviders: providers)
  }
}

private final class ChatComposerProgressView: UIView {
  private let arc = CAShapeLayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "session-action-progress"
    isUserInteractionEnabled = false
    arc.fillColor = UIColor.clear.cgColor
    arc.strokeColor = UIColor.white.cgColor
    arc.lineCap = .round
    arc.lineWidth = 2.25
    layer.addSublayer(arc)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    arc.frame = bounds
    let inset = arc.lineWidth / 2
    arc.path = UIBezierPath(
      arcCenter: CGPoint(x: bounds.midX, y: bounds.midY),
      radius: max(0, min(bounds.width, bounds.height) / 2 - inset),
      startAngle: -.pi / 2,
      endAngle: .pi,
      clockwise: true
    ).cgPath
  }

  func startAnimating() {
    isHidden = false
    guard layer.animation(forKey: "composer.loading.rotation") == nil else { return }
    let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
    rotation.fromValue = 0
    rotation.toValue = CGFloat.pi * 2
    rotation.duration = 0.8
    rotation.repeatCount = .infinity
    rotation.timingFunction = CAMediaTimingFunction(name: .linear)
    layer.add(rotation, forKey: "composer.loading.rotation")
  }

  func stopAnimating() {
    isHidden = true
    layer.removeAnimation(forKey: "composer.loading.rotation")
  }
}

private enum ChatComposerActionMode {
  case send
  case loading
  case stop

  var color: UIColor {
    switch self {
    case .send: LodyAccent.color
    case .loading: .systemGray
    case .stop: LodyAccent.color
    }
  }

  var symbolName: String {
    switch self {
    case .send, .loading: "arrow.up"
    case .stop: "stop.fill"
    }
  }
}

private final class ChatComposerActionVisual: UIView {
  private let content = UIView()
  private let symbol = UIImageView()
  private let progress = ChatComposerProgressView()
  private var mode: ChatComposerActionMode?

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "session-action-visual"
    isUserInteractionEnabled = false
    layer.cornerCurve = .continuous
    content.accessibilityIdentifier = "session-action-content"
    content.isUserInteractionEnabled = false
    symbol.contentMode = .center
    symbol.tintColor = .white
    addSubview(content)
    content.addSubview(symbol)
    content.addSubview(progress)
    content.translatesAutoresizingMaskIntoConstraints = false
    symbol.translatesAutoresizingMaskIntoConstraints = false
    progress.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      content.topAnchor.constraint(equalTo: topAnchor),
      content.bottomAnchor.constraint(equalTo: bottomAnchor),
      content.leadingAnchor.constraint(equalTo: leadingAnchor),
      content.trailingAnchor.constraint(equalTo: trailingAnchor),
      symbol.topAnchor.constraint(equalTo: content.topAnchor),
      symbol.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      symbol.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      symbol.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      progress.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      progress.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      progress.widthAnchor.constraint(equalToConstant: 15),
      progress.heightAnchor.constraint(equalToConstant: 15),
    ])
    render(.send)
    NotificationCenter.default.addObserver(self, selector: #selector(refreshAccent), name: .lodyAppearanceDidChange, object: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
  }

  @objc private func refreshAccent() {
    backgroundColor = mode?.color
    symbol.tintColor = mode == .loading ? .white : LodyAccent.foregroundColor
  }

  func render(_ nextMode: ChatComposerActionMode) {
    guard mode != nextMode else { return }
    let shouldAnimate = mode != nil && window != nil
    mode = nextMode
    symbol.tintColor = nextMode == .loading ? .white : LodyAccent.foregroundColor
    guard shouldAnimate else {
      backgroundColor = nextMode.color
      applyContent(nextMode)
      return
    }

    let duration = UIAccessibility.isReduceMotionEnabled ? 0.18 : 0.2
    UIView.transition(
      with: content,
      duration: duration,
      options: [.transitionCrossDissolve, .beginFromCurrentState, .allowAnimatedContent]
    ) {
      self.applyContent(nextMode)
    }
    UIView.animate(
      withDuration: duration,
      delay: 0,
      options: [.beginFromCurrentState, .curveEaseInOut]
    ) {
      self.backgroundColor = nextMode.color
    }
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    UIView.animateKeyframes(
      withDuration: duration,
      delay: 0,
      options: [.beginFromCurrentState, .calculationModeCubic]
    ) {
      UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.45) {
        self.content.transform = CGAffineTransform(scaleX: 0.72, y: 0.72)
      }
      UIView.addKeyframe(withRelativeStartTime: 0.45, relativeDuration: 0.55) {
        self.content.transform = .identity
      }
    }
  }

  private func applyContent(_ mode: ChatComposerActionMode) {
    symbol.image = UIImage(
      systemName: mode.symbolName,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold, scale: .medium)
    )
    symbol.isHidden = mode == .loading
    if mode == .loading { progress.startAnimating() } else { progress.stopAnimating() }
  }
}

final class ChatComposerView: UIView, UITextViewDelegate {
  private let composer = UIVisualEffectView(effect: nil)
  private let inputSurface = UIVisualEffectView(effect: nil)
  private let editorView = ChatComposerInput.makeEditorView()
  private lazy var input = editorView.textView as! ChatComposerInput
  private let hint = UILabel()
  private let notice = UIButton(type: .system)
  private let quotaNotice = UILabel()
  private let send = UIButton(type: .system)
  private let sendVisual = ChatComposerActionVisual()
  private let sendFeedback = UIImpactFeedbackGenerator(style: .medium)
  #if !LODY_SHARE_EXTENSION
  private let attachmentOverlay = AnchoredOverlayController()
  private lazy var attachmentPages = OverlayPages(controller: attachmentOverlay, transitionStyle: .blurredCrossfade)
  #endif
  private enum AttachmentPage { case photos, camera }
  private let attach = UIButton(type: .system)
  private var attachLeading: NSLayoutConstraint!
  private let sheetContent = UILayoutGuide()
  private var sheetContentBottom: NSLayoutConstraint!
  private let accessoryBar = UIView()
  private let modelButton = UIButton(type: .system)
  /// The collapsed one-line composer's run-config affordance: the agent mark beside
  /// Send. Tapping it opens the composer and then its model panel.
  private let collapsedMark = UIButton(type: .system)
  private let usageButton = UIButton(type: .system)
  private var usageWidth: NSLayoutConstraint!
#if !LODY_SHARE_EXTENSION
  private weak var usagePanel: ChatUsagePanel?
  var usageNow: () -> Date = Date.init
#endif
  private var movingAgentMark: UIImageView?
  private weak var optionsPopover: ChatComposerModelPanel?
  private let attachmentBar = ChatAttachmentBar()
  private let attachmentStack = ChatComposerAttachmentStack()
  private var attachments: [ChatAttachment] = []
  private let filePicker = ChatAttachmentPicker()
  private let libraryPicker = ChatPhotoLibraryPicker()
  private var inputHeight: NSLayoutConstraint!
  private var accessoryHeight: NSLayoutConstraint!
  private var hintLeading: NSLayoutConstraint!
  private var hintTop: NSLayoutConstraint!
  private var noticeHeight: NSLayoutConstraint!
  private var quotaNoticeHeight: NSLayoutConstraint!
  private var quotaGap: NSLayoutConstraint!
  private var attachmentHeight: NSLayoutConstraint!
  private var attachmentTop: NSLayoutConstraint!
  /// Docked between the prompt and the keyboard (Notion-style); the prompt rises above it.
  private let mentionPanel = ChatMentionPanel(frame: .zero)
  private var separateMentionItems: [ChatMentionItem]?
  private var usesSeparateMentionItems = false
  private var activeMentionItems: [ChatMentionItem]? { usesSeparateMentionItems ? separateMentionItems : state.mentionItems }
  func setMentionItems(_ json: String) {
    usesSeparateMentionItems = true
    separateMentionItems = try? JSONDecoder().decode([ChatMentionItem].self, from: Data(json.utf8))
    updateComposer()
  }
  private let mentionButton = UIButton(type: .system)
  private let permissionButton = UIButton(type: .system)
  /// Web's mobile composer order after +: @, the run-config chip (assistant mark, model ·
  /// effort, fast), the permission shield. A stack, so hidden controls close their gap.
  private let controls = UIStackView()
  private var mentionHeight: NSLayoutConstraint!
  private let queueView = ChatQueueView()
  private var queueHeight: NSLayoutConstraint!
  private var queueGap: NSLayoutConstraint!
  private let actionBar = ChatActionBarView(frame: .zero)
  var primaryActionAnchor: (view: UIView, rect: CGRect) {
    (actionBar, actionBar.primaryFrame.isEmpty ? CGRect(x: actionBar.bounds.maxX - ChatActionBarView.rowHeight, y: 0, width: ChatActionBarView.rowHeight, height: ChatActionBarView.rowHeight) : actionBar.primaryFrame)
  }
  private var actionBarHeight: NSLayoutConstraint!
  private var queuedDrafts: [ChatQueuedDraft] = []
  var retiringQueueHeight: CGFloat { queuedDrafts.isEmpty ? queueView.panelHeight + queueGap.constant : 0 }
  private var state = ChatComposerState()
  private var composerOptions = ChatComposerOptions()
  private var composerExpanded = false
  var allowsFullScreen = false { didSet { updateComposer() } }
  private var fullScreen = false
  private let grabber = ChatComposerGrabber(frame: .zero)
  private var grabberHeight: NSLayoutConstraint!
  private var dragProgress: CGFloat?
  private var dragStart: CGFloat = 0
  private var dragDistance: CGFloat = 1
  private lazy var formatBar = ChatComposerFormatBar(editor: input.editor)
  private var formatHeight: NSLayoutConstraint!
  private let fullScreenDim = UIView()
  private var pendingDraft: (text: String, attachments: [ChatAttachment], state: String?)?
  private var sentStates: [String: String] = [:]
  var sendHandoff = true
  /// A pushed creation host keeps its keyboard edge until the destination replaces it.
  var dismissesKeyboardOnSend = true
  var autoFocus = false
  private var lastRestoreToken = 0
  private var hasInitialDraft = false
  private var hasInitialAttachments = false
  private var lastClearToken = 0
  var onSend: (([String: Any]) -> Void)?
  var prepareSend: (([String: Any]) -> Bool)?
  var relaying = false
  var previewBeforeSubmit: (() -> Bool)?
  var onStop: (() -> Void)?
  var onSteer: ((String) -> Void)?
  var guidesSubmission: Bool {
    state.queuedMessageBehavior == "guide" && state.running == true && state.steerInterrupts != true
  }
  var queuesSubmission: Bool {
    !guidesSubmission && (state.running == true || !queuedDrafts.isEmpty)
  }
  var onReconnect: (() -> Void)?
  var onPreview: ((String) -> Void)?
  var onMentionBrowse: (([String: String]) -> Void)?
  private var mentionResultID = ""
  private var mentionNeedsFocus = false
  var onComposerOptionChange: (([String: Any]) -> Void)?
  var onDraftChange: ((String) -> Void)?
  var onHeightChange: ((CGFloat) -> Void)?
  var displayError: String? { didSet { updateComposer() } }
  private var measuredWidth: CGFloat = 0
  /// Web's mobile composer card instead of the glass pill / keyboard sheet: always shows its
  /// controls row (+, the run-config chip, Send) and has no @ button. Set by the new-session page
  /// and the conversation.
  /// Card style: the run-config chip opens the host's sheet instead of the model popover.
  var onRunConfig: (() -> Void)?
  private var cardFocused = false
  var cardStyle = false {
    didSet {
      guard cardStyle != oldValue else { return }
      (surfaceLayout as? ChatComposerLiquidGlassSurfaceLayout)?.setCard(cardStyle)
      updateComposer()
    }
  }
  /// The conversation's card rests as one line — +, the prompt, the agent mark ⌄ and Send — and
  /// opens into the card (prompt over +, the run-config chip and Send) while editing.
  var restsCollapsed = false {
    didSet { if restsCollapsed != oldValue { updateComposer() } }
  }
  /// The card is open: always on the new-chat page; in a conversation while editing, and at
  /// rest while a typed draft remains, so the prompt keeps showing its lines.
  private var cardOpen: Bool { cardStyle && (!restsCollapsed || input.isFirstResponder || hasDraftText) }
  private var hasDraftText: Bool { !input.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private lazy var surfaceLayout: any ChatComposerSurfaceLayout = ChatComposerLiquidGlassSurfaceLayout(
    container: composer,
    inputSurface: inputSurface
  )

  func setInputIdentifier(_ id: String) { input.accessibilityIdentifier = id }

  func adoptConfiguration(from other: ChatComposerView) {
    state = other.state
    composerOptions = other.composerOptions
    separateMentionItems = other.separateMentionItems
    usesSeparateMentionItems = other.usesSeparateMentionItems
    queuedDrafts = other.queuedDrafts
    lastRestoreToken = other.lastRestoreToken
    lastClearToken = other.lastClearToken
    hasInitialDraft = true
    hasInitialAttachments = true
    updateComposerOptions()
    updateComposer()
  }

  var relayInputState: [String: Any] {
    ["focused": input.isFirstResponder, "selection": [input.selectedRange.location, input.selectedRange.length],
     "appearance": traitCollection.userInterfaceStyle.rawValue]
  }

  func attachScrollEdge(to scrollView: UIScrollView?) {
    if let scrollView { LodyScrollEdges.floatingControls(scrollView) }
    let existing = interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }.first
    guard scrollView != nil || existing != nil else { return }
    let edge = existing ?? UIScrollEdgeElementContainerInteraction()
    edge.scrollView = scrollView
    edge.edge = .bottom
    if edge.view == nil { addInteraction(edge) }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    if abs(input.bounds.width - measuredWidth) > 0.5 {
      measuredWidth = input.bounds.width
      updateComposer()
    }
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    // The agent mark in the model chip is drawn in resolved ink.
    if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection), composerOptions.agentAsset != nil {
      updateComposerOptions()
    }
    guard previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory else { return }
    input.font = .dynamic(of: 17, compatibleWith: traitCollection)
    hint.font = input.font
    notice.titleLabel?.font = .dynamic(of: 13, compatibleWith: traitCollection)
    quotaNotice.font = .dynamic(of: 13, compatibleWith: traitCollection)
    updateComposer()
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    composer.backgroundColor = .clear
    input.backgroundColor = .clear
    input.font = .dynamic(of: 17)
    input.textColor = .label
    input.textContainerInset = UIEdgeInsets(top: 13, left: 16, bottom: 13, right: 46)
    input.delegate = self
    input.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.item.identifier])
    input.onPasteItems = { [weak self] providers in
      guard let self, self.state.editable else { return false }
      return ChatAttachment.paste(providers) { [weak self] in self?.addAttachments($0) }
    }
    input.onPasteLongText = { [weak self] paste in
      self?.pasteLongText(paste) ?? false
    }
    input.accessibilityIdentifier = "session-input"
    input.accessibilityLabel = String(localized: "native.chat.composer.input", bundle: .lody)
    hint.text = state.placeholder
    hint.font = input.font
    hint.textColor = .placeholderText
    hint.isUserInteractionEnabled = false
    hint.isAccessibilityElement = false
    send.tintColor = .lodyAccent
    sendVisual.translatesAutoresizingMaskIntoConstraints = false
    send.addSubview(sendVisual)
    NSLayoutConstraint.activate([
      sendVisual.centerXAnchor.constraint(equalTo: send.centerXAnchor),
      sendVisual.centerYAnchor.constraint(equalTo: send.centerYAnchor),
      sendVisual.widthAnchor.constraint(equalToConstant: 30),
      sendVisual.heightAnchor.constraint(equalToConstant: 30),
    ])
    send.accessibilityLabel = String(localized: "native.chat.composer.send", bundle: .lody)
    send.accessibilityIdentifier = "session-send"
    send.addTarget(self, action: #selector(submit), for: .touchUpInside)
    NotificationCenter.default.addObserver(self, selector: #selector(appDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    attach.setImage(UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular)), for: .normal)
    attach.configuration = .plain()
    attach.configuration?.cornerStyle = .capsule
    attach.tintColor = .label
    attach.accessibilityLabel = String(localized: "native.chat.composer.attach", bundle: .lody)
    attach.accessibilityIdentifier = "session-attach"
#if LODY_SHARE_EXTENSION
    attach.showsMenuAsPrimaryAction = true
    attach.menu = UIMenu(children: [
      UIAction(title: String(localized: "native.chat.composer.takePhoto", bundle: .lody), image: UIImage(systemName: "camera")) { [weak self] _ in
        self?.presentAttachmentCamera()
      },
      UIAction(title: String(localized: "native.chat.composer.recentPhotos", bundle: .lody), image: UIImage(systemName: "photo")) { [weak self] _ in self?.presentRecentPhotos() },
      UIAction(title: String(localized: "native.chat.composer.photoLibrary", bundle: .lody), image: UIImage(systemName: "photo.on.rectangle.angled")) { [weak self] _ in
        guard let self, let controller = self.presenter() else { return }
        self.libraryPicker.present(from: controller)
      },
      UIAction(title: String(localized: "native.chat.composer.files", bundle: .lody), image: UIImage(systemName: "folder")) { [weak self] _ in
        guard let self, let controller = self.presenter() else { return }
        self.filePicker.files(from: controller)
      },
    ])
#else
    attachmentOverlay.anchorTransition = .fade
    attach.addTarget(self, action: #selector(presentAttachments), for: .touchUpInside)
#endif
    modelButton.accessibilityIdentifier = "session-model"
    modelButton.addTarget(self, action: #selector(presentComposerOptions), for: .touchUpInside)
    collapsedMark.accessibilityIdentifier = "session-model-collapsed"
    collapsedMark.addTarget(self, action: #selector(openFromCollapsedMark), for: .touchUpInside)
    modelButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    filePicker.onPick = { [weak self] picked in self?.addAttachments(picked) }
    libraryPicker.onPick = { [weak self] picked in self?.addAttachments(picked) }
    attachmentBar.onPreview = { [weak self] id in
      guard let self, let index = self.attachments.firstIndex(where: { $0.id == id }), let controller = self.presenter() else { return }
      controller.present(ChatAttachmentPreview(self.attachments, index: index), animated: true)
    }
    attachmentBar.onRemove = { [weak self] id in
      guard let self else { return }
      self.attachments.removeAll { $0.id == id }
      self.attachmentBar.render(self.attachments, animatedRemoval: true)
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      self.updateComposer()
    }
    notice.titleLabel?.font = .dynamic(of: 13)
    notice.titleLabel?.numberOfLines = 0
    notice.addTarget(self, action: #selector(reconnect), for: .touchUpInside)
    quotaNotice.font = .dynamic(of: 13)
    quotaNotice.textColor = .secondaryLabel
    quotaNotice.numberOfLines = 0
    quotaNotice.accessibilityIdentifier = "session-free-turn-notice"
    mentionButton.setImage(UIImage(systemName: "at", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular)), for: .normal)
    mentionButton.tintColor = .label
    mentionButton.accessibilityLabel = String(localized: "native.chat.mention.open", bundle: .lody)
    mentionButton.accessibilityIdentifier = "session-mention"
    mentionButton.addTarget(self, action: #selector(openMentions), for: .touchUpInside)
    permissionButton.setImage(UIImage(systemName: "shield.lefthalf.filled", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .regular)), for: .normal)
    permissionButton.tintColor = .label
    permissionButton.accessibilityLabel = String(localized: "model.tab.permission", bundle: .lody)
    permissionButton.accessibilityIdentifier = "session-permission"
    permissionButton.showsMenuAsPrimaryAction = true
    grabber.onToggle = { [weak self] in self?.toggleFullScreen() }
    grabber.onPan = { [weak self] in self?.dragGrabber($0) }
    formatBar.clipsToBounds = true
    formatBar.onChange = { [weak self] in self?.updateComposer() }
    fullScreenDim.backgroundColor = UIColor.black.withAlphaComponent(0.22)
    fullScreenDim.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    fullScreenDim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleFullScreen)))
    mentionPanel.onChange = { [weak self] in self?.updateComposer() }
    attachmentBar.onHeightChange = { [weak self] in self?.updateComposer() }
    queueView.onHeightChange = { [weak self] in self?.updateComposer() }
    mentionPanel.onBrowse = { [weak self] in self?.onMentionBrowse?($0) }
    #if !LODY_SHARE_EXTENSION
    // Choosing a prompt shortcut writes its body (web); the Share Extension has no runtime.
    mentionPanel.loadShortcut = { id in try await PromptShortcutsController.body(id: id) }
    #endif
    addSubview(composer)
    composer.contentView.addSubview(queueView)
    queueView.onSteer = { [weak self] in self?.onSteer?($0) }
    // Its own glass panel: it must not also contribute to the composer's merged glass.
    addSubview(actionBar)
    actionBar.onAction = { [weak self] in self?.onPreview?("bar:" + $0) }
    composer.contentView.addSubview(notice)
    composer.contentView.addSubview(quotaNotice)
    composer.contentView.addSubview(inputSurface)
    inputSurface.contentView.addLayoutGuide(sheetContent)
    sheetContentBottom = sheetContent.bottomAnchor.constraint(equalTo: inputSurface.contentView.bottomAnchor)
    NSLayoutConstraint.activate([
      sheetContent.topAnchor.constraint(equalTo: inputSurface.contentView.topAnchor),
      sheetContent.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor),
      sheetContent.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor),
      sheetContentBottom,
    ])
    controls.axis = .horizontal
    controls.alignment = .center
    controls.spacing = 0
    for view in [mentionButton, modelButton, permissionButton] { controls.addArrangedSubview(view) }
    // Above the composer's glass, on the keyboard: not part of the merged glass surface.
    addSubview(mentionPanel)
    for view in [attachmentBar, editorView, hint, formatBar, accessoryBar, attach, attachmentStack, controls, collapsedMark, usageButton, send, grabber] {
      inputSurface.contentView.addSubview(view)
    }
    for view in [composer, mentionPanel, mentionButton, permissionButton, queueView, actionBar, inputSurface, attachmentStack, notice, attachmentBar, quotaNotice, editorView, hint, formatBar, accessoryBar, send, attach, modelButton, controls, collapsedMark, usageButton, grabber] {
      view.translatesAutoresizingMaskIntoConstraints = false
    }
    usageWidth = usageButton.widthAnchor.constraint(equalToConstant: 0)
    usageWidth.isActive = true
    usageButton.isHidden = true
    usageButton.accessibilityIdentifier = "session-usage"
#if !LODY_SHARE_EXTENSION
    usageButton.addTarget(self, action: #selector(presentUsage), for: .touchUpInside)
#endif
    inputHeight = editorView.heightAnchor.constraint(equalToConstant: 48)
    accessoryHeight = accessoryBar.heightAnchor.constraint(equalToConstant: 0)
    formatHeight = formatBar.heightAnchor.constraint(equalToConstant: 0)
    hintLeading = hint.leadingAnchor.constraint(equalTo: editorView.leadingAnchor, constant: 21)
    hintTop = hint.topAnchor.constraint(equalTo: editorView.topAnchor, constant: 13)
    noticeHeight = notice.heightAnchor.constraint(equalToConstant: 0)
    quotaNoticeHeight = quotaNotice.heightAnchor.constraint(equalToConstant: 0)
    quotaGap = inputSurface.topAnchor.constraint(equalTo: quotaNotice.bottomAnchor)
    attachmentHeight = attachmentBar.heightAnchor.constraint(equalToConstant: 0)
    grabberHeight = grabber.heightAnchor.constraint(equalToConstant: 0)
    attachmentTop = attachmentBar.topAnchor.constraint(equalTo: grabber.bottomAnchor)
    queueHeight = queueView.heightAnchor.constraint(equalToConstant: 0)
    queueGap = queueView.topAnchor.constraint(equalTo: actionBar.bottomAnchor)
    actionBarHeight = actionBar.heightAnchor.constraint(equalToConstant: 0)
    mentionHeight = mentionPanel.heightAnchor.constraint(equalToConstant: 0)
    surfaceLayout.activate()
    NSLayoutConstraint.activate([
      composer.topAnchor.constraint(equalTo: topAnchor),
      composer.leadingAnchor.constraint(equalTo: leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: trailingAnchor),
      composer.bottomAnchor.constraint(equalTo: bottomAnchor),
      grabber.topAnchor.constraint(equalTo: inputSurface.contentView.topAnchor),
      grabber.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor),
      grabber.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor), grabberHeight,
      mentionPanel.leadingAnchor.constraint(equalTo: leadingAnchor),
      mentionPanel.trailingAnchor.constraint(equalTo: trailingAnchor),
      mentionPanel.bottomAnchor.constraint(equalTo: bottomAnchor), mentionHeight,
      queueView.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 16),
      queueView.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -16), queueHeight, queueGap,
      actionBar.topAnchor.constraint(equalTo: notice.bottomAnchor),
      actionBar.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 16),
      actionBar.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -16), actionBarHeight,
      notice.topAnchor.constraint(equalTo: composer.topAnchor), notice.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 20),
      notice.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -20), noticeHeight,
      attachmentTop,
      attachmentBar.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor, constant: 16),
      attachmentBar.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor, constant: -16), attachmentHeight,
      quotaNotice.topAnchor.constraint(equalTo: queueView.bottomAnchor),
      quotaNotice.leadingAnchor.constraint(equalTo: inputSurface.leadingAnchor, constant: 16),
      quotaNotice.trailingAnchor.constraint(equalTo: inputSurface.trailingAnchor, constant: -16), quotaNoticeHeight,
      quotaGap,
      attach.bottomAnchor.constraint(equalTo: sheetContent.bottomAnchor, constant: -2),
      attach.widthAnchor.constraint(equalToConstant: 44), attach.heightAnchor.constraint(equalToConstant: 44),
      attachmentStack.leadingAnchor.constraint(equalTo: attach.trailingAnchor),
      attachmentStack.centerYAnchor.constraint(equalTo: attach.centerYAnchor),
      editorView.topAnchor.constraint(equalTo: attachmentBar.bottomAnchor),
      editorView.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor),
      editorView.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor), inputHeight,
      formatBar.topAnchor.constraint(equalTo: editorView.bottomAnchor),
      formatBar.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor),
      formatBar.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor), formatHeight,
      accessoryBar.topAnchor.constraint(equalTo: formatBar.bottomAnchor),
      accessoryBar.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor),
      accessoryBar.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor),
      accessoryBar.bottomAnchor.constraint(equalTo: sheetContent.bottomAnchor), accessoryHeight,
      hintLeading, hintTop,
      hint.trailingAnchor.constraint(lessThanOrEqualTo: collapsedMark.leadingAnchor),
      send.trailingAnchor.constraint(equalTo: inputSurface.contentView.trailingAnchor, constant: -2),
      send.bottomAnchor.constraint(equalTo: sheetContent.bottomAnchor, constant: -2),
      send.widthAnchor.constraint(equalToConstant: 44), send.heightAnchor.constraint(equalToConstant: 44),
      controls.leadingAnchor.constraint(equalTo: attach.trailingAnchor),
      controls.centerYAnchor.constraint(equalTo: send.centerYAnchor),
      controls.trailingAnchor.constraint(lessThanOrEqualTo: usageButton.leadingAnchor, constant: -2),
      mentionButton.widthAnchor.constraint(equalToConstant: 44), mentionButton.heightAnchor.constraint(equalToConstant: 44),
      permissionButton.widthAnchor.constraint(equalToConstant: 44), permissionButton.heightAnchor.constraint(equalToConstant: 44),
      modelButton.heightAnchor.constraint(equalToConstant: 44),
      collapsedMark.trailingAnchor.constraint(equalTo: usageButton.leadingAnchor),
      usageButton.trailingAnchor.constraint(equalTo: send.leadingAnchor),
      usageButton.centerYAnchor.constraint(equalTo: send.centerYAnchor),
      usageButton.heightAnchor.constraint(equalToConstant: 44),
      collapsedMark.centerYAnchor.constraint(equalTo: send.centerYAnchor),
      collapsedMark.heightAnchor.constraint(equalToConstant: 44),
    ])
    attachLeading = attach.leadingAnchor.constraint(equalTo: inputSurface.contentView.leadingAnchor, constant: 2)
    attachLeading.isActive = true
    updateComposer()
  }

  func setInitialDraft(_ text: String) {
    guard !hasInitialDraft else { return }
    hasInitialDraft = true
    guard pendingDraft == nil else { return }
    input.text = text
    updateComposer()
  }
  private var lastAppendedDraftID = ""
  func appendDraft(_ json: String) {
    guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let id = value["id"], !id.isEmpty, id != lastAppendedDraftID,
          let text = value["text"], !text.isEmpty else { return }
    lastAppendedDraftID = id
    // Keep the user's existing text AND attachments. Sending remains explicit.
    input.appendParagraphs(text)
    updateComposer()
    saveDraft()
  }
  func setStoredDraft(_ text: String) {
    guard !text.isEmpty, input.text.isEmpty else { return }
    input.restoreDraft(text)
    updateComposer()
  }
  private func saveDraft() {
    onDraftChange?(input.draftEnvelope)
  }
  @objc private func appDidEnterBackground() {
    saveDraft()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      saveDraft()
      #if !LODY_SHARE_EXTENSION
      attachmentOverlay.cancel()
      #endif
      optionsPopover?.dismiss(animated: false)
    }
    else if mentionNeedsFocus || autoFocus {
      if autoFocus { input.selectedRange = NSRange(location: (input.text as NSString).length, length: 0) }
      autoFocus = false
      focusAfterMentionPicker()
    }
  }
  func setInitialAttachments(_ json: String) {
    guard !hasInitialAttachments else { return }
    struct DraftAttachment: Decodable {
      let id: String
      let name: String
      let uri: URL
      let kind: String
    }
    guard let drafts = try? JSONDecoder().decode([DraftAttachment].self, from: Data(json.utf8)),
      drafts.allSatisfy({ $0.uri.isFileURL && ($0.kind == "image" || $0.kind == "file") }) else { return }
    hasInitialAttachments = true
    guard pendingDraft == nil else { return }
    attachments = drafts.map { ChatAttachment(id: $0.id, name: $0.name, url: $0.uri, isImage: $0.kind == "image") }
    updateComposer()
  }
  func clearDraft(token: Int) {
    guard token > lastClearToken else { return }
    lastClearToken = token
    guard pendingDraft != nil else { return }
    acknowledgedSendID = pendingSendID
    pendingSendID.map { sentStates[$0] = nil }
    pendingDraft = nil
    pendingSendID = nil
    updateComposer()
    saveDraft()
  }
  func clearPendingSend(id: String) {
    guard pendingSendID == id else { return }
    acknowledgedSendID = id
    sentStates[id] = nil
    pendingDraft = nil
    pendingSendID = nil
    updateComposer()
    saveDraft()
  }
  func restoreDraft(token: Int) {
    guard token > lastRestoreToken else { return }
    lastRestoreToken = token
    let id = pendingSendID ?? UUID().uuidString.lowercased()
    ChatSendHandoff.cancel(id: id)
    pendingSendID = nil
    if let draft = pendingDraft {
      if !sendHandoff || ((input.text ?? "").isEmpty && attachments.isEmpty) {
        if draft.state.map({ input.restore(state: $0) }) != true { input.text = draft.text }
        attachments = draft.attachments
      } else {
        failedDraft = ChatPendingSend(id: id, text: draft.text, attachments: draft.attachments.map { item in
          ChatPendingSend.Attachment(id: item.id, name: item.name, uri: item.url.absoluteString, kind: item.isImage ? "image" : "file")
        }, status: "", failed: true)
      }
      pendingDraft = nil
    }
    updateComposer()
  }
  private var pendingSendID: String?
  private var acknowledgedSendID: String?
  private var restoredSendID: String?
  private var failedDraft: ChatPendingSend?

  func setPendingSend(_ pending: ChatPendingSend) {
    guard pending.id != restoredSendID, pending.id != acknowledgedSendID else { return }
    if pending.failed == true {
      pendingDraft = nil
      pendingSendID = nil
      updateComposer()
      return
    }
    guard pendingSendID != pending.id else { return }
    pendingSendID = pending.id
    pendingDraft = (pending.text, pending.attachments.compactMap { item in
      guard let url = URL(string: item.uri), url.isFileURL else { return nil }
      return ChatAttachment(id: item.id, name: item.name, url: url, isImage: item.kind == "image")
    }, sentStates[pending.id])
    updateComposer()
  }

  private func takeDraft() {
    guard pendingDraft == nil else { return }
    pendingDraft = (input.markdown, attachments, input.serializedState)
    // Cross-container creation keeps its draft visible while its host dismisses.
    guard sendHandoff else { return }
    input.text = ""
    attachments = []
  }
  #if LODY_SHARE_EXTENSION
  private func presentAttachmentCamera() {
    guard let controller = presenter() else { return }
    let camera = ChatAttachmentSheet(cameraOnly: true)
    camera.onPick = { [weak self] picked in self?.addAttachments(picked) }
    controller.present(camera, animated: true)
  }
  private func presentRecentPhotos() {
    guard let controller = presenter() else { return }
    let sheet = ChatAttachmentSheet()
    sheet.onPick = { [weak self] picked in self?.addAttachments(picked) }
    controller.present(sheet, animated: true)
  }
  #else
  @objc private func presentAttachments() {
    guard attach.isEnabled else { return }
    if attachmentOverlay.isPresented { attachmentOverlay.dismiss(); return }
    let page = OverlayPage(id: "attachments", layout: OverlayLayout(width: .fixed(280), height: .content(max: 300)),
      appearance: OverlayAppearance(corners: .fixed(OverlayControlMetrics().menuRadius)), contentScaling: .fit) { [weak self] in
      ChatAttachmentMenu.content { [weak self] action in
        guard let self else { return }
        switch action {
        case .recentPhotos: self.presentRecentPhotos()
        case .takePhoto: self.openCamera()
        case .files:
          self.finishAttachmentOverlay { owner, controller in owner.filePicker.files(from: controller) }
        }
      }
    }
    if attachmentPages.present(page, anchoredTo: attach, dismissLabel: String(localized: "native.close", bundle: .lody)) == .presented {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
  }

  private func finishAttachmentOverlay(onCancel: (() -> Void)? = nil, _ action: @escaping (ChatComposerView, UIViewController) -> Void) {
    attachmentOverlay.dismissWithResult { [weak self] result in
      guard result == .dismissed, let self, self.window != nil,
            self.attach.isEnabled, let controller = self.presenter() else { onCancel?(); return }
      action(self, controller)
    }
  }

  private var attachmentMediaLayout: OverlayLayout {
    .bottomEdge(inset: 12, height: .viewportFraction(0.60))
  }

  private func presentRecentPhotos() {
    attachmentPages.push(OverlayPage(id: "recent-photos", layout: attachmentMediaLayout,
      appearance: ChatRecentPhotosView.initialAppearance) { [weak self] in
      let photos = ChatRecentPhotosView()
      photos.onAppearanceChange = { [weak self] appearance in
        guard let self, self.attachmentPages.pageID == "recent-photos" else { return }
        self.attachmentPages.controller.updateAppearance(appearance)
      }
      photos.onBack = { [weak self] in self?.attachmentPages.back() }
      photos.onLibrary = { [weak self] in
        self?.finishAttachmentOverlay { owner, controller in owner.libraryPicker.present(from: controller) }
      }
      photos.onRequestAccess = { [weak self] in self?.requestPhotoAccess() }
      photos.onManageLimited = { [weak self] in
        self?.performMediaAccess { controller, complete in
          PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { _ in
            Task { @MainActor in complete(true) }
          }
        }
      }
      photos.onPick = { [weak self] picked in
        guard let self else { ChatAttachment.discardImports(picked); return }
        self.acceptOverlayAttachments(picked)
      }
      return photos
    })
  }
  private func openCamera() {
    if !ChatCameraCapture.fixture && AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
      requestCameraAccess()
    } else { presentCamera() }
  }

  private func presentCamera() {
    attachmentPages.push(OverlayPage(id: "camera", layout: attachmentMediaLayout,
      appearance: OverlayAppearance(corners: .bottomConcentric(top: 40)), contentLayout: .stable) { [weak self] in
      let camera = ChatCameraPage()
      camera.onBack = { [weak self] in self?.attachmentPages.back() }
      camera.onRequestAccess = { [weak self] in self?.requestCameraAccess() }
      camera.onPick = { [weak self] photo in
        guard let self else { try? FileManager.default.removeItem(at: photo.url); return }
        self.acceptOverlayAttachments([photo])
      }
      return camera
    })
  }

  /// The draft owns imports before the visual handoff; animation cancellation
  /// must never discard an accepted attachment.
  private func acceptOverlayAttachments(_ picked: [ChatAttachment]) {
    guard window != nil, attach.isEnabled, attachmentOverlay.isPresented else {
      ChatAttachment.discardImports(picked.filter { item in !attachments.contains { $0.url == item.url } })
      return
    }
    let accepted = picked.filter { item in !attachments.contains { $0.id == item.id } }
    ChatAttachment.discardImports(picked.filter { item in
      attachments.contains { $0.id == item.id } && !attachments.contains { $0.url == item.url }
    })
    guard let first = accepted.first else { attachmentOverlay.dismiss(); return }
    if !input.isFirstResponder { input.becomeFirstResponder() }
    addAttachments(accepted)
    window?.layoutIfNeeded()
    // The photo lands in the new pill's own thumbnail, which stays hidden until
    // the panel arrives so the swap is invisible.
    guard let image = ChatAttachment.thumbnail(first.url) else { attachmentOverlay.dismiss(); return }
    let representation = UIImageView(image: image)
    representation.contentMode = .scaleAspectFill
    representation.clipsToBounds = true
    attachmentOverlay.dismiss(to: attachmentBar.handoffDestination(id: first.id), representation: representation,
      cornerRadius: ChatAttachmentBar.thumbnailRadius, destinationVisibility: .hideDuringTransition) { _ in }
  }

  private func requestCameraAccess() {
    let needsPrompt = AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined
    performMediaAccess(page: .camera, waitForActivation: !needsPrompt) { _, complete in
      if needsPrompt {
        AVCaptureDevice.requestAccess(for: .video) { _ in
          Task { @MainActor in complete(true) }
        }
      } else if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url) { opened in
          Task { @MainActor in complete(opened) }
        }
      }
    }
  }

  private func requestPhotoAccess() {
    let needsPrompt = PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined
    performMediaAccess(waitForActivation: !needsPrompt) { _, complete in
      if needsPrompt {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
          Task { @MainActor in complete(true) }
        }
      } else if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url) { opened in
          Task { @MainActor in complete(opened) }
        }
      }
    }
  }

  private func performMediaAccess(page: AttachmentPage = .photos, waitForActivation: Bool = false,
      _ action: @escaping (UIViewController, @escaping @MainActor (Bool) -> Void) -> Void) {
    guard let controller = presenter() else { return }
    attachmentOverlay.performExternalInteraction(from: controller,
      interaction: waitForActivation ? .leavingApp : .inApp,
      isValid: { [weak self, weak controller] in
        guard let self, let controller else { return false }
        return self.attach.isEnabled && self.presenter() === controller
      }, operation: action, resume: { [weak self] in
        guard let self else { return }
        self.presentAttachments()
        switch page {
        case .photos: self.presentRecentPhotos()
        case .camera: self.presentCamera()
        }
      })
  }

  #endif

  private func addAttachments(_ picked: [ChatAttachment]) {
    attachments += picked.filter { new in !attachments.contains { $0.id == new.id } }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    updateComposer()
  }

  private func pasteLongText(_ paste: ComposerPaste) -> Bool {
    guard state.editable, let file = ChatAttachment.makePastedTextFile(paste.fileText, name: paste.fileName) else { return false }
    let location = input.selectedRange.location
    addAttachments([file])
    LodyToastOverlay.shared.show(
      message: String.localizedStringWithFormat(String(localized: "native.chat.composer.pasteAsFile", bundle: .lody), String(describing: file.name)),
      kind: "success",
      actionTitle: String(localized: "native.chat.composer.pasteUndo", bundle: .lody)
    ) { [weak self] in
      self?.undoPastedTextFile(id: file.id, paste: paste, location: location)
    }
    return true
  }

  private func undoPastedTextFile(id: String, paste: ComposerPaste, location: Int) {
    guard pendingDraft == nil, let index = attachments.firstIndex(where: { $0.id == id }), input.insertPaste(paste, at: location) else { return }
    attachments.remove(at: index)
    updateComposer()
    saveDraft()
  }
  private func presenter() -> UIViewController? {
    owningController().map { $0.presentedViewController ?? $0 } ?? window?.rootViewController
  }
  private func owningController() -> UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }
  private func fullScreenInputHeight(chrome: CGFloat) -> CGFloat {
    guard let superview, let host = owningController()?.view else { return ChatMessageContent.maximumCollapsedHeight }
    // Touches outside the superview never reach the composer, so the controller's safe area alone is not enough.
    let top = max(host.convert(CGPoint(x: 0, y: host.safeAreaInsets.top), to: superview).y, superview.safeAreaInsets.top) + 8
    return max(ChatMessageContent.maximumCollapsedHeight, frame.maxY - top - chrome)
  }
  @objc private func toggleFullScreen() {
    setFullScreen(!fullScreen)
  }
  private func setFullScreen(_ value: Bool, animated: Bool = true) {
    guard fullScreen != value, let superview else { return }
    superview.layoutIfNeeded()
    fullScreen = value
    if value {
      fullScreenDim.frame = superview.bounds
      fullScreenDim.alpha = 0
      superview.addSubview(fullScreenDim)
      superview.bringSubviewToFront(self)
      formatBar.refresh()
    }
    updateComposer()
    let changes = {
      self.fullScreenDim.alpha = value ? 1 : 0
      superview.layoutIfNeeded()
      self.input.scrollRangeToVisible(self.input.selectedRange)
    }
    let finish = { (_: Bool) in
      if !self.fullScreen { self.fullScreenDim.removeFromSuperview() }
    }
    guard animated, window != nil, !UIAccessibility.isReduceMotionEnabled else {
      changes()
      finish(true)
      return
    }
    UIView.animate(springDuration: 0.42, bounce: 0, options: [.beginFromCurrentState], animations: changes, completion: finish)
  }
  enum GrabberRelease { case close, sheet, fullScreen }
  static func grabberRelease(fromFullScreen: Bool, progress: CGFloat, translation: CGFloat, velocity: CGFloat) -> GrabberRelease {
    if !fromFullScreen && translation > 0 && (translation > 60 || velocity > 600) && velocity >= 0 { return .close }
    if abs(velocity) > 600 { return velocity < 0 ? .fullScreen : .sheet }
    return progress > 0.5 ? .fullScreen : .sheet
  }
  private func dragGrabber(_ pan: UIPanGestureRecognizer) {
    guard let superview, allowsFullScreen, input.isFirstResponder else { return }
    let translation = pan.translation(in: superview).y
    switch pan.state {
    case .began:
      dragStart = fullScreen ? 1 : 0
      if fullScreenDim.superview == nil {
        fullScreenDim.frame = superview.bounds
        fullScreenDim.alpha = 0
        superview.addSubview(fullScreenDim)
        superview.bringSubviewToFront(self)
        formatBar.refresh()
      }
      dragProgress = dragStart
    case .changed:
      let progress = min(1, max(0, dragStart - translation / dragDistance))
      dragProgress = progress
      fullScreenDim.alpha = progress
      updateComposer()
      superview.layoutIfNeeded()
    default:
      let velocity = pan.velocity(in: superview).y
      let progress = dragProgress ?? dragStart
      dragProgress = nil
      let release = Self.grabberRelease(fromFullScreen: dragStart == 1, progress: progress, translation: translation, velocity: velocity)
      if release == .close {
        fullScreenDim.removeFromSuperview()
        input.resignFirstResponder()
        return
      }
      let target = release == .fullScreen
      fullScreen = target
      updateComposer()
      let settle = {
        self.fullScreenDim.alpha = target ? 1 : 0
        superview.layoutIfNeeded()
        self.input.scrollRangeToVisible(self.input.selectedRange)
      }
      let finish = { (_: Bool) in
        if !self.fullScreen { self.fullScreenDim.removeFromSuperview() }
      }
      guard window != nil, !UIAccessibility.isReduceMotionEnabled else {
        settle()
        finish(true)
        return
      }
      UIView.animate(springDuration: 0.42, bounce: 0, options: [.beginFromCurrentState], animations: settle, completion: finish)
    }
  }
  var connection: String { state.connection ?? "" }

  private(set) var suppressesComposer = false

  func setComposerState(_ json: String) {
    guard let value = try? JSONDecoder().decode(ChatComposerState.self, from: Data(json.utf8)) else { return }
    if value.sending && !state.sending && !relaying { takeDraft() }
    state = value
    suppressesComposer = quotaLocked(json)
    updateComposer()
  }

  private func quotaLocked(_ json: String) -> Bool {
    guard let data = json.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    return object["quotaLocked"] as? Bool == true
  }
  func setComposerOptions(_ json: String) {
    guard let value = try? JSONDecoder().decode(ChatComposerOptions.self, from: Data(json.utf8)) else { return }
    // A mark arriving or leaving changes the collapsed line's insets, so lay the composer out again.
    let markChanged = composerOptions.agentAsset != value.agentAsset
    composerOptions = value
    if markChanged { updateComposer() } else { updateComposerOptions() }
  }
  func setQueue(_ drafts: [ChatQueuedDraft]) {
    guard queuedDrafts != drafts else { return }
    queuedDrafts = drafts
    updateComposer()
  }
  private func updateComposer() {
    input.hydrateReferences(activeMentionItems ?? [])
    mentionPanel.update(input: input, items: activeMentionItems ?? [], enabled: activeMentionItems != nil)
    let dockChanged = mentionHeight.constant != mentionPanel.panelHeight
    mentionHeight.constant = mentionPanel.panelHeight
    // The prompt (and everything above it) sits on top of the docked panel.
    (surfaceLayout as? ChatComposerLiquidGlassSurfaceLayout)?.setBottomInset(mentionPanel.panelHeight)
    if dockChanged && window != nil && !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(springDuration: 0.32, bounce: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        (self.window ?? self.superview ?? self).layoutIfNeeded()
      }
    }
    // Card style (new session) has no @ button, like web: typing @ still opens mentions.
    mentionButton.isHidden = cardStyle || activeMentionItems == nil || !input.isFirstResponder
    mentionButton.isEnabled = state.editable && !state.sending && pendingDraft == nil
    let sending = state.sending || pendingDraft != nil
    if !state.editable && input.isFirstResponder { input.resignFirstResponder() }
    let expanded = input.isFirstResponder || cardOpen
    // The card always shows its controls; editing is what gives the bar's row to the editor.
    let editing = input.isFirstResponder
    let expansionChanged = composerExpanded != expanded
    // The bottom anchor belongs to the host; animate its layout with the contents.
    let layoutRoot = window ?? superview ?? self
    if expansionChanged && window != nil { layoutRoot.layoutIfNeeded() }
    // Keep one visible mark while its two button layouts exchange places.
    var movingMark: UIImageView?
    if expansionChanged && restsCollapsed && window != nil && !UIAccessibility.isReduceMotionEnabled,
       composerOptions.roleEmoji?.isEmpty != false {
      let source = movingAgentMark ?? (composerExpanded ? modelButton.imageView : collapsedMark.imageView)
      if let source, let image = source.image, !source.bounds.isEmpty {
        let mark = UIImageView(image: image)
        mark.contentMode = .scaleAspectFit
        if source === movingAgentMark {
          mark.frame = source.layer.presentation()?.frame ?? source.frame
        } else {
          mark.frame = source.convert(source.bounds, to: inputSurface.contentView)
        }
        movingAgentMark?.removeFromSuperview()
        inputSurface.contentView.addSubview(mark)
        movingAgentMark = mark
        movingMark = mark
      }
    }
    composerExpanded = expanded
    input.isEditable = state.editable && (sendHandoff || !sending)
    attach.isEnabled = state.editable && !sending
    #if !LODY_SHARE_EXTENSION
    if !attach.isEnabled { attachmentOverlay.cancel() }
    if !attachmentOverlay.isPresented { attach.alpha = attach.isEnabled ? 1 : 0.5 }
    #else
    attach.alpha = attach.isEnabled ? 1 : 0.5
    #endif
    attachmentBar.isUserInteractionEnabled = state.editable && !sending
    attachmentBar.render(attachments)
    attachmentBar.isHidden = !expanded
    let showsAttachmentRow = expanded && attachmentBar.hasVisiblePills
    attachmentHeight.constant = showsAttachmentRow ? 48 : 0
    attachmentTop.constant = showsAttachmentRow ? 12 : 0
    attachmentStack.render(attachments)
    attachmentStack.isHidden = expanded || attachments.isEmpty
    hint.text = attachments.isEmpty ? state.placeholder : String(localized: "native.chat.composer.addMessage", bundle: .lody)
    hint.isHidden = !input.text.isEmpty
    let hasContent = !input.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    let stop = !hasContent && state.running == true
    var label = "native.chat.composer.send"
    if stop { label = "native.chat.composer.stop" }
    let loading = sending || state.stopping == true
    if sending { label = "native.chat.composer.sending" }
    if state.stopping == true { label = "native.chat.composer.stopping" }
    let actionable = stop ? state.canStop == true : state.canSend && hasContent
    send.isEnabled = failedDraft == nil && displayError == nil && state.editable && actionable && !loading && state.controlling != true
    if send.isEnabled && !stop { sendFeedback.prepare() }
    send.accessibilityLabel = String(localized: String.LocalizationValue(label), bundle: .lody)
    send.accessibilityIdentifier = stop ? "session-stop" : "session-send"
    var actionMode: ChatComposerActionMode = stop ? .stop : .send
    if loading { actionMode = .loading }
    sendVisual.render(actionMode)
    sendVisual.isHidden = false
    sendVisual.alpha = send.isEnabled || loading ? 1 : 0.35
    // The one-line composer keeps Send in place (dimmed until there is something to send).
    send.isHidden = false
    queueView.render(queuedDrafts, enabled: state.canStop == true && !sending && state.controlling != true, steeringID: state.steerID ?? "", firstOnly: state.steerInterrupts == true)
    queueHeight.constant = queueView.panelHeight
    // The action bar stays while typing; expanded editing gives its row to the editor.
    let showsBar = !editing && ChatActionBarView.shows(state.actionBar)
    actionBar.render(state.actionBar, visible: showsBar, animated: true)
    // One row of capsules; the stacked fallback at very large text is taller.
    actionBarHeight.constant = showsBar ? actionBar.fittingHeight(width: max(0, bounds.width - 32)) : 0
    queueGap.constant = showsBar && queueHeight.constant > 0 ? 8 : 0
    let noticeText = failedDraft == nil ? (displayError ?? state.notice) : String(localized: "native.chat.composer.failedDraft", bundle: .lody)
    let canReconnect = failedDraft != nil || displayError != nil || state.reconnect
    notice.setTitle(noticeText, for: .normal)
    notice.isHidden = noticeText.isEmpty
    notice.setTitleColor(canReconnect ? .lodyAccent : .secondaryLabel, for: .normal)
    notice.isUserInteractionEnabled = canReconnect
    notice.accessibilityTraits = canReconnect ? .button : .staticText
    let noticeSize = notice.sizeThatFits(CGSize(width: max(1, bounds.width - 40), height: .greatestFiniteMagnitude))
    noticeHeight.constant = noticeText.isEmpty ? 0 : max(44, noticeSize.height + 12)
    quotaNotice.text = state.quotaNotice
    quotaNotice.isHidden = state.quotaNotice?.isEmpty != false
    quotaNotice.isAccessibilityElement = !quotaNotice.isHidden
    let quotaWidth = inputSurface.bounds.width > 32 ? inputSurface.bounds.width - 32 : bounds.width - 96
    let quotaSize = quotaNotice.sizeThatFits(CGSize(width: max(1, quotaWidth), height: .greatestFiniteMagnitude))
    quotaNoticeHeight.constant = quotaNotice.isHidden ? 0 : max(quotaNotice.font.lineHeight, quotaSize.height)
    quotaGap.constant = quotaNotice.isHidden ? 8 : 6
    if (fullScreen || dragProgress != nil) && (!allowsFullScreen || !editing || !state.editable) {
      fullScreen = false
      dragProgress = nil
      fullScreenDim.removeFromSuperview()
    }
    let showsGrabber = editing && allowsFullScreen
    grabber.isHidden = !showsGrabber
    grabberHeight.constant = showsGrabber ? ChatComposerGrabber.height : 0
    grabber.accessibilityLabel = String(localized: String.LocalizationValue(fullScreen ? "native.chat.composer.collapse" : "native.chat.composer.expand"), bundle: .lody)
    let fullProgress = dragProgress ?? (fullScreen ? 1 : 0)
    accessoryHeight.constant = expanded ? 48 : 0
    attachLeading.constant = expanded ? 8 : 2
    sheetContentBottom.constant = expanded && !cardStyle ? -ChatComposerLiquidGlassSurfaceLayout.sheetBleed : 0
    formatHeight.constant = 44 * fullProgress
    formatBar.alpha = fullProgress
    formatBar.isHidden = fullProgress == 0
    formatBar.accessibilityElementsHidden = !fullScreen
    let verticalInset = expanded ? 14 : max(0, (48 - input.font!.lineHeight) / 2)
    let topInset = showsGrabber ? 4 : verticalInset
    var leadingInset: CGFloat = 20
    if !expanded {
      leadingInset = attachmentStack.isHidden ? 46 : 46 + attachmentStack.stackWidth + 8
    }
    input.textContainer.maximumNumberOfLines = expanded ? 0 : 1
    input.textContainer.lineBreakMode = expanded ? .byWordWrapping : .byTruncatingTail
#if !LODY_SHARE_EXTENSION
    renderUsage()
#endif
    renderCollapsedMark()
    let showsMark = showsCollapsedMark(expanded: expanded)
    var trailingInset: CGFloat = 46 + usageWidth.constant
    if showsMark { trailingInset += collapsedMarkWidth }
    if expanded { trailingInset = 20 }
    input.textContainerInset = UIEdgeInsets(top: topInset, left: leadingInset, bottom: verticalInset, right: trailingInset)
    hintLeading.constant = leadingInset + 5
    hintTop.constant = topInset
    let height = input.sizeThatFits(CGSize(width: max(1, input.bounds.width), height: .greatestFiniteMagnitude)).height
    let overflows = height > ChatMessageContent.maximumCollapsedHeight
    let chrome = mentionHeight.constant + queueHeight.constant + queueGap.constant + actionBarHeight.constant + noticeHeight.constant + attachmentTop.constant + attachmentHeight.constant + quotaNoticeHeight.constant + accessoryHeight.constant + formatHeight.constant + grabberHeight.constant + (expanded ? 8 : 16)
    // Card style rests at one line above its controls and opens to three while editing; the
    // glass sheet keeps its taller writing area.
    var minimumHeight: CGFloat = 132
    if cardStyle {
      let lines: CGFloat = input.isFirstResponder ? 3 : 1
      minimumHeight = topInset + verticalInset + lines * input.font!.lineHeight
    }
    let inlineHeight = expanded ? min(ChatMessageContent.maximumCollapsedHeight, max(minimumHeight, height)) : 48
    // A conversation's card opens with focus (the expansion's own animation carries it).
    // A conversation's card can also stay open across a focus change when a draft keeps it open.
    let cardFocusChanged = cardStyle && !expansionChanged && cardFocused != input.isFirstResponder
    cardFocused = input.isFirstResponder
    if fullProgress > 0 {
      let fullHeight = fullScreenInputHeight(chrome: chrome - formatHeight.constant + 44)
      dragDistance = max(1, fullHeight + 44 - inlineHeight)
      inputHeight.constant = inlineHeight + (fullHeight - inlineHeight) * fullProgress
    } else {
      dragDistance = max(1, fullScreenInputHeight(chrome: chrome + 44) + 44 - inlineHeight)
      inputHeight.constant = inlineHeight
    }
    input.isScrollEnabled = expanded && (fullProgress > 0 || overflows)
    if !expanded { input.contentOffset = .zero }
    updateComposerOptions()
    onHeightChange?(chrome + inputHeight.constant)
    setNeedsLayout()
    // The card is always "expanded", so its focus change grows the input here: ride along with
    // the keyboard on the same spring rather than jumping.
    if cardFocusChanged && window != nil && !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(springDuration: 0.35, bounce: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        (self.window ?? self.superview ?? self).layoutIfNeeded()
      }
    }
    // Carry the mark between buttons while the controls fade on the expansion's own curve.
    let markAlpha: CGFloat = showsMark ? 1 : 0
    let controlsAlpha: CGFloat = expanded ? 1 : 0
    if expansionChanged {
      if window != nil && !UIAccessibility.isReduceMotionEnabled {
        UIView.animate(withDuration: 0.24, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
          self.surfaceLayout.update(isFocused: expanded)
          self.collapsedMark.alpha = markAlpha
          self.controls.alpha = controlsAlpha
          layoutRoot.layoutIfNeeded()
          if let movingMark,
             let destination = expanded ? self.modelButton.imageView : self.collapsedMark.imageView {
            movingMark.frame = destination.convert(destination.bounds, to: self.inputSurface.contentView)
          }
        } completion: { finished in
          if let movingMark, self.movingAgentMark === movingMark {
            movingMark.removeFromSuperview()
            self.movingAgentMark = nil
            self.modelButton.imageView?.alpha = 1
            self.collapsedMark.imageView?.alpha = 1
          }
          if finished && self.composerExpanded == expanded { self.surfaceLayout.completeTransition() }
        }
      } else {
        surfaceLayout.update(isFocused: expanded)
        collapsedMark.alpha = markAlpha
        controls.alpha = controlsAlpha
        layoutRoot.layoutIfNeeded()
        surfaceLayout.completeTransition()
      }
    } else {
      collapsedMark.alpha = markAlpha
      controls.alpha = cardOpen ? 1 : controlsAlpha
    }
    collapsedMark.isUserInteractionEnabled = showsMark
    collapsedMark.accessibilityElementsHidden = !showsMark
    collapsedMark.isAccessibilityElement = showsMark
  }

  /// Width the collapsed mark takes beside Send (mark, chevron and their padding).
  private var collapsedMarkWidth: CGFloat { collapsedMark.intrinsicContentSize.width }

  private func showsCollapsedMark(expanded: Bool) -> Bool {
    !expanded && composerOptions.agentAsset != nil
  }

  /// The collapsed face of the run-config chip: the agent mark alone, tinted like text.
  private func renderCollapsedMark() {
    guard let asset = composerOptions.agentAsset,
          let mark = UIImage(named: asset, in: .main, compatibleWith: traitCollection) else { return }
    let side: CGFloat = 20
    let face = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
      mark.withTintColor(.label.resolvedColor(with: traitCollection)).draw(in: CGRect(x: 0, y: 0, width: side, height: side))
    }
    var configuration = UIButton.Configuration.plain()
    configuration.image = face.withRenderingMode(.alwaysOriginal)
    // The 44 pt target keeps its width but leans its padding leading, so the mark sits close
    // to the context ring and Send.
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 6)
    collapsedMark.configuration = configuration
    collapsedMark.imageView?.alpha = movingAgentMark == nil ? 1 : 0
    collapsedMark.isEnabled = modelButton.isEnabled
    collapsedMark.accessibilityLabel = modelButton.accessibilityLabel
  }

  @objc private func openFromCollapsedMark() {
    // The card's run config is a sheet: open it straight from the mark, no keyboard first.
    if cardStyle, let onRunConfig {
      guard state.editable, modelButton.isEnabled || composerOptions.agentAsset != nil else { return }
      return onRunConfig()
    }
    guard state.editable, input.becomeFirstResponder() else { return }
    // Opening runs on the expansion's curve; the panel follows once the chip has landed.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) { [weak self] in
      guard let self, self.composerExpanded, !self.composerOptions.models.isEmpty else { return }
      self.presentComposerOptions()
    }
  }
  private func updateComposerOptions() {
    let permissions = composerOptions.permissions ?? []
    // Card style shows the mode inside the run-config chip (web's face), not as a shield button.
    permissionButton.isHidden = !composerExpanded || permissions.isEmpty || cardStyle
    permissionButton.isEnabled = state.editable && !state.sending && pendingDraft == nil
    permissionButton.accessibilityValue = permissions.first { $0.id == composerOptions.permissionId }?.title
      ?? String(localized: "model.useDefault", bundle: .lody)
    permissionButton.menu = UIMenu(title: String(localized: "model.tab.permission", bundle: .lody), children: permissions.map { option in
      UIAction(title: option.title, subtitle: option.description, state: option.id == composerOptions.permissionId ? .on : .off) { [weak self] _ in
        guard let self, self.permissionButton.isEnabled,
          self.composerOptions.permissions?.contains(where: { $0.id == option.id }) == true else { return }
        self.composerOptions.permissionId = option.id
        self.updateComposerOptions()
        self.onComposerOptionChange?(["modelId": self.composerOptions.modelId, "effort": self.composerOptions.effort, "permissionId": option.id])
      }
    })
    let hasRunConfig = cardStyle && onRunConfig != nil && composerOptions.agentName?.isEmpty == false
    modelButton.isHidden = !composerExpanded || (composerOptions.models.isEmpty && !hasRunConfig)
    modelButton.isEnabled = state.editable && !state.sending && pendingDraft == nil
    // Web's run-config chip: assistant mark, model · effort, and a fast bolt, in one line.
    let font = LodyTextStyle.subhead.uiFont
    let dot = NSAttributedString(string: "  ·  ", attributes: [.foregroundColor: UIColor.tertiaryLabel])
    var triggerTitle = composerOptions.modelTitle
    if hasRunConfig && composerOptions.models.isEmpty {
      triggerTitle = composerOptions.agentName ?? triggerTitle
    }
    let title = NSMutableAttributedString(string: triggerTitle, attributes: [.foregroundColor: UIColor.label])
    if !composerOptions.efforts.isEmpty || !composerOptions.effort.isEmpty {
      title.append(dot)
      title.append(NSAttributedString(string: composerOptions.effortTitle, attributes: [.foregroundColor: UIColor.label]))
    }
    var summary = title.string
    if cardStyle, let mode = composerOptions.permissions?.first(where: { $0.id == composerOptions.permissionId }) {
      summary += " · " + mode.title
      let icon: LodyIcon?
      var tint = LodyUIColor.textSecondary
      switch mode.id {
      case "agent", "default": icon = .permissionDefault
      case "read-only": icon = .eye
      case "acceptEdits": icon = .edit
      case "plan": icon = .permissionPlan
      case "agent-full-access", "danger-full-access", "dontAsk", "bypassPermissions", "yolo", "always-approve":
        icon = .permissionWarning
        tint = LodyUIColor.warningDefault
      case "auto", "agent-auto-review":
        icon = nil
        title.append(dot)
        title.append(NSAttributedString(string: "Auto", attributes: [.foregroundColor: tint]))
      default: icon = nil
      }
      if let icon {
        let mark = NSTextAttachment()
        mark.image = icon.uiImage?.withTintColor(tint, renderingMode: .alwaysOriginal)
        mark.bounds = CGRect(x: 0, y: font.descender, width: font.lineHeight, height: font.lineHeight)
        title.append(dot)
        title.append(NSAttributedString(attachment: mark))
      }
    }
    if composerOptions.fast == true {
      let symbol = NSTextAttachment()
      symbol.image = UIImage(systemName: "bolt", withConfiguration: UIImage.SymbolConfiguration(pointSize: font.pointSize, weight: .medium))?
        .withTintColor(.lodyAccent, renderingMode: .alwaysOriginal)
      title.append(dot)
      title.append(NSAttributedString(attachment: symbol))
    }
    var agentImage: UIImage?
    if let emoji = composerOptions.roleEmoji, !emoji.isEmpty {
      // An Agent Role leads with its emoji instead of the assistant's mark (web's Role face).
      title.addAttribute(.font, value: font, range: NSRange(location: 0, length: title.length))
      title.setAttributedString(roleFace(emoji: emoji, name: composerOptions.roleName ?? "", rest: title, font: font))
      summary = [composerOptions.roleName ?? "", summary].filter { !$0.isEmpty }.joined(separator: " · ")
    } else if let asset = composerOptions.agentAsset, let mark = UIImage(named: asset, in: .main, compatibleWith: traitCollection) {
      // Marks are template images: draw them in the title's ink so they read in dark mode.
      agentImage = UIGraphicsImageRenderer(size: CGSize(width: font.lineHeight, height: font.lineHeight)).image { _ in
        mark.withTintColor(.label.resolvedColor(with: traitCollection)).draw(in: CGRect(x: 0, y: 0, width: font.lineHeight, height: font.lineHeight))
      }.withRenderingMode(.alwaysOriginal)
    }
    title.addAttribute(.font, value: font, range: NSRange(location: 0, length: title.length))
    var configuration = UIButton.Configuration.plain()
    configuration.attributedTitle = AttributedString(title)
    configuration.image = agentImage
    configuration.imagePadding = 8
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)
    configuration.baseForegroundColor = .label
    configuration.titleLineBreakMode = .byTruncatingTail
    modelButton.configuration = configuration
    modelButton.imageView?.alpha = movingAgentMark == nil ? 1 : 0
    modelButton.accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.composer.modelButton", bundle: .lody), String(describing: summary))
    modelButton.accessibilityValue = composerOptions.fast == true ? String(localized: "native.chat.composer.fast", bundle: .lody) + ": " + String(localized: "native.chat.composer.fastOn", bundle: .lody) : nil
    optionsPopover?.render(composerOptions)
    if !modelButton.isEnabled { optionsPopover?.dismiss(animated: true) }
    renderCollapsedMark()
  }
  /// The chip with an Agent Role: emoji, the Role's name, then model · effort · mode in secondary
  /// ink — or, when that does not fit the chip's room, the emoji right before the model.
  private func roleFace(emoji: String, name: String, rest: NSAttributedString, font: UIFont) -> NSAttributedString {
    let glyph = NSAttributedString(string: emoji + "  ", attributes: [.font: font])
    let compact = NSMutableAttributedString(attributedString: glyph)
    compact.append(rest)
    guard !name.isEmpty else { return compact }
    let named = NSMutableAttributedString(attributedString: glyph)
    named.append(NSAttributedString(string: name, attributes: [.font: font, .foregroundColor: UIColor.label]))
    named.append(NSAttributedString(string: "   ", attributes: [.font: font]))
    let quiet = NSMutableAttributedString(attributedString: rest)
    quiet.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: quiet.length)) { value, range, _ in
      // Model and effort recede; status colour (a warning mode) and the dots keep theirs.
      if (value as? UIColor) == UIColor.label { quiet.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: range) }
    }
    named.append(quiet)
    // The chip shares the bottom row with + and Send (44 pt each) and its own insets.
    let room = input.bounds.width - 44 * 2 - 24
    return room > 0 && named.size().width <= room ? named : compact
  }

#if !LODY_SHARE_EXTENSION
  private func renderUsage() {
    let usage = state.usage
    if let panel = usagePanel, panel.usage != usage { panel.dismiss(animated: false) }
    let visible = usage?.visible == true
    usageButton.isHidden = !visible
    usageWidth.constant = 0
    guard let usage, visible else {
      usagePanel?.dismiss(animated: false)
      return
    }
    // Sized to its content (ring, gap, percentage, 2 pt each side) so the agent mark, the ring
    // and Send sit close together.
    let font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    let title = "\(Int((usage.percentage ?? 0).rounded()))%"
    var config = UIButton.Configuration.plain()
    config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 2)
    config.imagePadding = 4
    config.baseForegroundColor = .secondaryLabel
    config.title = title
    config.image = ChatUsageRing.image(usage.percentage ?? 0)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var result = incoming
      result.font = font
      return result
    }
    let titleWidth = (title as NSString).size(withAttributes: [.font: font]).width
    usageWidth.constant = ceil(ChatUsageRing.side + 4 + titleWidth + 4)
    if usage.isContextCompacting == true {
      config.title = nil
      config.image = nil
      config.showsActivityIndicator = true
    }
    usageButton.configuration = config
    usageButton.accessibilityLabel = usage.isContextCompacting == true ? ChatSessionUsage.text("compacting") : ChatSessionUsage.text("title")
    usageButton.accessibilityValue = ChatSessionUsage.used(usage.percentage ?? 0)
  }

  @objc func presentUsage() {
    guard let usage = state.usage, usage.visible, let controller = presenter(), usagePanel == nil else { return }
    let panel = ChatUsagePanel(usage: usage, now: usageNow)
    panel.modalPresentationStyle = .popover
    if let popover = panel.popoverPresentationController {
      popover.sourceView = usageButton
      popover.sourceRect = usageButton.bounds
      popover.permittedArrowDirections = .down
      popover.delegate = panel
    }
    usagePanel = panel
    controller.present(panel, animated: true)
  }
#endif

  @objc private func presentComposerOptions() {
    if cardStyle, let onRunConfig {
      guard modelButton.isEnabled else { return }
      return onRunConfig()
    }
    guard modelButton.isEnabled, let controller = presenter(), optionsPopover == nil else { return }
    let panel = ChatComposerModelPanel()
    panel.onModel = { [weak self] in self?.selectModel($0) }
    panel.onEffort = { [weak self] in self?.selectEffort($0) }
    panel.onFast = { [weak self] enabled in
      guard let self else { return }
      self.composerOptions.fast = enabled
      self.updateComposerOptions()
      self.onComposerOptionChange?(["modelId": self.composerOptions.modelId, "effort": self.composerOptions.effort, "fast": enabled])
    }
    panel.loadViewIfNeeded()
    panel.render(composerOptions)
    panel.modalPresentationStyle = .popover
    if let popover = panel.popoverPresentationController {
      popover.sourceView = modelButton
      popover.sourceRect = modelButton.bounds
      popover.permittedArrowDirections = .down
      popover.delegate = panel
    }
    optionsPopover = panel
    controller.present(panel, animated: true)
  }
  private func selectModel(_ id: String) {
    guard composerOptions.modelId != id else { return }
    composerOptions.modelId = id
    composerOptions.effort = ""
    composerOptions.efforts = []
    updateComposerOptions()
    onComposerOptionChange?(["modelId": id, "effort": ""])
  }
  private func selectEffort(_ id: String) {
    guard composerOptions.effort != id else { return }
    composerOptions.effort = id
    updateComposerOptions()
    onComposerOptionChange?(["modelId": composerOptions.modelId, "effort": id])
  }
  func setMentionResult(_ json: String) {
    struct Result: Decodable { let id: String; var path: String?; var item: ChatMentionItem? }
    guard let data = json.data(using: .utf8), let result = try? JSONDecoder().decode(Result.self, from: data), result.id != mentionResultID else { return }
    mentionResultID = result.id
    mentionNeedsFocus = true
    mentionPanel.finishBrowse(path: result.path, selectedItem: result.item)
    focusAfterMentionPicker()
  }
  private func focusAfterMentionPicker() {
    let focus = { [weak self] in
      guard let self, self.window != nil else { return }
      self.mentionNeedsFocus = false
      self.input.becomeFirstResponder()
      self.updateComposer()
    }
    if let transition = presenter()?.transitionCoordinator {
      transition.animate(alongsideTransition: nil) { _ in focus() }
    } else { focus() }
  }
  @objc private func openMentions() { mentionPanel.open(input: input) }
  func textViewDidChangeSelection(_ textView: UITextView) {
    if fullScreen { formatBar.refresh() }
    guard activeMentionItems != nil else { return }
    updateComposer()
  }
  func textViewDidChange(_ textView: UITextView) { updateComposer() }
  func textViewDidBeginEditing(_ textView: UITextView) { updateComposer() }
  func textViewDidEndEditing(_ textView: UITextView) {
    setFullScreen(false)
    updateComposer()
    saveDraft()
  }
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    let action = #selector(ChatComposerInput.pastePlainText(_:))
    guard textView.canPerformAction(action, withSender: nil) else {
      return UIMenu(children: suggestedActions)
    }
    let plainText = UIAction(title: String(localized: "native.chat.composer.pastePlainText", bundle: .lody)) { [weak textView] _ in
      (textView as? ChatComposerInput)?.pastePlainText(nil)
    }
    return UIMenu(children: [plainText] + suggestedActions)
  }
  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    !relaying && (textView.text as NSString).length - range.length + (text as NSString).length <= 32000
  }
  @objc private func submit() {
    guard send.isEnabled else { return }
    if previewBeforeSubmit?() == true { return }
    if state.running == true && input.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty {
      onStop?()
      return
    }
    sendFeedback.impactOccurred(intensity: 0.85)
    if fullScreen { UIView.performWithoutAnimation { setFullScreen(false, animated: false) } }
    let queued = queuesSubmission
    let guiding = guidesSubmission
    let id = UUID().uuidString.lowercased()
    let body = input.markdown
    let payload: [String: Any] = [
      "id": id, "queue": queued, "guide": guiding, "text": body, "displayText": input.text ?? body,
      "startedAt": Date().timeIntervalSince1970 * 1000,
      "attachments": attachments.map {
        ["id": $0.id, "name": $0.name, "uri": $0.url.absoluteString, "kind": $0.isImage ? "image" : "file"]
      },
    ]
    if relaying || prepareSend?(payload) == true { return }
    commitSend(payload)
    onSend?(payload)
  }

  /// The creation host publishes once; the adopted composer starts the visual send later.
  func commitSend(_ payload: [String: Any]) {
    guard let id = payload["id"] as? String else { return }
    let queued = payload["queue"] as? Bool == true
    let guiding = payload["guide"] as? Bool == true
    let body = input.text ?? ""
    relaying = false
    if !queued && sendHandoff {
      if !body.isEmpty { ChatSendHandoff.begin(id: id, source: input, straight: guiding) }
      ChatSendHandoff.beginAttachments(id: id, attachments: attachments, source: attachmentBar)
    }
    LodyToastOverlay.shared.dismiss()
    input.serializedState.map { sentStates[id] = $0 }
    takeDraft()
    saveDraft()
    pendingSendID = id
    // A pushed creation page disappears with its keyboard. Ending editing earlier
    // lowers the form before its destination can receive the flying message.
    if dismissesKeyboardOnSend && input.isFirstResponder { input.resignFirstResponder() }
    updateComposer()
  }
  @objc private func reconnect() {
    guard let failed = failedDraft else { onReconnect?(); return }
    let restored = input.text.isEmpty && sentStates[failed.id].map { input.restore(state: $0) } == true
    if !restored { input.appendParagraphs(failed.text) }
    for item in failed.attachments where !attachments.contains(where: { $0.id == item.id }) {
      guard let url = URL(string: item.uri), url.isFileURL else { continue }
      attachments.append(ChatAttachment(id: item.id, name: item.name, url: url, isImage: item.kind == "image"))
    }
    restoredSendID = failed.id
    failedDraft = nil
    updateComposer()
    saveDraft()
  }
}
