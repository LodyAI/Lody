/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

public class TextAttachment: NSTextAttachment {
  public var key: NodeKey?
  weak var editor: Editor?

  override public func attachmentBounds(for attributes: [NSAttributedString.Key: Any], location: NSTextLocation, textContainer: NSTextContainer?, proposedLineFragment: CGRect, position: CGPoint) -> CGRect {
    guard let key, let editor else {
      return CGRect.zero
    }

    var bounds = CGRect.zero
    try? editor.read {
      guard let decoratorNode = getNodeByKey(key: key) as? DecoratorNode else {
        return
      }
      let size = decoratorNode.sizeForDecoratorView(textViewWidth: editor.frontend?.textLayoutWidth ?? CGFloat(0), attributes: attributes)
      bounds = CGRect(x: 0, y: 0, width: size.width, height: size.height)
    }

    self.bounds = bounds // cache the value so that decorator positioning can pull it back out later
    return bounds
  }

  // necessary to stop UIKit drawing a placeholder image
  override public func image(for bounds: CGRect, attributes: [NSAttributedString.Key: Any], location: NSTextLocation, textContainer: NSTextContainer?) -> UIImage? {
    return UIImage()
  }
}
