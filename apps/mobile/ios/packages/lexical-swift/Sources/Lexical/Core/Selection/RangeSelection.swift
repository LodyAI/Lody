/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public final class RangeSelection: BaseSelection {

  public var anchor: Point
  public var focus: Point
  public var dirty: Bool
  public var format: TextFormat
  public var style: String // TODO: add style support to iOS

  // MARK: - Init

  public init(anchor: Point, focus: Point, format: TextFormat) {
    self.anchor = anchor
    self.focus = focus
    self.dirty = false
    self.format = format
    self.style = ""

    anchor.selection = self
    focus.selection = self
  }

  // MARK: - Public

  public func isBackward() throws -> Bool {
    return try focus.isBefore(point: anchor)
  }

  public func isCollapsed() -> Bool {
    return anchor == focus
  }

  public func hasFormat(type: TextFormatType) -> Bool {
    return format.isTypeSet(type: type)
  }

  public func getCharacterOffsets(selection: RangeSelection) -> (Int, Int) {
    let anchor = selection.anchor
    let focus = selection.focus
    if anchor.type == .element && focus.type == .element && anchor.key == focus.key && anchor.offset == focus.offset {
      return (0, 0)
    }
    return (anchor.getCharacterOffset(), focus.getCharacterOffset())
  }

  public func getNodes() throws -> [Node] {
    let isBefore = try anchor.isBefore(point: focus)
    let firstPoint = isBefore ? anchor : focus
    let lastPoint = isBefore ? focus : anchor
    var firstNode = try firstPoint.getNode()
    var lastNode = try lastPoint.getNode()
    let startOffset = firstPoint.offset
    let endOffset = lastPoint.offset

    if let elementNode = firstNode as? ElementNode, let descendent = elementNode.getDescendantByIndex(index: startOffset) {
      firstNode = descendent
    }
    if let lastNodeUnwrapped = lastNode as? ElementNode {
      var lastNodeDescendant = lastNodeUnwrapped.getDescendantByIndex(index: endOffset)
      // We don't want to over-select, as node selection infers the child before
      // the last descendant, not including that descendant.
      if let lastNodeDescendantUnwrapped = lastNodeDescendant,
        lastNodeDescendantUnwrapped != firstNode,
        lastNodeUnwrapped.getChildAtIndex(index: endOffset) == lastNodeDescendantUnwrapped
      {
        lastNodeDescendant = lastNodeDescendantUnwrapped.getPreviousSibling()
      }
      lastNode = lastNodeDescendant ?? lastNodeUnwrapped
    }
    if firstNode == lastNode {
      if let firstNode = firstNode as? ElementNode, firstNode.getChildrenSize() > 0 {
        return []
      }
      return [firstNode]
    }
    return firstNode.getNodesBetween(targetNode: lastNode)
  }

  public func clone() -> BaseSelection {
    let selectionAnchor = createPoint(
      key: anchor.key,
      offset: anchor.offset,
      type: anchor.type)
    let selectionFocus = createPoint(
      key: focus.key,
      offset: focus.offset,
      type: focus.type)
    return RangeSelection(anchor: selectionAnchor, focus: selectionFocus, format: format)
  }

  public func setTextNodeRange(
    anchorNode: TextNode,
    anchorOffset: Int,
    focusNode: TextNode,
    focusOffset: Int
  ) {
    anchor.updatePoint(key: anchorNode.key, offset: anchorOffset, type: .text)
    focus.updatePoint(key: focusNode.key, offset: focusOffset, type: .text)
    dirty = true
  }

  public func extract() throws -> [Node] {
    var selectedNodes = try getNodes()
    guard let firstNode = selectedNodes.first else { return [] }

    let lastNode = selectedNodes.last
    let anchorOffset = anchor.getCharacterOffset()
    let focusOffset = focus.getCharacterOffset()

    if selectedNodes.isEmpty {
      return []
    } else if selectedNodes.count == 1 {
      guard let firstNode = firstNode as? TextNode else { return [firstNode] }

      let startOffset = anchorOffset > focusOffset ? focusOffset : anchorOffset
      let endOffset = anchorOffset > focusOffset ? anchorOffset : focusOffset
      let splitNodes = try firstNode.splitText(splitOffsets: [startOffset, endOffset])
      guard
        let node = startOffset == 0
          ? (!splitNodes.isEmpty ? splitNodes.first : nil)
          : (splitNodes.count > 1 ? splitNodes[1] : nil)
      else { return [] }
      return [node]
    }

    let isBefore = try anchor.isBefore(point: focus)

    if let firstNode = firstNode as? TextNode {
      let startOffset = isBefore ? anchorOffset : focusOffset
      if startOffset == firstNode.getTextContentSize() {
        selectedNodes.removeFirst()
      } else if startOffset != 0 {
        let splitNodes = try firstNode.splitText(splitOffsets: [startOffset])
        selectedNodes[0] = splitNodes[0]
      }
    }

    if let lastNode = lastNode as? TextNode {
      let lastNodeText = lastNode.getTextContent()
      let endOffset = isBefore ? focusOffset : anchorOffset

      if endOffset == 0 {
        selectedNodes.removeLast()
      } else if endOffset != lastNodeText.lengthAsNSString() {
        let splitNodes = try lastNode.splitText(splitOffsets: [endOffset])
        selectedNodes.append(splitNodes[0])
      }
    }

    return selectedNodes
  }

  public func insertRawText(text: String) throws {
    let parts = text.split { $0 == "\n" || $0 == "\r\n" }.map(String.init)
    if parts.count == 1 {
      try insertText(text)
    } else {
      var nodes = [Node]()
      let length = parts.count
      for (index, _) in parts.enumerated() {
        let part = parts[index]
        if !part.isEmpty {
          nodes.append(createTextNode(text: part))
        }
        if index != length - 1 {
          nodes.append(createLineBreakNode())
        }
      }
      _ = try insertNodes(nodes: nodes, selectStart: false)
    }
  }

  public func getTextContent() throws -> String {
    let nodes = try getNodes()
    if nodes.isEmpty {
      return ""
    }
    let firstNode = nodes[0]
    let lastNode = nodes[nodes.count - 1]
    let isBefore = try anchor.isBefore(point: focus)
    let anchorOffset = anchor.getCharacterOffset()
    let focusOffset = focus.getCharacterOffset()
    var textContent = ""
    var prevWasElement = true
    var textSliceAnchor = String()
    var textSliceFocus = String()

    for node in nodes {
      if let elementNode = node as? ElementNode, !elementNode.isInline() {
        if !prevWasElement {
          textContent += "\n"
        }
        if elementNode.isEmpty() {
          prevWasElement = false
        } else {
          prevWasElement = true
        }
      } else {
        prevWasElement = false
        if isTextNode(node) {
          var text = node.getTextContent()

          if node == firstNode {
            if node == lastNode {
              if anchorOffset < focusOffset {
                let anchorRange = NSRange(location: anchorOffset, length: focusOffset - anchorOffset)
                textSliceAnchor = (text as NSString).substring(with: anchorRange)
              } else {
                let focusRange = NSRange(location: focusOffset, length: anchorOffset - focusOffset)
                textSliceFocus = (text as NSString).substring(with: focusRange)
              }

              text = anchorOffset < focusOffset ? textSliceAnchor : textSliceFocus
            } else {
              if isBefore {
                textSliceAnchor = (text as NSString).substring(from: anchorOffset)
              } else {
                textSliceFocus = (text as NSString).substring(from: focusOffset)
              }

              text = isBefore ? textSliceAnchor : textSliceFocus
            }
          } else if node == lastNode {
            if isBefore {
              textSliceAnchor = (text as NSString).substring(to: focusOffset)
            } else {
              textSliceFocus = (text as NSString).substring(to: anchorOffset)
            }

            text = isBefore ? textSliceAnchor : textSliceFocus
          }

          textContent += text
        } else if (isDecoratorNode(node) || isLineBreakNode(node)) && (node != lastNode || !isCollapsed()) {
          textContent += node.getTextContent()
        }
      }
    }

    return textContent
  }

  public func insertText(_ text: String) throws {
    let anchor = anchor
    let focus = focus
    let anchorIsBefore = try anchor.isBefore(point: focus)
    let isBefore = isCollapsed() || anchorIsBefore
    let format = format
    let style = style

    if isBefore && anchor.type == .element {
      try transferStartingElementPointToTextPoint(start: anchor, end: focus, format: format, style: style)
    } else if !isBefore && focus.type == .element {
      try transferStartingElementPointToTextPoint(start: focus, end: anchor, format: format, style: style)
    }

    let selectedNodes = try getNodes()
    let selectedNodesLength = selectedNodes.count
    let firstPoint = isBefore ? anchor : focus
    let endPoint = isBefore ? focus : anchor
    let startOffset = firstPoint.offset
    let endOffset = endPoint.offset
    guard var firstNode = selectedNodes.first as? TextNode else {
      throw LexicalError.invariantViolation("insertText: first node is not a text node")
    }

    let firstNodeText = firstNode.getTextPart()
    let firstNodeTextLength = firstNodeText.lengthAsNSString()
    let firstNodeParent = try firstNode.getParentOrThrow()
    var lastNode = selectedNodes.last

    if isCollapsed() && startOffset == firstNodeTextLength && (firstNode.isSegmented() || firstNode.isToken() || !firstNode.canInsertTextAfter() || (!firstNodeParent.canInsertTextAfter() && firstNode.getNextSibling() == nil)) {
      var nextSibling = firstNode.getNextSibling() as? TextNode
      if nextSibling == nil || !(nextSibling?.canInsertTextBefore() ?? true) || isTokenOrSegmented(nextSibling) {
        nextSibling = TextNode()
        if let nextSibling {
          try nextSibling.setFormat(format: format)
          if !firstNodeParent.canInsertTextAfter() {
            try firstNodeParent.insertAfter(nodeToInsert: nextSibling)
          } else {
            try firstNode.insertAfter(nodeToInsert: nextSibling)
          }
        }
      }
      if let nextSibling {
        try nextSibling.select(anchorOffset: 0, focusOffset: 0)
        firstNode = nextSibling
      }
      if text.lengthAsNSString() > 0 {
        try insertText(text)
        return
      }
    } else if isCollapsed() && startOffset == 0 && (firstNode.isSegmented() || firstNode.isToken() || !firstNode.canInsertTextBefore() || (!firstNodeParent.canInsertTextBefore() && firstNode.getPreviousSibling() == nil)) {
      var prevSibling = firstNode.getPreviousSibling() as? TextNode
      if prevSibling == nil || isTokenOrSegmented(prevSibling) {
        prevSibling = TextNode()
        if let prevSibling {
          try prevSibling.setFormat(format: format)
          if !firstNodeParent.canInsertTextBefore() {
            try firstNodeParent.insertBefore(nodeToInsert: prevSibling)
          } else {
            try firstNode.insertBefore(nodeToInsert: prevSibling)
          }
        }
      }
      if let prevSibling {
        try prevSibling.select(anchorOffset: nil, focusOffset: nil)
        firstNode = prevSibling
      }
      if text.lengthAsNSString() > 0 {
        try insertText(text)
        return
      }
    } else if firstNode.isSegmented() && startOffset != firstNodeTextLength {
      let textNode = TextNode(text: firstNode.getTextPart())
      try textNode.setFormat(format: format)
      try firstNode.replace(replaceWith: textNode)
      firstNode = textNode
    } else if !isCollapsed() && text.lengthAsNSString() > 0 {
      // When the firstNode or lastNode parents are elements that
      // do not allow text to be inserted before or after, we first
      // clear the content. Then we normalize selection, then insert
      // the new content.
      let lastNodeParent = lastNode?.getParent()

      if !firstNodeParent.canInsertTextBefore() || !firstNodeParent.canInsertTextAfter() || (lastNodeParent != nil && (!(lastNodeParent?.canInsertTextBefore() ?? true) || !(lastNodeParent?.canInsertTextAfter() ?? true))) {
        try insertText("")
        try normalizeSelectionPointsForBoundaries(anchor: self.anchor, focus: self.focus, lastSelection: nil)
        try insertText(text)
        return
      }
    }

    if selectedNodesLength == 1 {
      if firstNode.isToken() {
        let textNode = TextNode(text: text)
        try textNode.select(anchorOffset: nil, focusOffset: nil)
        try firstNode.replace(replaceWith: textNode)
        return
      }
      let firstNodeFormat = firstNode.getFormat()
      let firstNodeStyle = firstNode.getStyle()

      if startOffset == endOffset && (firstNodeFormat != format || firstNodeStyle != style) {
        if firstNode.getTextPart().lengthAsNSString() == 0 {
          try firstNode.setFormat(format: format)
          try firstNode.setStyle(style)
        } else {
          let textNode = TextNode(text: text)
          try textNode.setFormat(format: format)
          try textNode.setStyle(style)
          try textNode.select(anchorOffset: nil, focusOffset: nil)
          if startOffset == 0 {
            try firstNode.insertBefore(nodeToInsert: textNode)
          } else {
            if let targetNode = try firstNode.splitText(splitOffsets: [startOffset]).first {
              try targetNode.insertAfter(nodeToInsert: textNode)
            }
          }
          // When composing, we need to adjust the anchor offset so that
          // we correctly replace that right range.
          if textNode.isComposing() && self.anchor.type == .text {
            self.anchor.offset -= text.lengthAsNSString()
          }
          return
        }
      }
      let delCount = endOffset - startOffset

      firstNode = try firstNode.spliceText(offset: startOffset, delCount: delCount, newText: text, moveSelection: true)
      if firstNode.getTextPart().lengthAsNSString() == 0 {
        try firstNode.remove()
      } else if self.anchor.type == .text {
        if firstNode.isComposing() {
          // When composing, we need to adjust the anchor offset so that
          // we correctly replace that right range.
          self.anchor.offset -= text.lengthAsNSString()
        } else {
          self.format = firstNodeFormat
          self.style = firstNodeStyle
        }
      }
    } else {
      var markedNodeKeysForKeep = Set(firstNode.getParentKeys()).union(lastNode?.getParentKeys() ?? [])

      // We have to get the parent elements before the next section,
      // as in that section we might mutate the lastNode.
      let firstElement = try firstNode.getParentOrThrow()
      var lastElement: ElementNode? = lastNode is ElementNode ? lastNode as? ElementNode : try lastNode?.getParentOrThrow()
      var lastElementChild = lastNode

      // If the last element is inline, we should instead look at getting
      // the nodes of its parent, rather than itself. This behavior will
      // then better match how text node insertions work. We will need to
      // also update the last element's child accordingly as we do this.
      if firstElement != lastElement && (lastElement?.isInline() ?? false) {
        // Keep traversing till we have a non-inline element parent.
        repeat {
          lastElementChild = lastElement
          lastElement = try lastElement?.getParentOrThrow()
        } while lastElement?.isInline() ?? false
      }

      // Handle mutations to the last node.
      if (endPoint.type == .text && (endOffset != 0 || (lastNode?.getTextContent().lengthAsNSString() == 0))) || (endPoint.type == .element && lastNode?.getIndexWithinParent() ?? 0 < endOffset) {
        if let lastNodeAsTextNode = lastNode as? TextNode,
          !lastNodeAsTextNode.isToken(),
          endOffset != lastNodeAsTextNode.getTextContentSize()
        {
          if lastNodeAsTextNode.isSegmented() {
            let textNode = TextNode(text: lastNodeAsTextNode.getTextPart())
            try lastNodeAsTextNode.replace(replaceWith: textNode)
            lastNode = textNode
          }
          if let lastNodeAsTextNode = lastNode as? TextNode {
            lastNode = try lastNodeAsTextNode.spliceText(offset: 0, delCount: endOffset, newText: "")
            if let lastNode {
              markedNodeKeysForKeep.insert(lastNode.key)
            }
          }
        } else {
          let lastNodeParent = try lastNode?.getParentOrThrow()
          if let lastNodeParent,
            !lastNodeParent.canBeEmpty(),
            lastNodeParent.getChildrenSize() == 1
          {
            try lastNodeParent.remove()
          } else {
            try lastNode?.remove()
          }
        }
      } else {
        if let lastNode {
          markedNodeKeysForKeep.insert(lastNode.key)
        }
      }

      // Either move the remaining nodes of the last parent to after
      // the first child, or remove them entirely. If the last parent
      // is the same as the first parent, this logic also works.
      let lastNodeChildren = lastElement?.getChildren() ?? []
      let selectedNodesSet = Set(selectedNodes)
      let firstAndLastElementsAreEqual = firstElement == lastElement

      // We choose a target to insert all nodes after. In the case of having
      // and inline starting parent element with a starting node that has no
      // siblings, we should insert after the starting parent element, otherwise
      // we will incorrectly merge into the starting parent element.
      // TODO: should we keep on traversing parents if we're inside another
      // nested inline element?
      let insertionTarget = firstElement.isInline() && firstNode.getNextSibling() == nil ? firstElement : firstNode

      for (_, lastNodeChild) in lastNodeChildren.enumerated().reversed() {
        if lastNodeChild.isSameNode(firstNode) || ((lastNodeChild as? ElementNode)?.isParentOf(firstNode) ?? false) {
          break
        }

        if lastNodeChild.isAttached() {
          if !selectedNodesSet.contains(lastNodeChild) || lastNodeChild == lastElementChild {
            if !firstAndLastElementsAreEqual {
              try insertionTarget.insertAfter(nodeToInsert: lastNodeChild)
            }
          } else {
            try lastNodeChild.remove()
          }
        }
      }

      if !firstAndLastElementsAreEqual {
        // Check if we have already moved out all the nodes of the
        // last parent, and if so, traverse the parent tree and mark
        // them all as being able to deleted too.
        var parent: ElementNode? = lastElement
        var lastRemovedParent: ElementNode?

        while let thisParent = parent {
          let children = thisParent.getChildren()
          let childrenLength = children.count
          if childrenLength == 0 || children.last == lastRemovedParent {
            markedNodeKeysForKeep.remove(thisParent.key)
            lastRemovedParent = thisParent
          }
          parent = thisParent.getParent()
        }
      }

      // Ensure we do splicing after moving of nodes, as splicing
      // can have side-effects (in the case of hashtags).
      if !firstNode.isToken() {
        firstNode = try firstNode.spliceText(offset: startOffset, delCount: firstNodeTextLength - startOffset, newText: text, moveSelection: true)
        if firstNode.getTextContent().lengthAsNSString() == 0 {
          try firstNode.remove()
        } else if firstNode.isComposing() && self.anchor.type == .text {
          // When composing, we need to adjust the anchor offset so that
          // we correctly replace that right range.
          self.anchor.offset -= text.lengthAsNSString()
        }
      } else if startOffset == firstNodeTextLength {
        try firstNode.select(anchorOffset: nil, focusOffset: nil)
      } else {
        let textNode = TextNode(text: text)
        try textNode.select(anchorOffset: nil, focusOffset: nil)
        try firstNode.replace(replaceWith: textNode)
      }

      for selectedNode in selectedNodes.dropFirst() {
        let key = selectedNode.key
        if !markedNodeKeysForKeep.contains(key) {
          try selectedNode.remove()
        }
      }
    }
  }

  @discardableResult
  public func insertNodes(nodes: [Node], selectStart: Bool = false) throws -> Bool {
    if !isCollapsed() {
      try removeText()
    }

    let anchor = anchor
    let anchorOffset = anchor.offset
    let anchorNode = try anchor.getNode()
    var target = anchorNode

    if anchor.type == .element {
      if let element = try anchor.getNode() as? ElementNode {
        if let placementNode = element.getChildAtIndex(index: anchorOffset - 1) {
          target = placementNode
        } else {
          target = element
        }
      }
    }

    var siblings: [Node] = []

    let nextSiblings = anchorNode.getNextSiblings()
    guard let topLevelElement = try? anchorNode.getTopLevelElementOrThrow() else {
      throw LexicalError.internal("Could not get top level element")
    }

    if let anchorNode = anchorNode as? TextNode {
      let textContent = anchorNode.getTextPart()

      if anchorOffset == 0 && textContent.lengthAsNSString() != 0 {
        if let prevSibling = anchorNode.getPreviousSibling() {
          target = prevSibling
        } else {
          target = try anchorNode.getParentOrThrow()
        }

        siblings.append(anchorNode)
      } else if anchorOffset == textContent.lengthAsNSString() {
        target = anchorNode
      } else if isTokenOrInert(anchorNode) {
        return false
      } else {
        let danglingTextNodes = try anchorNode.splitText(splitOffsets: [anchorOffset])
        if danglingTextNodes.count == 1 {
          target = danglingTextNodes[0]
        } else {
          target = danglingTextNodes[0]
          siblings.append(contentsOf: Array(danglingTextNodes.dropFirst()))
        }
      }
    }

    let startingNode = target

    siblings.append(contentsOf: nextSiblings)

    let firstNode = nodes.first
    var didReplaceOrMerge = false

    for node in nodes {
      if let node = node as? ElementNode {
        if node == firstNode {
          if let unwrappedTarget = target as? ElementNode,
            unwrappedTarget.isEmpty() && unwrappedTarget.canReplaceWith(replacement: node)
          {
            try target.replace(replaceWith: node)
            target = node
            didReplaceOrMerge = true
            continue
          }

          let firstDescendant = node.getFirstDescendant()

          if isLeafNode(firstDescendant) {
            guard var element = try firstDescendant?.getParentOrThrow() else {
              throw LexicalError.internal("Could not get firstDescendant's parent")
            }

            while element.isInline() {
              element = try element.getParentOrThrow()
            }

            let children = element.getChildren()

            if let target = target as? ElementNode {
              for child in children {
                try target.append([child])
              }
            } else {
              for child in children.reversed() {
                try target.insertAfter(nodeToInsert: child)
              }

              target = try target.getParentOrThrow()
            }

            try element.remove()
            didReplaceOrMerge = true

            if element === node {
              continue
            }
          }
        }

        if isTextNode(target) {
          target = topLevelElement
        }
      } else if didReplaceOrMerge && !isDecoratorNode(node) && isRootNode(node: target.getParent()) {
        throw LexicalError.invariantViolation("insertNodes: cannot insert a non-element into a root node")
      }

      didReplaceOrMerge = false

      if let unwrappedTarget = target as? ElementNode {
        if let node = node as? DecoratorNode, node.isTopLevel() {
          target = try target.insertAfter(nodeToInsert: node)
        } else if !isElementNode(node: node) {
          if let firstChild = unwrappedTarget.getFirstChild() {
            try firstChild.insertBefore(nodeToInsert: node)
          } else {
            try unwrappedTarget.append([node])
          }

          target = node
        } else {
          if let elementNode = node as? ElementNode {
            if !elementNode.canBeEmpty() && elementNode.isEmpty() {
              continue
            }

            target = try target.insertAfter(nodeToInsert: node)
          }
        }
      } else if !isElementNode(node: node) || isDecoratorNode(node) && (node as? DecoratorNode)?.isTopLevel() == true {
        target = try target.insertAfter(nodeToInsert: node)
      } else {
        target = try node.getParentOrThrow() // Re-try again with the target being the parent
        continue
      }
    }

    if selectStart {
      if isTextNode(startingNode) {
        if let startingNode = startingNode as? ElementNode {
          try startingNode.select(anchorOffset: nil, focusOffset: nil)
        }
      } else {
        let prevSibling = target.getPreviousSibling()

        if isTextNode(prevSibling) {
          if let prevSibling = prevSibling as? ElementNode {
            try prevSibling.select(anchorOffset: nil, focusOffset: nil)
          }
        } else {
          let index = target.getIndexWithinParent()
          try target.getParentOrThrow().select(anchorOffset: index, focusOffset: index)
        }
      }
    }

    if let unwrappedTarget = target as? ElementNode {
      let lastChild = unwrappedTarget.getLastDescendant()

      if !selectStart {
        if lastChild == nil {
          try unwrappedTarget.select(anchorOffset: nil, focusOffset: nil)
        } else if let lastChild = lastChild as? TextNode {
          try lastChild.select(anchorOffset: nil, focusOffset: nil)
        } else {
          _ = try lastChild?.selectNext(anchorOffset: nil, focusOffset: nil)
        }
      }

      if !siblings.isEmpty {
        for sibling in siblings.reversed() {
          let prevParent = try sibling.getParentOrThrow()

          if let unwrappedTarget = target as? ElementNode, !isElementNode(node: sibling) {
            try unwrappedTarget.append([sibling])
            target = sibling
          } else {
            if let elementSibling = sibling as? ElementNode, !elementSibling.canInsertAfter(node: target) {
              let prevParentClone = prevParent.clone()

              try prevParentClone.append([elementSibling])
              try target.insertAfter(nodeToInsert: prevParentClone)
            } else {
              try target.insertAfter(nodeToInsert: sibling)
            }
          }

          if prevParent.isEmpty() && !prevParent.canBeEmpty() {
            try prevParent.remove()
          }
        }
      }
    } else if !selectStart {
      if let target = target as? TextNode {
        try target.select(anchorOffset: nil, focusOffset: nil)
      } else {
        let element = try target.getParentOrThrow()
        if let index = target.getIndexWithinParent() {
          try element.select(anchorOffset: index + 1, focusOffset: index + 1)
        }
      }
    }
    return true
  }

  public func getPlaintext() throws -> String {
    // @alexmattice - replace this with a version driven off a depth first search
    guard let editor = getActiveEditor() else {
      throw LexicalError.invariantViolation("Requires editor")
    }

    let selection = editor.getNativeSelection()

    if let range = selection.range, let textStorage = editor.textStorage {
      return textStorage.attributedSubstring(from: range).string
    } else {
      return ""
    }
  }

  // MARK: - Internal

  public func insertParagraph() throws {
    if !isCollapsed() {
      try removeText()
    }

    let anchorOffset = anchor.offset
    var currentElement: ElementNode
    var nodesToMove = [Node]()
    var siblingsToMove = [Node]()

    if anchor.type == .text {
      guard let anchorNode = try anchor.getNode() as? TextNode else { return }

      nodesToMove = anchorNode.getNextSiblings().reversed()
      currentElement = try anchorNode.getParentOrThrow()
      let isInline = currentElement.isInline()
      let textContentLength = isInline ? currentElement.getTextContentSize() : anchorNode.getTextContentSize()

      if anchorOffset == 0 {
        nodesToMove.append(anchorNode)
      } else {
        if isInline {
          // For inline nodes, we want to move all the siblings to the new paragraph
          // if selection is at the end, we just move the siblings. Otherwise, we also
          // split the text node and add that and it's siblings below.
          siblingsToMove = currentElement.getNextSiblings()
        }
        if anchorOffset != textContentLength && (!isInline || anchorOffset != textContentLength) {
          let splitNodes = try anchorNode.splitText(splitOffsets: [anchorOffset])
          if splitNodes.count >= 2 {
            nodesToMove.append(splitNodes[1])
          }
        }
      }
    } else {
      let newCurrentElement = try anchor.getNode() as? ElementNode
      guard let newCurrentElement else {
        getActiveEditor()?.log(.editor, .error, "Expected an element node")
        return
      }
      currentElement = newCurrentElement

      if let elementNode = currentElement as? RootNode {
        let paragraph = createParagraphNode()
        try paragraph.select(anchorOffset: nil, focusOffset: nil)

        if let child = elementNode.getChildAtIndex(index: anchorOffset) {
          try child.insertBefore(nodeToInsert: paragraph)
        } else {
          try elementNode.append([paragraph])
        }

        return
      }

      nodesToMove = currentElement.getChildren()
      nodesToMove.removeSubrange(0..<anchorOffset)
      nodesToMove.reverse()
    }

    let nodesToMoveLength = nodesToMove.count
    if anchorOffset == 0 && nodesToMoveLength > 0 && currentElement.isInline() {
      let parent = try currentElement.getParentOrThrow()
      let newElement = try parent.insertNewAfter(selection: self)
      if let newElement = newElement as? ElementNode {
        let children = parent.getChildren()
        for child in children {
          try newElement.append([child])
        }
      }
      return
    }

    let newElement = try currentElement.insertNewAfter(selection: self)
    if newElement == nil {
      // Handle as a line break insertion
      try insertLineBreak(selectStart: false)
    } else if let newElement = newElement as? ElementNode {
      // If we're at the beginning of the current element, move the new element to be before the current element
      let currentElementFirstChild = currentElement.getFirstChild()
      let anchorNode = try anchor.getNode()
      let isBeginning = anchorOffset == 0 && (currentElement == anchorNode || (currentElementFirstChild == anchorNode))
      if isBeginning && nodesToMoveLength > 0 {
        try currentElement.insertBefore(nodeToInsert: newElement)
        return
      }

      var firstChild: Node?
      let siblingsToMoveLength = siblingsToMove.count
      let parent = try newElement.getParentOrThrow()

      // For inline elements, we append the siblings to the parent.
      if siblingsToMoveLength > 0 {
        for sibling in siblingsToMove {
          try parent.append([sibling])
        }
      }
      if nodesToMoveLength != 0 {
        for nodeToMove in nodesToMove {
          if let firstChild {
            try firstChild.insertBefore(nodeToInsert: nodeToMove)
          } else {
            try newElement.append([nodeToMove])
          }
          firstChild = nodeToMove
        }
      }

      if !newElement.canBeEmpty() && newElement.getChildrenSize() == 0 {
        try newElement.selectPrevious(anchorOffset: nil, focusOffset: nil)
        try newElement.remove()
      } else {
        _ = try newElement.selectStart()
      }
    }
  }

  // Note that "line break" is different to "paragraph", and pressing return/enter does the latter.
  public func insertLineBreak(selectStart: Bool) throws {
    let lineBreakNode = createLineBreakNode()

    if anchor.type == .element {
      guard let element = try anchor.getNode() as? ElementNode else { return }
      if isRootNode(node: element) {
        try insertParagraph()
      }
    }
    if selectStart {
      _ = try insertNodes(nodes: [lineBreakNode], selectStart: true)
    } else {
      if try insertNodes(nodes: [lineBreakNode], selectStart: false) {
        _ = try lineBreakNode.selectNext(anchorOffset: 0, focusOffset: 0)
      }
    }
  }

  public func deleteCharacter(isBackwards: Bool) throws {
    let wasCollapsed = isCollapsed()
    if isCollapsed() {
      let anchor = self.anchor
      let focus = self.focus
      var anchorNode: Node? = try anchor.getNode()
      if !isBackwards {
        if let anchorNode = anchorNode as? ElementNode,
          anchor.type == .element,
          anchor.offset == anchorNode.getChildrenSize()
        {
          let parent = anchorNode.getParent()
          let nextSibling = anchorNode.getNextSibling() ?? parent?.getNextSibling()
          if let nextSibling = nextSibling as? ElementNode, nextSibling.isShadowRoot() {
            return
          }
        } else if let anchorNode = anchorNode as? ElementNode, anchor.type == .text && anchor.offset == anchorNode.getTextContentSize() {
          // repeating the code in the previous condition, as porting the JS code with a typecast in the 'if' statement was difficult in Swift
          let parent = anchorNode.getParent()
          let nextSibling = anchorNode.getNextSibling() ?? parent?.getNextSibling()
          if let nextSibling = nextSibling as? ElementNode, nextSibling.isShadowRoot() {
            return
          }
        }
      }

      // Handle the deletion around decorators.
      let possibleNode = try getAdjacentNode(focus: focus, isBackward: isBackwards)
      if let possibleNode = possibleNode as? DecoratorNode, !possibleNode.isIsolated() {
        // Make it possible to move selection from range selection to
        // node selection on the node.
        if /* possibleNode.isKeyboardSelectable() && */
        let anchorNode = anchorNode as? ElementNode,
          anchorNode.getChildrenSize() == 0
        {
          try anchorNode.remove()
          let nodeSelection = NodeSelection(nodes: Set([possibleNode.key]))
          try setSelection(nodeSelection)
        } else {
          try possibleNode.remove()
          if let editor = getActiveEditor() {
            editor.dispatchCommand(type: .selectionChange)
          }
        }
        return
      } else if !isBackwards, let possibleNode = possibleNode as? ElementNode, let anchorNode = anchorNode as? ElementNode, anchorNode.isEmpty() {
        try anchorNode.remove()
        try possibleNode.selectStart()
        return
      }
      try modify(alter: .extend, isBackward: isBackwards, granularity: .character)

      if !isCollapsed() {
        let focusNode = focus.type == .text ? try focus.getNode() : nil
        anchorNode = anchor.type == .text ? try anchor.getNode() : nil

        if let focusNode = focusNode as? TextNode, focusNode.isSegmented() {
          let offset = focus.getOffset()
          let textContentSize = focusNode.getTextContentSize()
          if let anchorNode, focusNode.isSameNode(anchorNode) || (isBackwards && offset != textContentSize) || (!isBackwards && offset != 0) {
            try removeSegment(node: focusNode, isBackward: isBackwards, offset: offset)
            return
          }
        } else if let anchorNode = anchorNode as? TextNode, anchorNode.isSegmented() {
          let offset = anchor.getOffset()
          let textContentSize = anchorNode.getTextContentSize()
          if let focusNode, anchorNode.isSameNode(focusNode) || (isBackwards && offset != 0) || (!isBackwards && offset != textContentSize) {
            try removeSegment(node: anchorNode, isBackward: isBackwards, offset: offset)
            return
          }
        }
        // Lexical JS calls updateCaretSelectionForUnicodeCharacter() here. We don't need to do that,
        // since our modify() accurately accounts for unicode boundaries
      } else if isBackwards && anchor.offset == 0 {
        // Special handling around rich text nodes
        let element = anchor.type == .element ? try anchor.getNode() : try anchor.getNode().getParentOrThrow()
        if let element = element as? ElementNode, try element.collapseAtStart(selection: self) {
          return
        }
      }
    }

    try removeText()

    if isBackwards && !wasCollapsed && isCollapsed() && self.anchor.type == .element && self.anchor.offset == 0 {
      if let anchorNode = try self.anchor.getNode() as? ElementNode,
        anchorNode.isEmpty(),
        isRootNode(node: anchorNode.getParent()),
        anchorNode.getIndexWithinParent() == 0
      {
        try anchorNode.collapseAtStart(selection: self)
      }
    }
  }

  public func deleteWord(isBackwards: Bool) throws {
    if isCollapsed() {
      try modify(alter: .extend, isBackward: isBackwards, granularity: .word)
    }
    try removeText()
  }

  public func deleteLine(isBackwards: Bool) throws {
    if isCollapsed() {
      try modify(alter: .extend, isBackward: isBackwards, granularity: .line)
    }
    try removeText()
  }

  internal func removeText() throws {
    try insertText("")
  }

  internal func modify(alter: NativeSelectionModificationType, isBackward: Bool, granularity: UITextGranularity) throws {
    let collapse = alter == .move

    guard let editor = getActiveEditor() else {
      throw LexicalError.invariantViolation("Cannot be called outside update loop")
    }

    editor.moveNativeSelection(
      type: alter,
      direction: isBackward ? .backward : .forward,
      granularity: granularity)

    let nativeSelection = editor.getNativeSelection()

    try applyNativeSelection(nativeSelection)

    // Because a range works on start and end, we might need to flip
    // to match the range has specifically.

    if let range = nativeSelection.range {
      let anchorLocation = isBackward ? range.location + range.length : range.location
      let focusLocation = isBackward ? range.location : range.location + range.length

      if !collapse && anchorLocation != anchor.offset || focusLocation != focus.offset {
        swapPoints()
      }
    }
  }

  // This method is the equivalent of applyDOMRange()
  public func applyNativeSelection(_ nativeSelection: NativeSelection) throws {
    guard let range = nativeSelection.range else { return }
    try applySelectionRange(range, affinity: range.length == 0 ? .backward : nativeSelection.affinity)
  }

  internal func applySelectionRange(_ range: NSRange, affinity: UITextStorageDirection) throws {
    guard let editor = getActiveEditor() else {
      throw LexicalError.invariantViolation("Calling applyNativeSelection when no active editor")
    }

    let anchorOffset = affinity == .forward ? range.location : range.location + range.length
    let focusOffset = affinity == .forward ? range.location + range.length : range.location

    if let anchor = try pointAtStringLocation(anchorOffset, searchDirection: affinity, rangeCache: editor.rangeCache),
      let focus = try pointAtStringLocation(focusOffset, searchDirection: affinity, rangeCache: editor.rangeCache)
    {
      self.anchor = anchor
      self.focus = focus
    }
  }

  init?(nativeSelection: NativeSelection) {
    guard let range = nativeSelection.range, let editor = getActiveEditor(), !nativeSelection.selectionIsNodeOrObject else { return nil }
    let affinity = range.length == 0 ? .backward : nativeSelection.affinity

    let anchorOffset = affinity == .forward ? range.location : range.location + range.length
    let focusOffset = affinity == .forward ? range.location + range.length : range.location

    guard let anchor = try? pointAtStringLocation(anchorOffset, searchDirection: affinity, rangeCache: editor.rangeCache),
      let focus = try? pointAtStringLocation(focusOffset, searchDirection: affinity, rangeCache: editor.rangeCache)
    else {
      return nil
    }

    self.anchor = anchor
    self.focus = focus
    self.dirty = false
    self.format = TextFormat()
    self.style = ""
  }

  internal func formatText(formatType: TextFormatType) throws {
    if isCollapsed() {
      toggleFormat(type: formatType)
      return
    }

    let selectedNodes = try getNodes()
    guard var firstNode = selectedNodes.first, let lastNode = selectedNodes.last else { return }

    var firstNextFormat = TextFormat()
    for node in selectedNodes {
      if let node = node as? TextNode {
        firstNextFormat = node.getFormatFlags(type: formatType)
        break
      }
    }

    let isBefore = try anchor.isBefore(point: focus)
    var startOffset = isBefore ? anchor.offset : focus.offset
    var endOffset = isBefore ? focus.offset : anchor.offset

    // This is the case where the user only selected the very end of the
    // first node so we don't want to include it in the formatting change.
    if startOffset == firstNode.getTextPartSize() {
      if let nextSibling = firstNode.getNextSibling() as? TextNode {
        // we basically make the second node the firstNode, changing offsets accordingly
        anchor.offset = 0
        startOffset = 0
        firstNode = nextSibling
        firstNextFormat = nextSibling.getFormat()
      }
    }

    // This is the case where we only selected a single node
    if firstNode === lastNode {
      if let textNode = firstNode as? TextNode {
        if anchor.type == .element && focus.type == .element {
          try textNode.setFormat(format: firstNextFormat)
          let newSelection = try textNode.select(anchorOffset: startOffset, focusOffset: endOffset)
          updateSelection(
            anchor: newSelection.anchor,
            focus: newSelection.focus,
            format: firstNextFormat,
            isDirty: newSelection.dirty)
          return
        }

        startOffset = anchor.offset > focus.offset ? focus.offset : anchor.offset
        endOffset = anchor.offset > focus.offset ? anchor.offset : focus.offset

        // No actual text is selected, so do nothing.
        if startOffset == endOffset {
          return
        }

        // The entire node is selected, so just format it
        if startOffset == 0 && endOffset == textNode.getTextPartSize() {
          try textNode.setFormat(format: firstNextFormat)
          let newSelection = try textNode.select(anchorOffset: startOffset, focusOffset: endOffset)
          updateSelection(
            anchor: newSelection.anchor,
            focus: newSelection.focus,
            format: firstNextFormat,
            isDirty: newSelection.dirty)
        } else {
          // node is partially selected, so split it into two nodes and style the selected one.
          let splitNodes = try textNode.splitText(splitOffsets: [startOffset, endOffset])
          let replacement = startOffset == 0 ? splitNodes[0] : splitNodes[1]
          try replacement.setFormat(format: firstNextFormat)
          let newSelection = try replacement.select(anchorOffset: 0, focusOffset: endOffset - startOffset)
          updateSelection(
            anchor: newSelection.anchor,
            focus: newSelection.focus,
            format: firstNextFormat,
            isDirty: newSelection.dirty)
        }

        format = firstNextFormat
      }
    } else {
      // multiple nodes selected
      if var textNode = firstNode as? TextNode {
        if startOffset != 0 {
          // the entire first node isn't selected, so split it
          let splitNodes = try textNode.splitText(splitOffsets: [startOffset])
          if splitNodes.count > 1 {
            textNode = splitNodes[1]
          }

          startOffset = 0
        }
        try textNode.setFormat(format: firstNextFormat)

        // update selection
        if isBefore {
          anchor.updatePoint(key: textNode.key, offset: startOffset, type: .text)
        } else {
          focus.updatePoint(key: textNode.key, offset: startOffset, type: .text)
        }

        format = firstNextFormat
      }

      var lastNextFormat = firstNextFormat

      if var textNode = lastNode as? TextNode {
        lastNextFormat = textNode.getFormatFlags(type: formatType, alignWithFormat: firstNextFormat)
        // if the offset is 0, it means no actual characters are selected,
        // so we skip formatting the last node altogether.
        if endOffset != 0 {
          // if the entire last node isn't selected, split it
          if endOffset != textNode.getTextPartSize() {
            let lastNodes = try textNode.splitText(splitOffsets: [endOffset])
            if lastNodes.count >= 1 {
              textNode = lastNodes[0]
            }
          }

          try textNode.setFormat(format: lastNextFormat)
          // update selection
          if isBefore {
            focus.updatePoint(key: textNode.key, offset: endOffset, type: .text)
          } else {
            anchor.updatePoint(key: textNode.key, offset: endOffset, type: .text)
          }
        }
      }

      // deal with all the nodes in between
      for index in 1..<selectedNodes.count - 1 {
        let selectedNode = selectedNodes[index]
        let selectedNodeKey = selectedNode.getKey()

        if let textNode = selectedNode as? TextNode,
          selectedNodeKey != firstNode.getKey(),
          selectedNodeKey != lastNode.getKey()
        {
          let selectedNextFormat = textNode.getFormatFlags(type: formatType, alignWithFormat: lastNextFormat)
          try textNode.setFormat(format: selectedNextFormat)
        }
      }
    }
  }

  internal func clearFormat() {
    format = TextFormat()
  }

  // MARK: - Private

  private func updateSelection(anchor: Point, focus: Point, format: TextFormat, isDirty: Bool) {
    self.anchor.updatePoint(key: anchor.key, offset: anchor.offset, type: anchor.type)
    self.focus.updatePoint(key: focus.key, offset: focus.offset, type: focus.type)
    self.format = format
    self.dirty = isDirty
  }

  private func toggleFormat(type: TextFormatType) {
    format = toggleTextFormatType(format: format, type: type, alignWithFormat: nil)
    dirty = true
  }

  private func swapPoints() {
    let anchorKey = anchor.key
    let anchorOffset = anchor.offset
    let anchorType = anchor.type

    anchor.key = focus.key
    anchor.offset = focus.offset
    anchor.type = focus.type

    focus.key = anchorKey
    focus.offset = anchorOffset
    focus.type = anchorType
  }

  public func insertRawText(_ text: String) throws {
    let parts = text.split(whereSeparator: \.isNewline)
    if parts.count == 1 {
      try insertText(text)
      return
    }

    var nodesToInsert: [Node] = []
    for (i, part) in parts.enumerated() {
      let textNode = TextNode(text: String(part))
      nodesToInsert.append(textNode)
      if i < parts.count - 1 {
        nodesToInsert.append(LineBreakNode())
      }
    }
    try insertNodes(nodes: nodesToInsert)
  }

  public func isSelection(_ selection: BaseSelection) -> Bool {
    guard let selection = selection as? RangeSelection else {
      return false
    }
    return anchor == selection.anchor && focus == selection.focus && format == selection.format
  }
}

extension RangeSelection: Equatable {
  public static func == (lhs: RangeSelection, rhs: RangeSelection) -> Bool {
    return lhs.anchor == rhs.anchor && lhs.focus == rhs.focus && lhs.format == rhs.format
  }
}

extension RangeSelection: CustomDebugStringConvertible {
  public var debugDescription: String {
    return "\tanchor { \(anchor)\n\tfocus { \(focus)"
  }
}
