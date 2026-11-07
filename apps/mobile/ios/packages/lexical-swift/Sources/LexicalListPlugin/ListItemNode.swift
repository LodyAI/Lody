/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical
import UIKit

extension NodeType {
  // don't make this `listItem` keep it all lowercased
  // so that it matches the JavaScript node type declaration
  // in an attempt to make the 2 contexts compatible
  static let listItem = NodeType(rawValue: "listitem")
}

public final class ListItemNode: ElementNode {
  enum CodingKeys: String, CodingKey {
    case value
    case checked
  }

  private var value: Int = 0
  private var checked: Bool?

  override public init() {
    super.init()
  }

  override public required init(_ key: NodeKey?) {
    super.init(key)
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)
    value = try container.decodeIfPresent(Int.self, forKey: .value) ?? 0
    checked = try container.decodeIfPresent(Bool.self, forKey: .checked)
  }

  override public func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(value, forKey: .value)
    try container.encodeIfPresent(checked, forKey: .checked)
  }

  override public func clone() -> Self {
    let node = Self(key)
    node.value = value
    node.checked = checked
    return node
  }

  public func getChecked() -> Bool? {
    getLatest().checked
  }

  public func setChecked(_ checked: Bool?) throws {
    try getWritable().checked = checked
  }

  override public class func getType() -> NodeType {
    .listItem
  }

  public func getValue() -> Int {
    let node = self.getLatest()
    return node.value
  }

  public func setValue(value: Int) {
    let node = try? self.getWritable()
    node?.value = value
  }

  override public func append(_ nodesToAppend: [Node]) throws {
    for node in nodesToAppend {
      if let node = node as? ElementNode, self.canMergeWith(node: node) {
        let children = node.getChildren()
        try self.append(children)
        try node.remove()
      } else {
        try super.append([node])
      }
    }
  }

  override public func replace<T>(replaceWith replaceWithNode: T, includeChildren: Bool = false) throws -> T where T: Node {
    if replaceWithNode is ListItemNode {
      return try super.replace(replaceWith: replaceWithNode)
    }
    try self.setIndent(0)
    let list = try getParentOrThrow()
    guard let list = list as? ListNode else {
      return replaceWithNode
    }
    if let firstChild = list.getFirstChild(), firstChild.key == getKey() {
      try list.insertBefore(nodeToInsert: replaceWithNode)
    } else if let lastChild = list.getLastChild(), lastChild.key == getKey() {
      try list.insertAfter(nodeToInsert: replaceWithNode)
    } else {
      // Split the list
      let newList = createListNode(listType: list.getListType())
      var nextSibling = self.getNextSibling()
      while nextSibling != nil {
        guard let nodeToAppend = nextSibling else { continue }
        nextSibling = nextSibling?.getNextSibling()
        try newList.append([nodeToAppend])
      }
      try list.insertAfter(nodeToInsert: replaceWithNode)
      try replaceWithNode.insertAfter(nodeToInsert: newList)
    }
    if includeChildren, let replaceWithNode = replaceWithNode as? ElementNode {
      for child in self.getChildren() {
        try replaceWithNode.append([child])
      }
    }
    try self.remove()
    if list.getChildrenSize() == 0 {
      try list.remove()
    }
    return replaceWithNode
  }

  override public func insertAfter(nodeToInsert node: Node) throws -> Node {
    guard let listNode = try self.getParentOrThrow() as? ListNode else {
      throw LexicalError.invariantViolation("list node is not parent of list item node")
    }

    let siblings = self.getNextSiblings()

    if let node = node as? ListItemNode {
      let after = try super.insertAfter(nodeToInsert: node)
      let afterListNode = try node.getParentOrThrow()

      if let afterListNode = afterListNode as? ListNode {
        try updateChildrenListItemValue(list: afterListNode, children: nil)
      }

      return after
    }

    // Attempt to merge if the list is of the same type.

    if let node = node as? ListNode, node.getListType() == listNode.getListType() {
      let child = node
      // TODO: @amyworrall not sure about this porting section
      if let children = node.getChildren() as? [ListNode] {
        for child in children {
          _ = try self.insertAfter(nodeToInsert: child)
        }
      }
      return child
    }

    // Otherwise, split the list
    // Split the lists and insert the node in between them
    _ = try listNode.insertAfter(nodeToInsert: node)

    if !siblings.isEmpty {
      let newListNode = createListNode(listType: listNode.getListType())
      try newListNode.append(siblings)
      _ = try node.insertAfter(nodeToInsert: newListNode)
    }

    return node
  }

  override public func remove() throws {
    let prevSibling = self.getPreviousSibling()
    let nextSibling = self.getNextSibling()
    try super.remove()

    if let prevSibling = prevSibling as? ListItemNode,
      let nextSibling = nextSibling as? ListItemNode,
      isNestedListNode(node: prevSibling),
      isNestedListNode(node: nextSibling),
      let list1 = prevSibling.getFirstChild() as? ListNode,
      let list2 = nextSibling.getFirstChild() as? ListNode
    {
      try mergeLists(list1: list1, list2: list2)
      try nextSibling.remove()
    } else if let nextSibling {
      let parent = nextSibling.getParent()

      if let parent = parent as? ListNode {
        try updateChildrenListItemValue(list: parent, children: nil)
      }
    }
  }

  override public func insertNewAfter(selection: RangeSelection?) throws -> Node? {
    let newElement = ListItemNode()
    _ = try self.insertAfter(nodeToInsert: newElement)

    return newElement
  }

  override public func collapseAtStart(selection: RangeSelection) throws -> Bool {
    let paragraph = createParagraphNode()
    let children = self.getChildren()
    try paragraph.append(children)
    let listNode = try self.getParentOrThrow()
    let listNodeParent = try listNode.getParentOrThrow()
    let isIndented = listNodeParent is ListItemNode

    if listNode.getChildrenSize() == 1 {
      if isIndented {
        // if the list node is nested, we just want to remove it,
        // effectively unindenting it.
        try listNode.remove()
        try listNodeParent.select(anchorOffset: nil, focusOffset: nil)
      } else {
        try listNode.insertBefore(nodeToInsert: paragraph)
        try listNode.remove()
        // If we have selection on the list item, we'll need to move it
        // to the paragraph
        let anchor = selection.anchor
        let focus = selection.focus
        let key = paragraph.getKey()

        if anchor.type == .element && anchor.key == self.getKey() {
          anchor.updatePoint(key: key, offset: anchor.offset, type: .element)
        }

        if focus.type == .element && focus.key == self.getKey() {
          focus.updatePoint(key: key, offset: focus.offset, type: .element)
        }
      }
    } else {
      try listNode.insertBefore(nodeToInsert: paragraph)
      try self.remove()
    }

    return true
  }

  override public func getIndent() -> Int {
    guard let parent = getParent() as? ListNode else {
      // If we don't have a parent, we are likely serializing
      return super.getIndent()
    }
    // ListItemNode should always have a ListNode for a parent.
    var listNodeParent = parent.getParent()
    var indentLevel = 0
    while listNodeParent is ListItemNode {
      listNodeParent = listNodeParent?.getParent()?.getParent()
      indentLevel += 1
    }
    return indentLevel
  }

  @discardableResult
  override public func setIndent(_ indent: Int) throws -> ElementNode {
    try errorOnReadOnly()
    let node = try getWritable() as ListItemNode
    var currentIndent = getIndent()
    while currentIndent != indent {
      if currentIndent < indent {
        try handleIndent(self)
        currentIndent += 1
      } else {
        try handleOutdent(self)
        currentIndent -= 1
      }
    }
    return node
  }

  // TODO: support other types of list. Correctly derive the item number in this method.
  override public func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    let node: ListItemNode = getLatest()
    let listNode = node.getParent() as? ListNode

    var attributes: [NSAttributedString.Key: Any] = theme.listItem ?? [:]
    attributes[.paddingHead] = attributes[.paddingHead] ?? theme.indentSize

    if node.getChildren().first is ListNode {
      // Don't apply styles for this list item, because there's another list inside it (don't want to draw two bullets!)
      return attributes
    }

    var character = ""

    if let listNode {
      switch listNode.getListType() {
      case .bullet:
        character = "\u{2022}"

      case .number:
        let start = listNode.getStart()

        // Count previous siblings
        let prevItemsCount = getPreviousSiblings()
          .filter {
            if let siblingItem = $0 as? ListItemNode,
              // Don't count sibling items containing nested lists
              !(siblingItem.getFirstChild() is ListNode)
            {
              return true
            } else {
              return false
            }
          }
          .count

        character = String("\(start + prevItemsCount).")

      case .check:
        break
      }
    }

    // the magic number is to horizontally position the bullet further left than the indent size, but not so far as to hit the previous indent stop.
    attributes[.listItem] = ListItemAttribute(
      itemNodeKey: node.key,
      listItemCharacter: character,
      characterIndentationPixels: (CGFloat(getIndent() + 1) - 0.8) * theme.indentSize
    )

    return attributes
  }
}
