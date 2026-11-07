/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

final class ResponderForNodeSelection: UIResponder, UIKeyInput {

  private weak var editor: Editor?
  private weak var textStorage: TextStorage?
  private weak var textView: UIResponder?

  init(editor: Editor, textStorage: TextStorage, nextResponder: UIResponder) {
    self.editor = editor
    self.textStorage = textStorage
    self.textView = nextResponder
  }

  var hasText: Bool {
    true // if this class is being used, _something_ is selected from a Lexical point of view!
  }

  func insertText(_ text: String) {
    guard let editor, let textStorage else {
      return
    }
    textStorage.mode = TextStorageEditingMode.controllerMode
    editor.dispatchCommand(type: .insertText, payload: text)
    textStorage.mode = TextStorageEditingMode.none
  }

  func deleteBackward() {
    editor?.dispatchCommand(type: .deleteCharacter, payload: true)
  }

  override var canBecomeFirstResponder: Bool {
    return true
  }

  override var next: UIResponder? {
    get {
      textView
    }
  }
}
