/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public final class NativeSelection {

  internal init(range: NSRange?, opaqueRange: UITextRange?, affinity: UITextStorageDirection, markedRange: NSRange?, markedOpaqueRange: UITextRange?, selectionIsNodeOrObject: Bool) {
    self.range = range
    self.opaqueRange = opaqueRange
    self.affinity = affinity
    self.markedRange = markedRange
    self.markedOpaqueRange = markedOpaqueRange
    self.selectionIsNodeOrObject = selectionIsNodeOrObject
  }

  internal init() {
    self.range = nil
    self.opaqueRange = nil
    self.affinity = .forward
    self.markedRange = nil
    self.markedOpaqueRange = nil
    self.selectionIsNodeOrObject = false // may reconsider this default later
  }

  public convenience init(range: NSRange, affinity: UITextStorageDirection) {
    self.init(
      range: range,
      opaqueRange: nil,
      affinity: affinity,
      markedRange: nil,
      markedOpaqueRange: nil,
      selectionIsNodeOrObject: false)
  }

  // if nil, there's no selection at all (i.e. no focus). If there's a location but length 0, then
  // the caret is being displayed.
  public let range: NSRange?

  // UITextRange can only be turned into a numerical range in the context of a text field. We're storing
  // both things in this object -- the opaque range is useful for modifying the selection, whereas the
  // numerical range is useful for matching up with our range cache.
  let opaqueRange: UITextRange?

  let affinity: UITextStorageDirection

  // marked text is the iOS term for what Lexical calls `composing`.
  // If these properties are nil, there is no marked text.
  // The opaque range comes straight from the text view; the range (as an NSRange) is calculated by us.
  let markedRange: NSRange?
  let markedOpaqueRange: UITextRange?

  // The selection is something that cannot be represented by a character range. Usually corresponds with
  // NodeSelection or similar within Lexical.
  let selectionIsNodeOrObject: Bool
}
