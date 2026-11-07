/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

public enum RangeSearchInclusionResult {
  case include
  case exclude
  case inherit // NB inherit also inherits the payload!
}

public typealias RangePayloadPair<Payload> = (range: NSRange, payload: Payload)

/**
 Searches a Lexical subtree for nodes matching a condition, and returns the text range (plus a custom payload).

 If using Lexical to interoprate with any APIs that work with attribute ranges, it is often useful to be able
 to match up Lexical nodes with ranges.

 This function mirrors some of the work done by the reconciler/range cache combo, but does not rely on the range
 cache so that it can be used in headless/no editor situations (e.g. when doing `EditorState.read {}`).
 */
public func performRangeSearchWithPayload<Payload: Equatable>(searchRoot: Node, comparison: (Node) -> (RangeSearchInclusionResult, Payload)) throws -> [RangePayloadPair<Payload>] {
  var cursor = 0
  var ranges: [RangePayloadPair<Payload>] = []
  try searchInNode(node: searchRoot, comparison: comparison, cursor: &cursor, ranges: &ranges, parentMatch: false, parentPayload: nil)

  // merge contiguous ranges
  return ranges.reduce([]) { mergedRanges, element in
    guard let last = mergedRanges.last else {
      return [element]
    }
    var output = mergedRanges
    if last.range.upperBound == element.range.lowerBound && last.payload == element.payload {
      output.removeLast()
      let newRange = NSRange(location: last.range.location, length: element.range.upperBound - last.range.lowerBound)
      output.append((range: newRange, payload: last.payload))
    } else {
      output.append(element)
    }
    return output
  }
}

/**
 Searches a Lexical subtree for nodes matching a condition, and returns the text range.
 */
public func performRangeSearch(searchRoot: Node, comparison: (Node) -> (RangeSearchInclusionResult)) throws -> [NSRange] {
  let dummyPayload = true
  let output = try performRangeSearchWithPayload(
    searchRoot: searchRoot,
    comparison: { node in
      return (comparison(node), dummyPayload)
    })
  return output.map { pair in
    return pair.range
  }
}

// the recursive helper function for the above
func searchInNode<Payload: Equatable>(node: Node, comparison: (Node) -> (RangeSearchInclusionResult, Payload), cursor: inout Int, ranges: inout [RangePayloadPair<Payload>], parentMatch: Bool, parentPayload: Payload?) throws {
  let (currentMatch, currentPayload) = comparison(node)
  let currentMatchResolved =
    switch currentMatch {
    case .include: true
    case .exclude: false
    case .inherit: parentMatch
    }
  let currentPayloadResolved = (currentMatch == .inherit) ? parentPayload ?? currentPayload : currentPayload

  // handle preamble and text parts
  let start = cursor
  cursor += node.getPreamble().lengthAsNSString()
  cursor += node.getTextPart().lengthAsNSString()
  if currentMatchResolved == true {
    let range = NSRange(location: start, length: cursor - start)
    ranges.append((range, currentPayloadResolved))
  }

  // handle children
  if let node = node as? ElementNode {
    for child in node.getChildren() {
      try searchInNode(node: child, comparison: comparison, cursor: &cursor, ranges: &ranges, parentMatch: currentMatchResolved, parentPayload: currentPayloadResolved)
    }
  }

  // handle postamble
  let postambleStart = cursor
  cursor += node.getPostamble().lengthAsNSString()
  if currentMatchResolved == true {
    let range = NSRange(location: postambleStart, length: cursor - postambleStart)
    ranges.append((range, currentPayloadResolved))
  }
}

public func allNodeKeysSortedByLocation() -> [NodeKey] {
  guard let editor = getActiveEditor() else {
    return []
  }
  return editor.rangeCache.map { $0 }
    .sorted { a, b in
      // return true if a<b
      let itemA = a.value
      let itemB = b.value
      if itemA.location < itemB.location {
        return true
      }
      if itemA.location > itemB.location {
        return false
      }
      // we have the same location
      return itemA.range.length > itemB.range.length
    }
    .map { element in
      element.key
    }
}
