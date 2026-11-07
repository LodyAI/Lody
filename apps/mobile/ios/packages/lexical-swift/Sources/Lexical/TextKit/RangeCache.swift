/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import UIKit

/* The range cache is used when updating the NSTextStorage following a change to Lexical's
 * data model. In order to do the update with nuance, changing only the bits of the string
 * that have changed, we need to know where those bits of string are. The range cache
 * is how this information is stored, to save having to regenerate it (an expensive operation).
 */

struct RangeCacheItem {
  var location: Int = 0
  var preambleLength: Int = 0
  var childrenLength: Int = 0
  var textLength: Int = 0
  var postambleLength: Int = 0

  var range: NSRange {
    get {
      NSRange(location: location, length: preambleLength + childrenLength + textLength + postambleLength)
    }
  }
}

// MARK: - Search for nodes based on range

/*
 * This method is used to search a combination of the node tree and the range cache, to find a Point for a given
 * string location. The string location can be 0 <= x <= length. Location is specified in UTF16 code points, as
 * used by NSString. (Note that Swift string locations are not compatible.)
 *
 * If the string location falls in an invalid place (such as inside a multi-character preamble), this method
 * will return nil.
 *
 * searchDirection is used to break ties for when there would be more than one valid Point for a location. For
 * example, if the location sits between two consecutive Text nodes, the Point could either be at the end of the
 * first Text node, or at the start of the second Text node.
 */
internal func pointAtStringLocation(_ location: Int, searchDirection: UITextStorageDirection, rangeCache: [NodeKey: RangeCacheItem]) throws -> Point? {
  do {
    let searchResult = try evaluateNode(kRootNodeKey, stringLocation: location, searchDirection: searchDirection, rangeCache: rangeCache)
    guard let searchResult, let offset = searchResult.offset else {
      return nil
    }

    switch searchResult.type {
    case .endBoundary, .startBoundary, .illegal:
      throw LexicalError.internal("Failed to find node for location: \(location)")
    case .text:
      return Point(key: searchResult.nodeKey, offset: offset, type: .text)
    case .element:
      return Point(key: searchResult.nodeKey, offset: offset, type: .element)
    }
  } catch LexicalError.rangeCacheSearch {
    return nil
  }
}

private func evaluateNode(_ nodeKey: NodeKey, stringLocation: Int, searchDirection: UITextStorageDirection, rangeCache: [NodeKey: RangeCacheItem]) throws -> RangeCacheSearchResult? {
  guard let rangeCacheItem = rangeCache[nodeKey], let node = getNodeByKey(key: nodeKey) else {
    throw LexicalError.rangeCacheSearch("Couldn't find node or range cache item for key \(nodeKey)")
  }

  if !rangeCacheItem.entireRange().byAddingOne().contains(stringLocation) {
    return nil
  }

  if node is TextNode {
    let expandedTextRange = rangeCacheItem.textRange().byAddingOne()
    if expandedTextRange.contains(stringLocation) {
      return RangeCacheSearchResult(nodeKey: nodeKey, type: .text, offset: stringLocation - expandedTextRange.location)
    }
  }

  if let node = node as? ElementNode {
    let childrenArray = (searchDirection == .forward) ? node.getChildrenKeys() : node.getChildrenKeys().reversed()

    var possibleBoundaryElementResult: RangeCacheSearchResult?
    for childKey in childrenArray {
      // note: I'm using try? because that lets us attempt to still return a selection even if there's an error deeper in the tree.
      // This might be a mistake, in which case we can change it to just `try` and propagate the exception. @amyworrall
      guard let result = try? evaluateNode(childKey, stringLocation: stringLocation, searchDirection: searchDirection, rangeCache: rangeCache) else { continue }
      if result.type == .text || result.type == .element {
        return result
      }
      guard let childIndex = node.getChildrenKeys().firstIndex(of: childKey) else { continue }
      if result.type == .startBoundary {
        // the boundary of a child, so return self key with appropriate offset
        possibleBoundaryElementResult = RangeCacheSearchResult(nodeKey: nodeKey, type: .element, offset: childIndex)
      }
      if result.type == .endBoundary {
        possibleBoundaryElementResult = RangeCacheSearchResult(nodeKey: nodeKey, type: .element, offset: childIndex + 1)
      }
    }
    if let possibleBoundaryElementResult {
      // We do this 'possible result' check so that we prioritise text results where we can.
      return possibleBoundaryElementResult
    }
  }

  if rangeCacheItem.entireRange().length == 0 {
    // caret is at the last row - element with no children
    if stringLocation == rangeCacheItem.location {
      return RangeCacheSearchResult(nodeKey: nodeKey, type: .element, offset: 0)
    }

    // return the appropriate boundary for the search direction!
    let boundary: RangeCacheSearchResultType = (searchDirection == .forward) ? .startBoundary : .endBoundary
    return RangeCacheSearchResult(nodeKey: nodeKey, type: boundary, offset: nil)
  }

  if stringLocation == rangeCacheItem.location {
    if rangeCacheItem.preambleLength == 0 && node is ElementNode {
      return RangeCacheSearchResult(nodeKey: nodeKey, type: .element, offset: 0)
    }

    return RangeCacheSearchResult(nodeKey: nodeKey, type: .startBoundary, offset: nil)
  }

  if stringLocation == rangeCacheItem.entireRange().upperBound {
    return RangeCacheSearchResult(nodeKey: nodeKey, type: .endBoundary, offset: nil)
  }

  return RangeCacheSearchResult(nodeKey: nodeKey, type: .illegal, offset: nil)
}

fileprivate extension NSRange {
  func byAddingOne() -> NSRange {
    return NSRange(location: location, length: length + 1)
  }
}

internal extension RangeCacheItem {
  func entireRange() -> NSRange {
    return NSRange(location: location, length: preambleLength + childrenLength + textLength + postambleLength)
  }
  func textRange() -> NSRange {
    return NSRange(location: location + preambleLength + childrenLength, length: textLength)
  }
  func childrenRange() -> NSRange {
    return NSRange(location: location + preambleLength, length: childrenLength)
  }
}

private struct RangeCacheSearchResult {
  let nodeKey: NodeKey
  let type: RangeCacheSearchResultType
  let offset: Int?
}

private enum RangeCacheSearchResultType {
  case startBoundary // the boundary types are converted to element type for the parent element
  case endBoundary
  case text
  case element
  case illegal // used for if the search is inside a multi-character preamble/postamble
}

internal func updateRangeCacheForTextChange(nodeKey: NodeKey, delta: Int) {
  guard let editor = getActiveEditor(), let node = getNodeByKey(key: nodeKey) as? TextNode else {
    fatalError()
  }

  editor.rangeCache[nodeKey]?.textLength = node.getTextPart().lengthAsNSString()
  let parentKeys = node.getParents().map { $0.getKey() }

  for parentKey in parentKeys {
    editor.rangeCache[parentKey]?.childrenLength += delta
  }

  updateNodeLocationFor(nodeKey: kRootNodeKey, nodeIsAfterChangedNode: false, changedNodeKey: nodeKey, changedNodeParents: parentKeys, delta: delta)
}

private func updateNodeLocationFor(nodeKey: NodeKey, nodeIsAfterChangedNode: Bool, changedNodeKey: NodeKey, changedNodeParents: [NodeKey], delta: Int) {
  guard let editor = getActiveEditor() else {
    fatalError()
  }

  if nodeIsAfterChangedNode {
    editor.rangeCache[nodeKey]?.location += delta
  }

  var isAfterChangedNode = nodeIsAfterChangedNode

  if let elementNode = getNodeByKey(key: nodeKey) as? ElementNode, isAfterChangedNode || changedNodeParents.contains(nodeKey) {
    for child in elementNode.getChildren() {
      updateNodeLocationFor(nodeKey: child.getKey(), nodeIsAfterChangedNode: isAfterChangedNode, changedNodeKey: changedNodeKey, changedNodeParents: changedNodeParents, delta: delta)
      if child.getKey() == changedNodeKey || changedNodeParents.contains(child.getKey()) {
        isAfterChangedNode = true
      }
    }
  }
}
