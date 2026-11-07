/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical

public func formatBulletedList(editor: Editor) throws {
  return
}

private func isSelectingEmptyListItem(
  anchorNode: Node,
  nodes: [Node]
) -> Bool {
  guard let listItemNode = anchorNode as? ListItemNode else {
    return false
  }
  if nodes.isEmpty {
    return true
  }
  if let firstNode = nodes.first {
    return (listItemNode.key == firstNode.key && listItemNode.getChildrenSize() == 0)
  }
  return false
}

/**
 * Creates a ListNode of listType.
 * @param listType - The type of list to be created. Can be 'number', 'bullet', or 'check'.
 * @param start - Where an ordered list starts its count, start = 1 if left undefined.
 * @returns The new ListNode
 */
public func createListNode(listType: ListType, start: Int = 1) -> ListNode {
  return ListNode(listType: listType, start: start)
}

private func createListOrMerge(node: ElementNode, listType: ListType) throws -> ListNode {
  if let node = node as? ListNode {
    return node
  }

  let previousSibling = node.getPreviousSibling()
  let nextSibling = node.getNextSibling()
  let listItem = ListItemNode()
  //  listItem.setFormat(node.getFormatType());
  try listItem.setIndent(node.getIndent())
  try listItem.append(node.getChildren())

  if let previousSibling = previousSibling as? ListNode, listType == previousSibling.getListType() {
    try previousSibling.append([listItem])
    try node.remove()
    // if the same type of list is on both sides, merge them.

    if let nextSibling = nextSibling as? ListNode, listType == nextSibling.getListType() {
      try previousSibling.append(nextSibling.getChildren())
      try nextSibling.remove()
    }
    return previousSibling
  } else if let nextSibling = nextSibling as? ListNode, listType == nextSibling.getListType() {
    guard let nextSiblingFirstChild = nextSibling.getFirstChild() else {
      throw LexicalError.invariantViolation("no next sibling first child")
    }
    try nextSiblingFirstChild.insertBefore(nodeToInsert: listItem)
    try node.remove()
    return nextSibling
  } else {
    let list = createListNode(listType: listType)
    try list.append([listItem])
    try node.replace(replaceWith: list)
    try updateChildrenListItemValue(list: list, children: nil)
    return list
  }
}

private func getListItemValue(listItem: ListItemNode) throws -> Int {
  let list = listItem.getParent()

  var value = 1

  if let list {
    guard let list = list as? ListNode else {
      throw LexicalError.invariantViolation("list node is not parent of list item node")
    }
    value = list.getStart()
  }

  let siblings = listItem.getPreviousSiblings()
  for sibling in siblings {
    if let sibling = sibling as? ListItemNode, let firstChild = sibling.getFirstChild(), !(firstChild is ListNode) {
      value += 1
    }
  }
  return value
}

/**
 * Takes the value of a child ListItemNode and makes it the value the ListItemNode
 * should be if it isn't already. If only certain children should be updated, they
 * can be passed optionally in an array.
 * @param list - The list whose children are updated.
 * @param children - An array of the children to be updated.
 */
public func updateChildrenListItemValue(
  list: ListNode,
  children: [ListNode]? = nil
) throws {
  let childrenOrExisting = children ?? list.getChildren()
  for child in childrenOrExisting {
    if let child = child as? ListItemNode {
      let prevValue = child.getValue()
      let nextValue = try getListItemValue(listItem: child)

      if prevValue != nextValue {
        child.setValue(value: nextValue)
      }
    }
  }
}

/**
 * Inserts a new ListNode. If the selection's anchor node is an empty ListItemNode and is a child of
 * the root/shadow root, it will replace the ListItemNode with a ListNode and the old ListItemNode.
 * Otherwise it will replace its parent with a new ListNode and re-insert the ListItemNode and any previous children.
 * If the selection's anchor node is not an empty ListItemNode, it will add a new ListNode or merge an existing ListNode,
 * unless the the node is a leaf node, in which case it will attempt to find a ListNode up the branch and replace it with
 * a new ListNode, or create a new ListNode at the nearest root/shadow root.
 * @param editor - The lexical editor.
 * @param listType - The type of list, "number" | "bullet" | "check".
 */
public func insertList(editor: Editor, listType: ListType) throws {
  try editor.update {
    guard let selection = try getSelection() else {
      throw LexicalError.invariantViolation("no selection")
    }

    guard let selection = selection as? RangeSelection else {
      return
    }
    let nodes = try selection.getNodes()
    let anchor = selection.anchor
    let anchorNode = try anchor.getNode()
    let anchorNodeParent = anchorNode.getParent()

    if isSelectingEmptyListItem(anchorNode: anchorNode, nodes: nodes) {
      let list = createListNode(listType: listType)

      if isRootNode(node: anchorNodeParent) {
        try anchorNode.replace(replaceWith: list)
        let listItem = ListItemNode()
        if let anchorNode = anchorNode as? ElementNode {
          //          listItem.setFormat(anchorNode.getFormatType())
          try listItem.setIndent(anchorNode.getIndent())
        }
        try list.append([listItem])
      } else if let anchorNode = anchorNode as? ListItemNode {
        let parent = try anchorNode.getParentOrThrow()
        try list.append(parent.getChildren())
        try parent.replace(replaceWith: list)
      }

      return
    } else {
      var handled = Set<NodeKey>()
      for node in nodes {
        if let node = node as? ElementNode,
          node.isEmpty(),
          !handled.contains(node.getKey())
        {
          _ = try createListOrMerge(node: node, listType: listType)
          continue
        }

        if isLeafNode(node) {
          var parent = node.getParent()
          while let parentIterator = parent {
            let parentKey = parentIterator.getKey()

            if let parent = parentIterator as? ListNode {
              if !handled.contains(parentKey) {
                let newListNode = createListNode(listType: listType)
                try newListNode.append(parent.getChildren())
                try parent.replace(replaceWith: newListNode)
                try updateChildrenListItemValue(list: newListNode, children: nil)
                handled.insert(parentKey)
              }

              break
            } else {
              let nextParent = parentIterator.getParent()

              if isRootNode(node: nextParent) && !handled.contains(parentKey) {
                handled.insert(parentKey)
                _ = try createListOrMerge(node: parentIterator, listType: listType)
                break
              }

              parent = nextParent
            }
          }
        }
      }
    }
  }
}

/**
 * Checks to see if the passed node is a ListItemNode and has a ListNode as a child.
 * @param node - The node to be checked.
 * @returns true if the node is a ListItemNode and has a ListNode child, false otherwise.
 */
public func isNestedListNode(node: Node?) -> Bool {
  if let node = node as? ListItemNode {
    return node.getFirstChild() is ListNode
  }
  return false
}

/**
 * A recursive function that goes through each list and their children, including nested lists,
 * appending list2 children after list1 children and updating ListItemNode values.
 * @param list1 - The first list to be merged.
 * @param list2 - The second list to be merged.
 */
public func mergeLists(list1: ListNode, list2: ListNode) throws {
  let listItem1 = list1.getLastChild()
  let listItem2 = list2.getFirstChild()

  if let listItem1 = listItem1 as? ListItemNode,
    let listItem2 = listItem2 as? ListItemNode,
    isNestedListNode(node: listItem1),
    isNestedListNode(node: listItem2),
    let child1 = listItem1.getFirstChild() as? ListNode,
    let child2 = listItem2.getFirstChild() as? ListNode
  {
    try mergeLists(list1: child1, list2: child2)
    try listItem2.remove()
  }

  let toMerge = list2.getChildren()
  if !toMerge.isEmpty {
    try list1.append(toMerge)
    try updateChildrenListItemValue(list: list1, children: nil)
  }

  try list2.remove()
}

/**
 * Adds an empty ListNode/ListItemNode chain at listItemNode, so as to
 * create an indent effect. Won't indent ListItemNodes that have a ListNode as
 * a child, but does merge sibling ListItemNodes if one has a nested ListNode.
 * @param listItemNode - The ListItemNode to be indented.
 */
internal func handleIndent(_ listItemNode: ListItemNode) throws {
  // go through each node and decide where to move it.
  var removed = Set<NodeKey>()

  if isNestedListNode(node: listItemNode) {
    return
  }

  let parent = listItemNode.getParent()

  let nextSibling = listItemNode.getNextSibling() as? ListItemNode
  let previousSibling = listItemNode.getPreviousSibling() as? ListItemNode
  // if there are nested lists on either side, merge them all together.

  if isNestedListNode(node: nextSibling) && isNestedListNode(node: previousSibling) {
    let innerList = previousSibling?.getFirstChild()

    if let innerList = innerList as? ListNode {
      try innerList.append([listItemNode])
      let nextInnerList = nextSibling?.getFirstChild()

      if let nextSibling, let nextInnerList = nextInnerList as? ListNode {
        let children = nextInnerList.getChildren()
        try innerList.append(children)
        try nextSibling.remove()
        removed.insert(nextSibling.getKey())
      }
      try updateChildrenListItemValue(list: innerList)
    }
  } else if let nextSibling, isNestedListNode(node: nextSibling) {
    // if the ListItemNode is next to a nested ListNode, merge them
    let innerList = nextSibling.getFirstChild()

    if let innerList = innerList as? ListNode {
      let firstChild = innerList.getFirstChild()

      if let firstChild {
        try firstChild.insertBefore(nodeToInsert: listItemNode)
      }
      try updateChildrenListItemValue(list: innerList)
    }
  } else if isNestedListNode(node: previousSibling) {
    let innerList = previousSibling?.getFirstChild()

    if let innerList = innerList as? ListNode {
      try innerList.append([listItemNode])
      try updateChildrenListItemValue(list: innerList)
    }
  } else {
    // otherwise, we need to create a new nested ListNode

    if let parent = parent as? ListNode {
      let newListItem = ListItemNode()
      let newList = createListNode(listType: parent.getListType())
      try newListItem.append([newList])
      try newList.append([listItemNode])

      if let previousSibling {
        _ = try previousSibling.insertAfter(nodeToInsert: newListItem)
      } else if let nextSibling {
        try nextSibling.insertBefore(nodeToInsert: newListItem)
      } else {
        try parent.append([newListItem])
      }
      try updateChildrenListItemValue(list: newList)
    }
  }

  if let parent = parent as? ListNode {
    try updateChildrenListItemValue(list: parent)
  }
}

/**
 * Removes an indent by removing an empty ListNode/ListItemNode chain. An indented ListItemNode
 * has a great grandparent node of type ListNode, which is where the ListItemNode will reside
 * within as a child.
 * @param listItemNode - The ListItemNode to remove the indent (outdent).
 */
internal func handleOutdent(_ listItemNode: ListItemNode) throws {
  // go through each node and decide where to move it.

  if isNestedListNode(node: listItemNode) {
    return
  }
  let parentList = listItemNode.getParent()
  let grandparentListItem = parentList?.getParent()
  let greatGrandparentList = grandparentListItem?.getParent()
  // If it doesn't have these ancestors, it's not indented.

  if let greatGrandparentList = greatGrandparentList as? ListNode,
    let grandparentListItem = grandparentListItem as? ListItemNode,
    let parentList = parentList as? ListNode
  {
    // if it's the first child in it's parent list, insert it into the
    // great grandparent list before the grandparent
    let firstChild = parentList.getFirstChild()
    let lastChild = parentList.getLastChild()

    if let firstChild, listItemNode.isSameNode(firstChild) {
      try grandparentListItem.insertBefore(nodeToInsert: listItemNode)

      if parentList.isEmpty() {
        try grandparentListItem.remove()
      }
      // if it's the last child in it's parent list, insert it into the
      // great grandparent list after the grandparent.
    } else if let lastChild, listItemNode.isSameNode(lastChild) {
      _ = try grandparentListItem.insertAfter(nodeToInsert: listItemNode)

      if parentList.isEmpty() {
        try grandparentListItem.remove()
      }
    } else {
      // otherwise, we need to split the siblings into two new nested lists
      let listType = parentList.getListType()
      let previousSiblingsListItem = ListItemNode()
      let previousSiblingsList = createListNode(listType: listType)
      try previousSiblingsListItem.append([previousSiblingsList])
      try previousSiblingsList.append(listItemNode.getPreviousSiblings())
      let nextSiblingsListItem = ListItemNode()
      let nextSiblingsList = createListNode(listType: listType)
      try nextSiblingsListItem.append([nextSiblingsList])
      try nextSiblingsList.append(listItemNode.getNextSiblings())
      // put the sibling nested lists on either side of the grandparent list item in the great grandparent.
      try grandparentListItem.insertBefore(nodeToInsert: previousSiblingsListItem)
      _ = try grandparentListItem.insertAfter(nodeToInsert: nextSiblingsListItem)
      // replace the grandparent list item (now between the siblings) with the outdented list item.
      _ = try grandparentListItem.replace(replaceWith: listItemNode)
    }
    try updateChildrenListItemValue(list: parentList)
    try updateChildrenListItemValue(list: greatGrandparentList)
  }
}
