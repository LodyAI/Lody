/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

internal final class InputDelegateProxy: NSObject, UITextInputDelegate {
  internal weak var targetInputDelegate: UITextInputDelegate?
  internal var isSuspended: Bool = false

  func selectionWillChange(_ textInput: UITextInput?) {
    if let targetInputDelegate, isSuspended == false {
      targetInputDelegate.selectionWillChange(textInput)
    }
  }

  func selectionDidChange(_ textInput: UITextInput?) {
    if let targetInputDelegate, isSuspended == false {
      targetInputDelegate.selectionDidChange(textInput)
    }
  }

  func textWillChange(_ textInput: UITextInput?) {
    if let targetInputDelegate, isSuspended == false {
      targetInputDelegate.textWillChange(textInput)
    }
  }

  func textDidChange(_ textInput: UITextInput?) {
    if let targetInputDelegate, isSuspended == false {
      targetInputDelegate.textDidChange(textInput)
    }
  }

  // Note that this function only sends a didChange.
  internal func sendSelectionChangedIgnoringSuspended(_ textInput: UITextInput?) {
    if let targetInputDelegate {
      targetInputDelegate.selectionDidChange(textInput)
    }
  }

  #if canImport(UIKit, _version: "8444.1.105") && !targetEnvironment(macCatalyst)
  @available(iOS 18.4, *)
  func conversationContext(_ context: UIConversationContext?, didChange textInput: (any UITextInput)?) {
    if let targetInputDelegate {
      targetInputDelegate.conversationContext(context, didChange: textInput)
    }
  }
  #endif
}
