/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import MobileCoreServices
import UIKit
import UniformTypeIdentifiers

protocol LexicalTextViewDelegate: NSObjectProtocol {
  func textViewDidBeginEditing(textView: TextView)
  func textViewDidEndEditing(textView: TextView)
  func textViewShouldChangeText(_ textView: UITextView, range: NSRange, replacementText text: String) -> Bool
  @available(iOS, deprecated: 17.0, message: "Use textView(_:primaryActionFor:defaultAction:) with UITextItem instead")
  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool
}

/// Lexical's subclass of UITextView. Note that using this can be dangerous, if you make changes that Lexical does not expect.
@objc open class TextView: UITextView {
  public let editor: Editor

  internal let pasteboard = UIPasteboard.general
  internal let pasteboardIdentifier = "x-lexical-nodes"
  internal var isUpdatingNativeSelection = false
  private let textLayoutManagerDelegate = TextLayoutManagerDelegate()
  fileprivate weak var externalDelegate: UITextViewDelegate?

  // This is to work around a UIKit issue where, in situations like autocomplete, UIKit changes our selection via
  // private methods, and the first time we find out is when our delegate method is called. @amyworrall
  internal var interceptNextSelectionChangeAndReplaceWithRange: NSRange?
  weak var lexicalDelegate: LexicalTextViewDelegate?
  private var placeholderLabel: UILabel

  private let useInputDelegateProxy: Bool
  private let inputDelegateProxy: InputDelegateProxy

  fileprivate var textViewDelegate: TextViewDelegate = TextViewDelegate()

  // MARK: - Init

  public required init(editorConfig: EditorConfig, featureFlags: FeatureFlags) {
    let textStorage = TextStorage()
    let contentStorage = NSTextContentStorage()
    contentStorage.textStorage = textStorage
    let textLayoutManager = NSTextLayoutManager()
    contentStorage.addTextLayoutManager(textLayoutManager)
    contentStorage.primaryTextLayoutManager = textLayoutManager

    let textContainer = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    textContainer.widthTracksTextView = true
    textLayoutManager.textContainer = textContainer

    var reconcilerSanityCheck = featureFlags.reconcilerSanityCheck

    #if targetEnvironment(simulator)
    reconcilerSanityCheck = false
    #endif

    editor = Editor(
      featureFlags: FeatureFlags(reconcilerSanityCheck: reconcilerSanityCheck),
      editorConfig: editorConfig)
    textStorage.editor = editor
    placeholderLabel = UILabel(frame: .zero)

    useInputDelegateProxy = featureFlags.proxyTextViewInputDelegate
    inputDelegateProxy = InputDelegateProxy()

    super.init(frame: .zero, textContainer: textContainer)
    textLayoutManager.delegate = textLayoutManagerDelegate

    if useInputDelegateProxy {
      inputDelegateProxy.targetInputDelegate = self.inputDelegate
      super.inputDelegate = inputDelegateProxy
    }

    textViewDelegate.owner = self
    super.delegate = textViewDelegate
    textContainerInset = UIEdgeInsets(top: 8.0, left: 5.0, bottom: 8.0, right: 5.0)

    setUpPlaceholderLabel()
    registerRichText(editor: editor)
    _ = editor.registerUpdateListener { [weak self] _, _, _ in
      self?.setNeedsLayout()
    }
  }

  /// This init method is used for unit tests
  convenience init() {
    self.init(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) {
    fatalError("\(#function) has not been implemented")
  }

  // UIKit's setter would insert newlines as literal characters in one text node; each line becomes a paragraph instead.
  override open var text: String! {
    get { super.text }
    set { setPlainText(newValue ?? "") }
  }

  public func setPlainText(_ value: String) {
    try? editor.update {
      guard let root = getRoot() else { return }
      for child in root.getChildren() {
        try child.remove()
      }
      var last: ParagraphNode?
      for line in value.components(separatedBy: "\n") {
        let paragraph = createParagraphNode()
        if !line.isEmpty {
          try paragraph.append([createTextNode(text: line)])
        }
        try root.append([paragraph])
        last = paragraph
      }
      _ = try last?.selectEnd()
    }
  }

  // UIKit dispatches through this getter, so it must keep returning Lexical's delegate; assigned delegates receive forwarded calls.
  // UIScrollView caches responds(to:) when its delegate is assigned, so reassigning refreshes which forwarded methods it calls.
  override open var delegate: UITextViewDelegate? {
    get { super.delegate }
    set {
      externalDelegate = newValue
      super.delegate = nil
      super.delegate = textViewDelegate
    }
  }

  // TextKit 2 renders into plain views inside the text container; a touch landing on one skips UITextView's tap-to-edit.
  override open func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    if let hit, hit !== textInputView, hit.isDescendant(of: textInputView) {
      return textInputView
    }
    return hit
  }

  override open func layoutSubviews() {
    super.layoutSubviews()
    positionAllDecorators()

    placeholderLabel.frame.origin = CGPoint(x: textContainer.lineFragmentPadding * 1.5 + textContainerInset.left, y: textContainerInset.top)
    placeholderLabel.sizeToFit()
  }

  override open var inputDelegate: UITextInputDelegate? {
    get {
      if useInputDelegateProxy {
        return inputDelegateProxy.targetInputDelegate
      } else {
        return super.inputDelegate
      }
    }
    set {
      if useInputDelegateProxy {
        inputDelegateProxy.targetInputDelegate = newValue
      } else {
        super.inputDelegate = newValue
      }
    }
  }

  // MARK: - Incoming events

  override open func deleteBackward() {
    editor.log(.UITextView, .verbose, "deleteBackward()")

    let previousSelectedRange = selectedRange
    guard delegateAllowsChange(in: rangeDeletedBackward(from: previousSelectedRange), replacementText: "") else { return }
    defer { externalDelegate?.textViewDidChange?(self) }

    inputDelegateProxy.isSuspended = true // do not send selection changes during deleteBackwards, to not confuse third party keyboards
    defer {
      inputDelegateProxy.isSuspended = false
    }

    editor.dispatchCommand(type: .deleteCharacter, payload: true)

    if previousSelectedRange.length > 0 {
      // Expect new selection to be on the start of selection
      if selectedRange.location != previousSelectedRange.location || selectedRange.length != 0 {
        inputDelegateProxy.sendSelectionChangedIgnoringSuspended(self)
      }
    } else {
      // Expect new selection to be somewhere before selection -- we could calculate this by considering
      // unicode characters, but it would be complex. Let's do a best effort, since this situation is rare anyway.
      if selectedRange.length != 0 || selectedRange.location >= previousSelectedRange.location {
        inputDelegateProxy.sendSelectionChangedIgnoringSuspended(self)
      }
    }
  }

  override open func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) {
      if pasteboard.hasStrings {
        return true
      } else if !(pasteboard.data(forPasteboardType: LexicalConstants.pasteboardIdentifier)?.isEmpty ?? true) {
        return true
      } else if #available(iOS 14.0, *) {
        if !(pasteboard.data(forPasteboardType: (UTType.utf8PlainText.identifier))?.isEmpty ?? true) {
          return true
        }
      } else {
        if !(pasteboard.data(forPasteboardType: (kUTTypeUTF8PlainText as String))?.isEmpty ?? true) {
          return true
        }
      }
      return super.canPerformAction(action, withSender: sender)
    } else {
      return super.canPerformAction(action, withSender: sender)
    }
  }

  override open func copy(_ sender: Any?) {
    editor.dispatchCommand(type: .copy, payload: pasteboard)
  }

  override open func cut(_ sender: Any?) {
    guard delegateAllowsChange(in: selectedRange, replacementText: "") else { return }
    editor.dispatchCommand(type: .cut, payload: pasteboard)
    externalDelegate?.textViewDidChange?(self)
  }

  override open func paste(_ sender: Any?) {
    guard delegateAllowsChange(in: selectedRange, replacementText: pasteboard.string ?? "") else { return }
    editor.dispatchCommand(type: .paste, payload: pasteboard)
    externalDelegate?.textViewDidChange?(self)
  }

  override open func insertText(_ text: String) {
    editor.log(.UITextView, .verbose, "Text view selected range \(String(describing: self.selectedRange))")

    let expectedSelectionLocation = selectedRange.location + text.lengthAsNSString()
    guard delegateAllowsChange(in: editor.getNativeSelection().markedRange ?? selectedRange, replacementText: text) else { return }
    defer { externalDelegate?.textViewDidChange?(self) }

    inputDelegateProxy.isSuspended = true // do not send selection changes during insertText, to not confuse third party keyboards
    defer {
      inputDelegateProxy.isSuspended = false
    }

    guard let textStorage = textStorage as? TextStorage else {
      // This should never happen, we will always have a custom text storage.
      editor.log(.TextView, .error, "Missing custom text storage")
      return
    }

    textStorage.mode = TextStorageEditingMode.controllerMode
    editor.dispatchCommand(type: .insertText, payload: text)
    textStorage.mode = TextStorageEditingMode.none

    // check if we need to send a selectionChanged (i.e. something unexpected happened)
    if selectedRange.length != 0 || selectedRange.location != expectedSelectionLocation {
      inputDelegateProxy.sendSelectionChangedIgnoringSuspended(self)
    }
  }

  // MARK: Marked text

  override open func setAttributedMarkedText(_ markedText: NSAttributedString?, selectedRange: NSRange) {
    editor.log(.UITextView, .verbose)
    if let markedText {
      setMarkedTextInternal(markedText.string, selectedRange: selectedRange)
      externalDelegate?.textViewDidChange?(self)
    } else {
      unmarkText()
    }
  }

  override open func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    editor.log(.UITextView, .verbose)
    if let markedText {
      setMarkedTextInternal(markedText, selectedRange: selectedRange)
      externalDelegate?.textViewDidChange?(self)
    } else {
      unmarkText()
    }
  }

  private func setMarkedTextInternal(_ markedText: String, selectedRange: NSRange) {
    editor.log(.TextView, .verbose)
    guard let textStorage = textStorage as? TextStorage else {
      // This should never happen, we will always have a custom text storage.
      editor.log(.TextView, .error, "Missing custom text storage")
      super.setMarkedText(markedText, selectedRange: selectedRange)
      return
    }

    if markedText.isEmpty, let markedRange = editor.getNativeSelection().markedRange {
      textStorage.replaceCharacters(in: markedRange, with: "")
      return
    }

    let markedTextOperation = MarkedTextOperation(
      createMarkedText: true,
      selectionRangeToReplace: editor.getNativeSelection().markedRange ?? self.selectedRange,
      markedTextString: markedText,
      markedTextInternalSelection: selectedRange)

    let behaviourModificationMode = UpdateBehaviourModificationMode(suppressReconcilingSelection: true, suppressSanityCheck: true, markedTextOperation: markedTextOperation)

    textStorage.mode = TextStorageEditingMode.controllerMode
    defer {
      textStorage.mode = TextStorageEditingMode.none
    }
    do {
      // set composition key
      try editor.read {
        guard let selection = try getSelection() as? RangeSelection else {
          editor.log(.TextView, .error, "Could not get selection in setMarkedTextInternal()")
          throw LexicalError.invariantViolation("should have selection when starting marked text")
        }

        editor.compositionKey = selection.anchor.key
      }

      // insert text
      try onInsertTextFromUITextView(text: markedText, editor: editor, updateMode: behaviourModificationMode)
    } catch {
      let language = textInputMode?.primaryLanguage
      editor.log(.TextView, .error, "exception thrown, lang \(String(describing: language)): \(String(describing: error))")
      unmarkTextWithoutUpdate()
      return
    }
  }

  internal func setMarkedTextFromReconciler(_ markedText: NSAttributedString, selectedRange: NSRange) {
    editor.log(.TextView, .verbose)
    isUpdatingNativeSelection = true
    super.setAttributedMarkedText(markedText, selectedRange: selectedRange)
    interceptNextSelectionChangeAndReplaceWithRange = nil
    onSelectionChange(editor: editor)
    isUpdatingNativeSelection = false
    editor.compositionKey = nil
    showPlaceholderText()
  }

  override open func unmarkText() {
    editor.log(.UITextView, .verbose)
    let previousMarkedRange = editor.getNativeSelection().markedRange
    let oldIsUpdatingNative = isUpdatingNativeSelection
    isUpdatingNativeSelection = true
    super.unmarkText()
    isUpdatingNativeSelection = oldIsUpdatingNative
    if let previousMarkedRange {
      // find all nodes in selection. Mark dirty. Reconcile. This should correct all the attributes to be what we expect.
      do {
        try editor.update {
          guard let anchor = try pointAtStringLocation(previousMarkedRange.location, searchDirection: .forward, rangeCache: editor.rangeCache),
            let focus = try pointAtStringLocation(previousMarkedRange.location + previousMarkedRange.length, searchDirection: .forward, rangeCache: editor.rangeCache)
          else {
            return
          }

          let markedRangeSelection = RangeSelection(anchor: anchor, focus: focus, format: TextFormat())
          _ = try markedRangeSelection.getNodes().map { node in
            internallyMarkNodeAsDirty(node: node, cause: .userInitiated)
          }

          editor.compositionKey = nil
        }
      } catch {}
    }
  }

  internal func unmarkTextWithoutUpdate() {
    editor.log(.TextView, .verbose)
    super.unmarkText()
  }

  // MARK: - Lexical internal

  internal func presentDeveloperFacingError(message: String) {
    let alert = UIAlertController(title: "Lexical Error", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: UIAlertAction.Style.default, handler: nil))
    if let rootViewController = self.window?.rootViewController {
      rootViewController.present(alert, animated: true, completion: nil)
    }
  }

  internal func updateNativeSelection(from selection: RangeSelection) throws {
    isUpdatingNativeSelection = true
    defer { isUpdatingNativeSelection = false }
    let nativeSelection = try createNativeSelection(from: selection, editor: editor)

    if let range = nativeSelection.range {
      selectedRange = range
    }
  }

  internal func resetSelectedRange() {
    selectedRange = NSRange(location: 0, length: 0)
  }

  func defaultClearEditor() throws {
    editor.resetEditor(pendingEditorState: nil)
    editor.dispatchCommand(type: .clearEditor)
  }

  func setPlaceholderText(_ text: String, textColor: UIColor, font: UIFont) {
    placeholderLabel.text = text
    placeholderLabel.textColor = textColor
    placeholderLabel.font = font
    self.font = font

    showPlaceholderText()
  }

  func showPlaceholderText() {
    var shouldShow = false
    do {
      try editor.read {
        guard let root = getRoot() else { return }
        shouldShow = root.getTextContentSize() == 0
      }
      if !shouldShow {
        hidePlaceholderLabel()
        return
      }
      try editor.read {
        if canShowPlaceholder(isComposing: editor.isComposing()) {
          placeholderLabel.isHidden = false
          layoutIfNeeded()
        }
      }
    } catch {}
  }

  // MARK: - Private

  private func setUpPlaceholderLabel() {
    placeholderLabel.backgroundColor = .clear
    placeholderLabel.isHidden = true
    placeholderLabel.isAccessibilityElement = false
    placeholderLabel.numberOfLines = 1
    addSubview(placeholderLabel)
  }

  fileprivate func hidePlaceholderLabel() {
    placeholderLabel.isHidden = true
  }

  override open func becomeFirstResponder() -> Bool {
    let r = super.becomeFirstResponder()
    if r == true {
      onSelectionChange(editor: editor)
    }
    return r
  }
}

private final class TextViewDelegate: NSObject, UITextViewDelegate {
  weak var owner: TextView?

  override func responds(to selector: Selector!) -> Bool {
    super.responds(to: selector) || owner?.externalDelegate?.responds(to: selector) == true
  }

  override func forwardingTarget(for selector: Selector!) -> Any? {
    owner?.externalDelegate
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard let textView = textView as? TextView else { return }
    defer { textView.externalDelegate?.textViewDidChangeSelection?(textView) }

    if textView.isUpdatingNativeSelection {
      return
    }

    if let interception = textView.interceptNextSelectionChangeAndReplaceWithRange {
      textView.interceptNextSelectionChangeAndReplaceWithRange = nil
      textView.selectedRange = interception
      return
    }

    onSelectionChange(editor: textView.editor)
  }

  public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    guard let textView = textView as? TextView else { return false }

    textView.hidePlaceholderLabel()
    if let lexicalDelegate = textView.lexicalDelegate, !lexicalDelegate.textViewShouldChangeText(textView, range: range, replacementText: text) {
      return false
    }
    return textView.delegateAllowsChange(in: range, replacementText: text)
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    guard let textView = textView as? TextView else { return }
    textView.lexicalDelegate?.textViewDidBeginEditing(textView: textView)
    textView.externalDelegate?.textViewDidBeginEditing?(textView)
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    guard let textView = textView as? TextView else { return }
    textView.lexicalDelegate?.textViewDidEndEditing(textView: textView)
    textView.externalDelegate?.textViewDidEndEditing?(textView)
  }

  @available(iOS, deprecated: 17.0, message: "Use textView(_:primaryActionFor:defaultAction:) with UITextItem instead")
  public func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    guard let textView = textView as? TextView else { return false }

    let nativeSelection = NativeSelection(range: characterRange, affinity: .backward)
    try? textView.editor.update {
      guard let selection = try getSelection() as? RangeSelection else {
        // TODO: cope with non range selections. Should just make a range selection here
        return
      }
      try selection.applyNativeSelection(nativeSelection)
    }
    let handledByLexical = textView.editor.dispatchCommand(type: .linkTapped, payload: URL)

    if handledByLexical {
      return false
    }

    if !textView.isEditable {
      return true
    }

    return textView.lexicalDelegate?.textView(textView, shouldInteractWith: URL, in: characterRange, interaction: interaction) ?? false
  }
}

extension TextView {
  func delegateAllowsChange(in range: NSRange, replacementText text: String) -> Bool {
    externalDelegate?.textView?(self, shouldChangeTextIn: range, replacementText: text) ?? true
  }

  fileprivate func rangeDeletedBackward(from selection: NSRange) -> NSRange {
    guard selection.length == 0, selection.location > 0 else { return selection }
    return (text as NSString).rangeOfComposedCharacterSequence(at: selection.location - 1)
  }

  func invalidateLayout(forCharacterRange range: NSRange) {
    guard let textLayoutManager, let contentStorage = textLayoutManager.textContentManager as? NSTextContentStorage,
      let start = contentStorage.location(contentStorage.documentRange.location, offsetBy: range.location),
      let end = contentStorage.location(start, offsetBy: range.length),
      let textRange = NSTextRange(location: start, end: end)
    else { return }
    textLayoutManager.invalidateLayout(for: textRange)
    setNeedsLayout()
  }

  func positionAllDecorators() {
    guard let storage = textStorage as? TextStorage, !storage.decoratorPositionCache.isEmpty,
      let textLayoutManager, let contentStorage = textLayoutManager.textContentManager as? NSTextContentStorage
    else { return }
    // ponytail: lays out the whole document; fine for composer-sized text, switch to the viewport for long documents.
    textLayoutManager.ensureLayout(for: textLayoutManager.documentRange)
    for (key, cachedLocation) in storage.decoratorPositionCache {
      // The reconciler refreshes decoratorPositionCache only when a decorator is added or redecorated, so edits before it leave the cached location stale.
      let location = editor.rangeCache[key]?.location ?? cachedLocation
      positionDecorator(forKey: key, characterIndex: location, storage: storage, textLayoutManager: textLayoutManager, contentStorage: contentStorage)
    }
  }

  private func positionDecorator(forKey key: NodeKey, characterIndex: Int, storage: TextStorage, textLayoutManager: NSTextLayoutManager, contentStorage: NSTextContentStorage) {
    guard characterIndex < storage.length,
      let attachment = storage.attribute(.attachment, at: characterIndex, effectiveRange: nil) as? TextAttachment,
      attachment.key != nil, let attachmentEditor = attachment.editor,
      let location = contentStorage.location(contentStorage.documentRange.location, offsetBy: characterIndex),
      let fragment = textLayoutManager.textLayoutFragment(for: location)
    else {
      editor.log(.TextView, .warning, "no layout for decorator \(key)")
      return
    }
    let paragraphStart = contentStorage.offset(from: contentStorage.documentRange.location, to: fragment.rangeInElement.location)
    let offset = characterIndex - paragraphStart
    guard let line = fragment.textLineFragments.first(where: { NSLocationInRange(offset, $0.characterRange) }) ?? fragment.textLineFragments.last else { return }
    let bounds = line.typographicBounds
    let origin = CGPoint(
      x: fragment.layoutFragmentFrame.minX + bounds.minX + line.locationForCharacter(at: offset).x + textContainerInset.left,
      y: fragment.layoutFragmentFrame.minY + bounds.minY + line.glyphOrigin.y - attachment.bounds.height + textContainerInset.top)

    try? attachmentEditor.read {
      guard let view = decoratorView(forKey: key, createIfNecessary: true) else { return }
      view.isHidden = false
      view.frame = CGRect(origin: origin, size: attachment.bounds.size)
    }
  }
}
