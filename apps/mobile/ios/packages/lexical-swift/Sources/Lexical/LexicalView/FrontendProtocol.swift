/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

/// A Lexical Frontend is an object that contains the TextKit stack used by Lexical, along with handling
/// user interactions, incoming events, etc. The Frontend protocol provides a hard boundary for what are
/// the responsibilities of the Editor vs the Frontend.
///
/// For users of Lexical, it is expected that they will instantiate a Frontend, which will in turn set up
/// the TextKit stack and then instantiate an Editor. The Frontend should provide access to the editor for
/// users of Lexical.
///
/// In the future it will be possible to use Lexical without a Frontend, in Headless mode (allowing editing
/// an EditorState but providing no conversion to NSAttributedString).
internal protocol Frontend: AnyObject {
  var textStorage: TextStorage { get }
  func invalidateLayout(forCharacterRange range: NSRange)
  var textContainerInsets: UIEdgeInsets { get }
  var editor: Editor { get }
  var nativeSelection: NativeSelection { get }
  var isFirstResponder: Bool { get }
  var viewForDecoratorSubviews: UIView? { get }
  var isEmpty: Bool { get }
  var isUpdatingNativeSelection: Bool { get set }
  var interceptNextSelectionChangeAndReplaceWithRange: NSRange? { get set }
  var textLayoutWidth: CGFloat { get }

  func moveNativeSelection(type: NativeSelectionModificationType, direction: UITextStorageDirection, granularity: UITextGranularity)
  func unmarkTextWithoutUpdate()
  func presentDeveloperFacingError(message: String)
  func updateNativeSelection(from selection: BaseSelection) throws
  func setMarkedTextFromReconciler(_ markedText: NSAttributedString, selectedRange: NSRange)
  func resetSelectedRange()
  func showPlaceholderText()
}
