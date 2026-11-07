/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

/// The LexicalViewDelegate allows customisation of certain things, most of which correspond to
/// UITextView delegate methods.
///
/// This protocol is somewhat a transitional thing. Eventually we would like to have every customisation point
/// for Lexical exposed through Lexical specific APIs, e.g. using Lexical commands and listeners as the customisation
/// mechanism.
public protocol LexicalViewDelegate: NSObjectProtocol {
  func textViewDidBeginEditing(textView: LexicalView)
  func textViewDidEndEditing(textView: LexicalView)
  func textViewShouldChangeText(_ textView: LexicalView, range: NSRange, replacementText text: String) -> Bool
  @available(iOS, deprecated: 17.0, message: "Use textView(_:primaryActionFor:defaultAction:) with UITextItem instead")
  func textView(_ textView: LexicalView, shouldInteractWith URL: URL, in selection: RangeSelection?, interaction: UITextItemInteraction) -> Bool
}

public extension LexicalViewDelegate {
  @available(iOS, deprecated: 17.0, message: "Use textView(_:primaryActionFor:defaultAction:) with UITextItem instead")
  func textView(_ textView: LexicalView, shouldInteractWith URL: URL, in selection: RangeSelection?, interaction: UITextItemInteraction) -> Bool {
    return true
  }
}

@objc public final class LexicalPlaceholderText: NSObject {
  public var text: String
  public var font: UIFont
  public var color: UIColor

  @objc public init(text: String, font: UIFont, color: UIColor) {
    self.text = text
    self.font = font
    self.color = color
  }
}

// MARK: -

/// A LexicalView is the view class that you interact with to use Lexical on iOS.
///
/// In order to avoid the possibility of accidentally using UITextView methods that Lexical does not expect, we've
/// encapsulated our UITextView subclass as a private property of LexicalView. The aim is to consider the UITextView
/// as below the abstraction level for developers using Lexical.
@objc public final class LexicalView: UIView, Frontend {
  var textLayoutWidth: CGFloat {
    return max(textView.bounds.width - textView.textContainerInset.left - textView.textContainerInset.right - 2 * textView.textContainer.lineFragmentPadding, 0)
  }

  /// The underlying UITextView. Note that this should not be accessed unless there's no way to do what you want
  /// using the Lexical API.
  @objc public let textView: TextView
  let responderForNodeSelection: ResponderForNodeSelection

  public init(editorConfig: EditorConfig, featureFlags: FeatureFlags, placeholderText: LexicalPlaceholderText? = nil, textViewType: TextView.Type = TextView.self) {
    self.textView = textViewType.init(editorConfig: editorConfig, featureFlags: featureFlags)
    self.textView.showsVerticalScrollIndicator = false
    self.textView.clipsToBounds = true
    self.placeholderText = placeholderText

    guard let textStorage = textView.textStorage as? TextStorage else {
      fatalError()
    }
    self.responderForNodeSelection = ResponderForNodeSelection(editor: textView.editor, textStorage: textStorage, nextResponder: textView)

    super.init(frame: .zero)

    self.textView.editor.frontend = self

    self.textView.lexicalDelegate = self
    if let placeholderText {
      self.textView.setPlaceholderText(placeholderText.text, textColor: placeholderText.color, font: placeholderText.font)
    }

    addSubview(self.textView)

    defaultViewMargins = textView.textContainerInset
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  // MARK: - Frontend protocol

  var textStorage: TextStorage {
    guard let textStorage = self.textView.textStorage as? TextStorage else {
      // this will never happen
      editor.log(.TextView, .error, "Text view had no text storage")
      fatalError()
    }
    return textStorage
  }

  func invalidateLayout(forCharacterRange range: NSRange) {
    textView.invalidateLayout(forCharacterRange: range)
  }

  @objc public var textContainerInsets: UIEdgeInsets {
    textView.textContainerInset
  }

  var nativeSelection: NativeSelection {
    if responderForNodeSelection.isFirstResponder {
      return NativeSelection(range: nil, opaqueRange: nil, affinity: .forward, markedRange: nil, markedOpaqueRange: nil, selectionIsNodeOrObject: true)
    }

    let selectionNSRange = textView.selectedRange
    let selectionOpaqueRange = textView.selectedTextRange
    let selectionAffinity = textView.selectionAffinity

    let markedOpaqueRange = textView.markedTextRange
    var markedNSRange: NSRange?
    if let markedOpaqueRange {
      let markedStart: Int = textView.offset(from: textView.beginningOfDocument, to: markedOpaqueRange.start)
      let markedEnd: Int = textView.offset(from: textView.beginningOfDocument, to: markedOpaqueRange.end)
      if markedStart != NSNotFound && markedEnd != NSNotFound {
        markedNSRange = NSRange(
          location: markedStart,
          length: markedEnd - markedStart)
      }
    }
    return NativeSelection(range: selectionNSRange, opaqueRange: selectionOpaqueRange, affinity: selectionAffinity, markedRange: markedNSRange, markedOpaqueRange: markedOpaqueRange, selectionIsNodeOrObject: false)
  }

  var isUpdatingNativeSelection: Bool {
    get {
      textView.isUpdatingNativeSelection
    }
    set {
      textView.isUpdatingNativeSelection = newValue
    }
  }

  var isEmpty: Bool {
    textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var viewForDecoratorSubviews: UIView? {
    textView
  }

  func moveNativeSelection(type: NativeSelectionModificationType, direction: UITextStorageDirection, granularity: UITextGranularity) {
    textView.isUpdatingNativeSelection = true

    let selection = nativeSelection

    guard let opaqueRange = selection.opaqueRange else {
      textView.isUpdatingNativeSelection = false
      return
    }

    var start = opaqueRange.start
    var end = opaqueRange.end

    switch direction {
    case .forward:
      end = textView.tokenizer.position(from: end, toBoundary: granularity, inDirection: UITextDirection(rawValue: UITextStorageDirection.forward.rawValue)) ?? end
      if type == .move {
        start = end
      }
    case .backward:
      start = textView.tokenizer.position(from: start, toBoundary: granularity, inDirection: UITextDirection(rawValue: UITextStorageDirection.backward.rawValue)) ?? start
      if type == .move {
        end = start
      }
    @unknown default:
      textView.isUpdatingNativeSelection = false
      return
    }

    let newTextRange = textView.textRange(from: start, to: end)
    textView.selectedTextRange = newTextRange
    textView.isUpdatingNativeSelection = false
  }

  func unmarkTextWithoutUpdate() {
    textView.unmarkTextWithoutUpdate()
  }

  func presentDeveloperFacingError(message: String) {
    textView.presentDeveloperFacingError(message: message)
  }

  func updateNativeSelection(from selection: BaseSelection) throws {
    guard let selection = selection as? RangeSelection else {
      // we don't have a range selection.
      _ = responderForNodeSelection.becomeFirstResponder()
      return
    }
    try textView.updateNativeSelection(from: selection)
  }

  func setMarkedTextFromReconciler(_ markedText: NSAttributedString, selectedRange: NSRange) {
    textView.setMarkedTextFromReconciler(markedText, selectedRange: selectedRange)
  }

  func resetSelectedRange() {
    textView.resetSelectedRange()
  }

  var interceptNextSelectionChangeAndReplaceWithRange: NSRange? {
    get {
      textView.interceptNextSelectionChangeAndReplaceWithRange
    }
    set {
      textView.interceptNextSelectionChangeAndReplaceWithRange = newValue
    }
  }

  // MARK: - Other stuff

  public weak var delegate: LexicalViewDelegate?
  var defaultViewMargins: UIEdgeInsets = .zero

  /// Sets the accessibility identifier of the underlying text view
  public var textViewAccessibilityIdentifier: String? {
    get {
      textView.accessibilityIdentifier
    }
    set {
      textView.accessibilityIdentifier = newValue
    }
  }

  /// Sets the accessibility label of the underlying text view
  public var textViewAccessibilityLabel: String? {
    get {
      textView.accessibilityLabel
    }
    set {
      textView.accessibilityLabel = newValue
    }
  }

  /// Sets the background colour of the underlying text view
  public var textViewBackgroundColor: UIColor? {
    get {
      textView.backgroundColor
    }
    set {
      textView.backgroundColor = newValue
    }
  }

  /// Configure the placeholder text shown by this Lexical view when there is no text.
  ///
  /// This needs a refactor. Currently the LexicalView supports setting the placeholder text as part of the initialiser, which
  /// works correctly. However setting the placeholder text later through this property will not properly proxy it through to the
  /// TextView. This is a bug and should be fixed.
  public var placeholderText: LexicalPlaceholderText?

  /// Returns the current selected text range according to the underlying UITextView.
  ///
  /// This needs a refactor. Probably this method should be deleted entirely (and the recommended approach for working with
  /// selections should be to go through the Lexical EditorState selection), unless a justification for its usefulness can be discovered.
  public var selectedTextRange: UITextRange? {
    get {
      textView.selectedTextRange
    }
  }

  /// Returns the attributed string fetched from the underlying text view's text storage.
  public var attributedText: NSAttributedString {
    get {
      textView.attributedText
    }
  }

  /// Returns the Lexical ``Editor`` owned by this LexicalView.
  ///
  /// This is the primary entry point for working with Lexical.
  @objc public var editor: Editor {
    get {
      textView.editor
    }
  }

  public var text: String {
    get {
      textView.text
    }
  }

  /// A proxy for the underlying `UITextView`'s `isScrollEnabled` property.
  public var isScrollEnabled: Bool {
    get {
      textView.isScrollEnabled
    }

    set {
      textView.isScrollEnabled = newValue
    }
  }

  /// A shortcut for getting the selection position.
  ///
  /// This method should maybe not exist, we should consider this holistically when auditing our
  /// selection APIs. Currently it exists in order to support a feature in Work Chat, but if that's the only
  /// reason, we could move this method into Work Chat specific code.
  public lazy var cursorPosition: UInt = {
    guard let toCursorPosition = textView.selectedTextRange?.end else { return 0 }

    return UInt(textView.offset(from: textView.beginningOfDocument, to: toCursorPosition))
  }()

  /// Returns the marked text range from the underlying UITextView.
  ///
  /// Marked Text corresponds to Lexical's `composition`.
  public var markedTextRange: UITextRange? {
    get {
      textView.markedTextRange
    }
  }

  /// Returns the current text input mode from the underlying UITextView.
  ///
  /// This can be used to access the input language.
  public var textViewInputMode: UITextInputMode? {
    get {
      textView.textInputMode
    }
  }

  /// A convenience method for working out if there is any text in the text view.
  public var isTextViewEmpty: Bool {
    get {
      textView.text.lengthAsNSString() == 0
    }
  }

  /// A proxy for the underlying UITextView's `isFirstResponder` method
  public var textViewIsFirstResponder: Bool {
    get {
      textView.isFirstResponder
    }
  }

  /// A proxy for the underlying UITextView's CALayer's `borderWidth` property
  public var textViewBorderWidth: CGFloat {
    get {
      textView.layer.borderWidth
    }

    set {
      textView.layer.borderWidth = newValue
    }
  }

  /// A proxy for the underlying UITextView's CALayer's `borderColor` property.
  ///
  /// If refactoring, maybe we should make this API take a UIColor rather than a CGColor, to better
  /// match the rest of our UIKit-based APIs.
  public var textViewBorderColor: CGColor? {
    get {
      textView.layer.borderColor
    }
    set {
      textView.layer.borderColor = newValue
    }
  }

  // MARK: - Init

  override public func layoutSubviews() {
    super.layoutSubviews()

    textView.frame = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height)
  }

  /// Convenience method to clear editor and show placeholder text
  public func clearLexicalView() throws {
    try textView.defaultClearEditor()
    textView.showPlaceholderText()

    // these are necessary to reset the keyboard back to capital letters
    textView.inputDelegate?.selectionWillChange(textView)
    textView.inputDelegate?.selectionDidChange(textView)
  }

  @discardableResult
  @objc public func textViewBecomeFirstResponder() -> Bool {
    return textView.becomeFirstResponder()
  }

  @discardableResult
  @objc public func textViewResignFirstResponder() -> Bool {
    return textView.resignFirstResponder()
  }

  public func hideAccessoryInput(_ hidden: Bool) {
    textView.inputAccessoryView?.isHidden = hidden
  }

  // MARK: - TextView

  public func getTextViewSelectedRange() -> UITextRange? {
    textView.selectedTextRange
  }

  public func updateTextViewContentOffset() {
    let bottomOffset = CGPoint(
      x: 0,
      y: textView.contentSize.height - textView.bounds.size.height + textView.contentInset.bottom)

    textView.setContentOffset(bottomOffset, animated: false)
  }

  public func shouldInvalidateTextViewHeight(maxHeight: CGFloat) -> Bool {
    let textViewSize = textView.sizeThatFits(CGSize(width: textView.bounds.size.width, height: CGFloat.greatestFiniteMagnitude))
    let calculatedHeight = min(maxHeight, textViewSize.height)

    return calculatedHeight != textView.bounds.size.height
  }

  public func calculateTextViewHeight(for containerSize: CGSize, padding: UIEdgeInsets) -> CGFloat {
    let fullHeight = textView.sizeThatFits(
      CGSize(
        width: containerSize.width - padding.left - padding.right,
        height: containerSize.height - padding.top - padding.bottom)
    ).height

    return fullHeight
  }

  public func showPlaceholderText() {
    textView.showPlaceholderText()
  }

  public func setTextContainerInset(_ margins: UIEdgeInsets) {
    textView.textContainerInset = margins
  }

  public func clearTextContainerInset() {
    textView.textContainerInset = defaultViewMargins
  }

  public func scrollSelectionToVisible() {
    textView.scrollRangeToVisible(textView.selectedRange)
  }

  // MARK: - Input Accessory View

  public func presentInputAccessoryView(view: UIView) {
    textView.inputAccessoryView = view
  }

  // MARK: - Paragraph Menu

  public func presentParagraphMenu(paragraphMenu: UIView) {
    UIView.performWithoutAnimation {
      textView.resignFirstResponder()
      textView.inputView = paragraphMenu
      _ = textView.becomeFirstResponder()
    }
  }

  public func dismissParagraphMenu() {
    UIView.performWithoutAnimation {
      textView.resignFirstResponder()
      textView.inputView = nil
      _ = textView.becomeFirstResponder()
    }
  }

  // MARK: - Autocomplete

  public func commitAutocompleteSuggestions() {
    textView.inputDelegate?.selectionWillChange(textView)
    textView.inputDelegate?.selectionDidChange(textView)
  }
}

// MARK: - LexicalTextViewDelegate

extension LexicalView: LexicalTextViewDelegate {
  @available(iOS, deprecated: 17.0, message: "Use textView(_:primaryActionFor:defaultAction:) with UITextItem instead")
  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    var selection: RangeSelection?

    do {
      try editor.read {
        selection = try getSelection() as? RangeSelection ?? createEmptyRangeSelection()
        try selection?.applySelectionRange(characterRange, affinity: .forward)
      }
    } catch {
      print("Error received in LexicalView(shouldInteractWith): \(error.localizedDescription)")
    }

    return delegate?.textView(self, shouldInteractWith: URL, in: selection, interaction: interaction) ?? false
  }

  func textViewDidBeginEditing(textView: TextView) {
    delegate?.textViewDidBeginEditing(textView: self)
  }

  func textViewDidEndEditing(textView: TextView) {
    delegate?.textViewDidEndEditing(textView: self)
  }

  func textViewShouldChangeText(_ textView: UITextView, range: NSRange, replacementText text: String) -> Bool {
    if let delegate {
      return delegate.textViewShouldChangeText(self, range: range, replacementText: text)
    }

    return true
  }
}
