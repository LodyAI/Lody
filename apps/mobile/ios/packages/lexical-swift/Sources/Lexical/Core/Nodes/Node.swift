/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Disabled during swift-format 6.3 rollout, feel free to remove:
// swift-format-ignore-file: OrderedImports

import UIKit

public typealias NodeKey = String

/// The base class for all Lexical nodes to inherit from.
///
/// This class provides various methods for reading and manipulating the node tree, as well as node lifecycle support.
///
/// If you're creating your own node class, typically you would inherit from ``TextNode``, ``DecoratorNode`` or ``ElementNode``, rather than directly inheriting from ``Node``.
open class Node: Codable {
  enum CodingKeys: String, CodingKey {
    case type
    case version
    case state = "$"
  }

  public var key: NodeKey
  var parent: NodeKey?
  public var version: Int
  var state: [String: UnknownNode.SupportedValue]?

  public init() {
    self.version = 1
    self.key = LexicalConstants.uninitializedNodeKey

    _ = try? generateKey(node: self)
  }

  public init(_ key: NodeKey?) {
    self.version = 1

    if let key, key != LexicalConstants.uninitializedNodeKey {
      self.key = key
    } else {
      self.key = LexicalConstants.uninitializedNodeKey
      _ = try? generateKey(node: self)
    }
  }

  /// Used when initialising node from JSON
  public required init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    key = LexicalConstants.uninitializedNodeKey
    version = try values.decode(Int.self, forKey: .version)
    state = try values.decodeIfPresent([String: UnknownNode.SupportedValue].self, forKey: .state)

    _ = try? generateKey(node: self)
  }

  /// Used when serialising node to JSON
  open func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(version, forKey: .version)
    try container.encode(type.rawValue, forKey: .type)
    if let state, !state.isEmpty {
      try container.encode(state, forKey: .state)
    }
  }

  /**
   Called whenever the node is moved to a new editor, e.g. when initialising an editor
   with an existing editor state.
   */
  open func didMoveTo(newEditor editor: Editor) {}

  open class func getType() -> NodeType {
    .unknown
  }

  public func getStateString(_ key: String) -> String? {
    guard case let .string(value)? = getLatest().state?[key] else { return nil }
    return value
  }

  public var type: NodeType {
    get {
      Self.getType()
    }
  }

  /// Provides the **preamble** part of the node's content. Typically the preamble is used for control characters to represent embedded objects (see ``DecoratorNode``).
  ///
  /// In Lexical iOS, a node's content is split into four parts: preamble, children, text, postamble. ``ElementNode`` subclasses can implement preamble/postamble, and TextNode subclasses can implement the text part.
  public func getPreamble() -> String {
    return ""
  }

  /// Provides the **postamble** part of the node's content. Typically the postamble is used for paragraph-trailing newlines.
  ///
  /// In Lexical iOS, a node's content is split into four parts: preamble, children, text, postamble. ``ElementNode`` subclasses can implement preamble/postamble, and TextNode subclasses can implement the text part.
  public func getPostamble() -> String {
    return ""
  }

  /// Provides the **text** part of the node's content. The text part of a node represents the text this node is providing (but not including the text of any children).
  ///
  /// In Lexical iOS, a node's content is split into four parts: preamble, children, text, postamble. ``ElementNode`` subclasses can implement preamble/postamble, and TextNode subclasses can implement the text part.
  public func getTextPart() -> String {
    return ""
  }

  // Returns the length of the text part (as UTF 16 codepoints). Note that all string lengths within Lexical work using UTF 16 codepoints, because that is what TextKit uses.
  public func getTextPartSize() -> Int {
    return getTextPart().lengthAsNSString()
  }

  /// Returns true if this node has been marked dirty during this update cycle.
  func isDirty() -> Bool {
    guard let editor = getActiveEditor() else {
      fatalError()
    }
    return editor.dirtyNodes[key] != nil
  }

  /// Returns the latest version of the node from the active EditorState. This is used to avoid getting values from stale node references.
  public func getLatest() -> Self {
    guard let latest: Self = getNodeByKey(key: key) else {
      fatalError()
    }
    return latest
  }

  /// Clones this node, creating a new node with a different key and adding it to the EditorState (but not attaching it anywhere!). All nodes must implement this method.
  open func clone() -> Self {
    fatalError("LexicalNode: Node \(String(describing: self)) does not implement .clone().")
  }

  /// Lets the node provide attributes for TextKit to use to render the node's content.
  open func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
    [:]
  }

  /**
   Attributes that apply to an entire block.

   This is conceptually not a thing in TextKit, so we had to build our own solution. Note that a block
   is an element or decorator that is not inline. The values of the block level attributes are applied
   to the relevant paragraph style for the first or last paragraph within the node. (Paragraph is here
   used to refer to a TextKit paragraph, i.e. some text separated by newlines. It's nothing to do with
   Lexical's paragraph nodes!)
   */
  open func getBlockLevelAttributes(theme: Theme) -> BlockLevelAttributes? {
    return theme.getBlockLevelAttributes(type)
  }

  /// Returns a mutable version of the node. Will throw an error if called outside of a Lexical Editor ``Editor/update(_:)`` callback.
  public func getWritable() throws -> Self {
    try errorOnReadOnly()

    guard let editor = getActiveEditor(), let editorState = getActiveEditorState() else {
      throw LexicalError.invariantViolation("LexicalNode: Could not get active editor for \(String(describing: self)).")
    }

    let latestNode = getLatest()

    if editor.cloneNotNeeded.contains(key) {
      // Transforms clear the dirty node set on each iteration to keep track on newly dirty nodes
      internallyMarkNodeAsDirty(node: latestNode, cause: .userInitiated)
      return latestNode
    }

    let mutableNode = getLatest().clone()

    mutableNode.parent = latestNode.parent
    mutableNode.state = latestNode.state
    if let latestNode = latestNode as? ElementNode, let mutableNode = mutableNode as? ElementNode {
      mutableNode.children = latestNode.children
      mutableNode.direction = latestNode.direction
      mutableNode.indent = latestNode.indent
      mutableNode.format = latestNode.format
      mutableNode.textFormat = latestNode.textFormat
      mutableNode.textStyle = latestNode.textStyle
    } else if let latestNode = latestNode as? TextNode, let mutableNode = mutableNode as? TextNode {
      mutableNode.format = latestNode.format
      mutableNode.mode = latestNode.mode
      mutableNode.detail = latestNode.detail
      mutableNode.style = latestNode.style
    }

    editor.cloneNotNeeded.insert(key)
    mutableNode.key = key
    internallyMarkNodeAsDirty(node: mutableNode, cause: .userInitiated)

    editorState.nodeMap[key] = mutableNode
    return mutableNode
  }

  /// Returns the zero-based index of this node within the parent.
  public func getIndexWithinParent() -> Int? {
    guard let parent = getParent() else {
      return nil
    }

    return parent.children.firstIndex(of: key)
  }

  /// Returns the parent of this node, or nil if none is found.
  public func getParent() -> ElementNode? {
    guard let parent = getLatest().parent else { return nil }

    return getNodeByKey(key: parent)
  }

  /// Returns a list of the keys of every ancestor of this node, all the way up to the RootNode.
  public func getParentKeys() -> [NodeKey] {
    var parents: [NodeKey] = []
    var node = getParent()

    while let unwrappedNode = node {
      parents.append(unwrappedNode.key)
      node = unwrappedNode.getParent()
    }

    return parents
  }

  /// Returns the highest (in the ``EditorState`` tree) non-root ancestor of this node, or null if none is found.
  ///
  /// Lexical JS has the concept of 'shadow roots', but this has not been implemented in Lexical iOS yet.
  public func getTopLevelElement() -> ElementNode? {
    var node = getNodeByKey(key: key)

    while node != nil {
      let parent = node?.getParent()
      if isRootNode(node: parent) && isElementNode(node: node) {
        return node as? ElementNode
      }

      node = parent
    }

    return nil
  }

  /// Returns the highest (in the EditorState tree) non-root ancestor of this node, or throws if none is found.
  public func getTopLevelElementOrThrow() throws -> ElementNode {
    guard let parent = getTopLevelElement() else {
      throw LexicalError.internal("Expected node \(key) to have a top parent element.")
    }

    return parent
  }

  /// Returns a list of the every ancestor of this node, all the way up to the RootNode.
  public func getParents() -> [ElementNode] {
    var parents: [ElementNode] = []
    var node = getParent()
    while let unwrappedNode = node {
      parents.append(unwrappedNode)
      node = unwrappedNode.getParent()
    }

    return parents
  }

  /// Returns the closest common ancestor of this node and the provided one or nil if one cannot be found.
  public func getCommonAncestor(node: Node) -> ElementNode? {
    var a = getParents()
    var b = node.getParents()

    if isElementNode(node: self) {
      if let elementNode = self as? ElementNode {
        a.insert(elementNode, at: 0)
      }
    }

    if isElementNode(node: node) {
      if let elementNode = node as? ElementNode {
        b.insert(elementNode, at: 0)
      }
    }

    if a.isEmpty || b.isEmpty || a.last !== b.last {
      return nil
    }

    let bSet = Set(b)
    for (index, _) in a.enumerated() {
      let ancestor = a[index]
      if bSet.contains(ancestor) {
        return ancestor
      }
    }
    return nil
  }

  /// Returns the "previous" siblings - that is, the node that comes before this one in the same parent.
  public func getPreviousSibling() -> Node? {
    guard let parent = getParent() else { return nil }

    guard let index = parent.children.firstIndex(of: key) else {
      return nil
    }

    let childrenIndex = index - 1

    if childrenIndex < 0 {
      return nil
    }

    return getNodeByKey(key: parent.children[childrenIndex])
  }

  /// Returns the "next" sibling - that is, the node that comes after this one in the same parent
  public func getNextSibling() -> Node? {
    guard let parent = getParent() else { return nil }

    guard let index = parent.children.firstIndex(of: key) else {
      return nil
    }

    if index >= parent.children.count - 1 {
      return nil
    }

    let childrenIndex = index + 1

    return getNodeByKey(key: parent.children[childrenIndex])
  }

  /// Returns the "previous" siblings - that is, the nodes that come between this one and the first child of it's parent, inclusive.
  public func getPreviousSiblings() -> [Node] {
    guard let parent = getParent() else { return [] }

    let children = parent.children
    guard let index = children.firstIndex(of: key) else { return [] }

    let siblings = children[0..<index]
    return siblings.compactMap({ childKey in
      getNodeByKey(key: childKey)
    })
  }

  /// Returns all "next" siblings - that is, the nodes that come between this one and the last child of its parent, inclusive.
  public func getNextSiblings() -> [Node] {
    guard let parent = getParent() else { return [] }

    let children = parent.children
    if children.count == 1 {
      return []
    }

    guard let index = children.firstIndex(of: key) else { return [] }

    let siblings = children[(index + 1)...]
    return siblings.compactMap { childKey in
      getNodeByKey(key: childKey)
    }
  }

  /// Returns a list of nodes that are between this node and the target node in the EditorState.
  public func getNodesBetween(targetNode: Node) -> [Node] {
    let isBefore = isBefore(targetNode)
    var nodes = [Node]()
    var visited = Set<NodeKey>()
    var node = self
    var dfsAncestor: Node?

    while true {
      if !visited.contains(node.key) {
        visited.insert(node.key)
        nodes.append(node)
      }

      if node == targetNode {
        break
      }

      let elementNode = node as? ElementNode
      let child =
        isElementNode(node: node)
        ? isBefore
          ? elementNode?.getFirstChild()
          : elementNode?.getLastChild()
        : nil

      if child != nil {
        if dfsAncestor == nil {
          dfsAncestor = node
        }

        if let child {
          node = child
        }

        continue
      }

      let nextSibling = isBefore ? node.getNextSibling() : node.getPreviousSibling()

      if let nextSibling {
        node = nextSibling
        continue
      }

      let parent = node.getParent()

      if let parent {
        if !visited.contains(parent.key) {
          nodes.append(parent)
        }
      }

      if parent == targetNode {
        break
      }

      var parentSibling: Node?
      var ancestor = parent

      if let parent {
        if parent.isSameKey(dfsAncestor) {
          dfsAncestor = nil
        }
      }

      repeat {
        if ancestor == nil {
          fatalError("getNodesBetween: ancestor is nil")
        }

        parentSibling = isBefore ? ancestor?.getNextSibling() : ancestor?.getPreviousSibling()
        ancestor = ancestor?.getParent()

        if ancestor != nil {
          if let ancestor {
            if ancestor.isSameKey(dfsAncestor) {
              dfsAncestor = nil
            }

            if parentSibling == nil && !visited.contains(ancestor.key) {
              nodes.append(ancestor)
            }
          }
        }
      } while parentSibling == nil

      if let parentSibling {
        node = parentSibling
      }
    }

    if !isBefore {
      nodes.reverse()
    }

    return nodes
  }

  func isSameKey(_ object: Node?) -> Bool {
    guard let object else { return false }

    return getKey() == object.getKey()
  }

  public func getKey() -> NodeKey {
    return key
  }

  func isBefore(_ targetNode: Node) -> Bool {
    if targetNode.isParentOf(self) {
      return true
    }

    if isParentOf(targetNode) {
      return false
    }

    let commonAncestor = getCommonAncestor(node: targetNode)

    return getChildIndex(commonAncestor: commonAncestor, node: self) < getChildIndex(commonAncestor: commonAncestor, node: targetNode)
  }

  func getChildIndex(commonAncestor: ElementNode?, node: Node) -> Int {
    var index = 0
    var nodeTemp = node

    while true {
      if let parent = nodeTemp.getParent() {
        if parent == commonAncestor, let childIndex = parent.children.firstIndex(of: nodeTemp.key) {
          index = childIndex
          break
        }

        nodeTemp = parent
      }
    }

    return index
  }

  func isParentOf(_ targetNode: Node) -> Bool {
    var node: Node?

    if key == targetNode.key {
      return false
    }

    node = targetNode

    while node != nil {
      if node?.key == key {
        return true
      }

      node = node?.getParent()
    }

    return false
  }

  /// Returns the parent of this node, or throws if none is found.
  public func getParentOrThrow() throws -> ElementNode {
    guard let parent = getParent() else {
      throw LexicalError.invariantViolation("Expected node \(key) to have a parent.")
    }

    return parent
  }

  /// Returns the text content of the node, typically including its children.
  ///
  /// This is different from ``getTextPart()``, which just returns the text provided by this node.
  public func getTextContent(includeInert: Bool = false, includeDirectionless: Bool = false) -> String {
    return ""
  }

  /// Returns the length of the string produced by calling getTextContent on this node.
  public func getTextContentSize(includeInert: Bool = false, includeDirectionless: Bool = false) -> Int {
    return getTextContent(
      includeInert: includeInert,
      includeDirectionless: includeDirectionless
    ).lengthAsNSString()
  }

  /// Removes this LexicalNode from the EditorState. If the node isn't re-inserted somewhere, the Lexical garbage collector will eventually clean it up.
  open func remove() throws {
    try errorOnReadOnly()
    try Node.removeNode(nodeToRemove: self, restoreSelection: true)
  }

  public static func removeNode(nodeToRemove: Node, restoreSelection: Bool) throws {
    try errorOnReadOnly()
    let key = nodeToRemove.key
    guard let parent = nodeToRemove.getParent() else {
      return
    }

    // if the selection is in one of the node to remove's children, move it into the node to remove.
    let selection = try maybeMoveChildrenSelectionToParent(parentNode: nodeToRemove)

    var selectionMoved = false
    if let selection = selection as? RangeSelection, restoreSelection {
      let anchor = selection.anchor
      let focus = selection.focus
      if anchor.key == key {
        moveSelectionPointToSibling(point: anchor, node: nodeToRemove, parent: parent)
        selectionMoved = true
      }
      if focus.key == key {
        moveSelectionPointToSibling(point: focus, node: nodeToRemove, parent: parent)
        selectionMoved = true
      }
    }

    let writeableParent = try parent.getWritable()
    guard let index = writeableParent.children.firstIndex(of: key) else {
      throw LexicalError.invariantViolation("Node is not a child of its parent")
    }

    internallyMarkNodeAsDirty(node: nodeToRemove, cause: .userInitiated)
    writeableParent.children.remove(at: index)
    let writableNodeToRemove = try nodeToRemove.getWritable()
    writableNodeToRemove.parent = nil

    if let selection = selection as? RangeSelection, restoreSelection && !selectionMoved {
      try updateElementSelectionOnCreateDeleteNode(
        selection: selection,
        parentNode: parent,
        nodeOffset: index,
        times: -1)
    }

    if !isRootNode(node: parent) && !parent.canBeEmpty() && parent.getChildrenSize() == 0 {
      try removeNode(nodeToRemove: parent, restoreSelection: restoreSelection)
    }
  }

  /// Inserts a node after this LexicalNode (as the next sibling).
  @discardableResult
  open func insertAfter(nodeToInsert: Node) throws -> Node {
    try errorOnReadOnly()

    let writableSelf = try getWritable()
    let writableNodeToInsert = try nodeToInsert.getWritable()
    let oldParent = writableNodeToInsert.getParent()
    let selection = try getSelection()

    var elementAnchorSelectionOnNode = false
    var elementFocusSelectionOnNode = false

    if let oldParent {
      try removeFromParent(node: writableNodeToInsert)

      if let selection = selection as? RangeSelection,
        let oldIndex = nodeToInsert.getIndexWithinParent()
      {
        let oldParentKey = oldParent.key
        elementAnchorSelectionOnNode = selection.anchor.type == .element && selection.anchor.key == oldParentKey && selection.anchor.offset == oldIndex + 1
        elementFocusSelectionOnNode = selection.focus.type == .element && selection.focus.key == oldParentKey && selection.focus.offset == oldIndex + 1
      }
    }

    let writableParent = try getParentOrThrow().getWritable()
    let insertKey = writableNodeToInsert.key
    writableNodeToInsert.parent = writableSelf.parent

    guard let index = writableParent.children.firstIndex(where: { $0 == writableSelf.key }) else {
      throw LexicalError.invariantViolation("Node is not a child of its parent")
    }

    writableParent.children.insert(insertKey, at: index + 1)
    internallyMarkSiblingsAsDirty(node: writableNodeToInsert, status: .userInitiated)

    if let selection = selection as? RangeSelection {
      try updateElementSelectionOnCreateDeleteNode(
        selection: selection,
        parentNode: writableParent,
        nodeOffset: index + 1)
      let writableParentKey = writableParent.key

      if elementAnchorSelectionOnNode {
        selection.anchor.updatePoint(key: writableParentKey, offset: index + 2, type: .element)
      }

      if elementFocusSelectionOnNode {
        selection.focus.updatePoint(key: writableParentKey, offset: index + 2, type: .element)
      }
    }

    return nodeToInsert
  }

  /// Inserts a node before this LexicalNode (as the previous sibling).
  @discardableResult
  public func insertBefore(nodeToInsert: Node) throws -> Node {
    try errorOnReadOnly()
    let writableSelf = try getWritable()
    let writableNodeToInsert = try nodeToInsert.getWritable()

    if let oldParent = writableNodeToInsert.getParent() {
      let writableParent = try oldParent.getWritable() as ElementNode
      let children = writableParent.children
      let index = children.firstIndex(of: writableNodeToInsert.key)

      if let index {
        writableParent.children.remove(at: index)
      } else {
        throw LexicalError.invariantViolation("Node is not a child of its parent")
      }

      internallyMarkSiblingsAsDirty(node: writableNodeToInsert, status: .userInitiated)
    }

    let writableParent = try getParentOrThrow().getWritable() as ElementNode
    let insertKey = writableNodeToInsert.key
    writableNodeToInsert.parent = writableSelf.parent
    let children = writableParent.children
    let index = children.firstIndex(of: writableSelf.key)

    if let index {
      writableParent.children.insert(insertKey, at: index)
    } else {
      throw LexicalError.invariantViolation("Node is not a child of its parent")
    }

    internallyMarkSiblingsAsDirty(node: writableNodeToInsert, status: .userInitiated)

    if let selection = try getSelection() as? RangeSelection, let index {
      try updateElementSelectionOnCreateDeleteNode(
        selection: selection,
        parentNode: writableParent,
        nodeOffset: index
      )
    }

    return nodeToInsert
  }

  /// Replaces this LexicalNode with the provided node, optionally transferring the children of the replaced node to the replacing node.
  ///
  /// - Returns: the node that replaced the target node (as a writable copy)
  @discardableResult
  open func replace<T: Node>(replaceWith: T, includeChildren: Bool = false) throws -> T {
    try errorOnReadOnly()
    let toReplaceKey = key
    let writableReplaceWith = try replaceWith.getWritable() as T

    if let oldParent = writableReplaceWith.getParent() {
      let writableParent = try oldParent.getWritable() as ElementNode
      var children = writableParent.children
      let index = children.firstIndex(of: writableReplaceWith.key)

      internallyMarkSiblingsAsDirty(node: writableReplaceWith, status: .userInitiated)

      if let index {
        children.remove(at: index)
      } else {
        throw LexicalError.invariantViolation("Node is not a child of its parent")
      }
    }

    let newParent = try getParentOrThrow()
    let writableParent = try newParent.getWritable() as ElementNode
    let index = writableParent.children.firstIndex(of: key)
    let newKey = writableReplaceWith.key

    if let index {
      writableParent.children.insert(newKey, at: index)
    } else {
      throw LexicalError.invariantViolation("Node is not a child of its parent")
    }

    writableReplaceWith.parent = newParent.key
    try Node.removeNode(nodeToRemove: self, restoreSelection: false)
    internallyMarkSiblingsAsDirty(node: writableReplaceWith, status: .userInitiated)

    if includeChildren, let writableReplaceWith = writableReplaceWith as? ElementNode, let selfElement = self as? ElementNode {
      try writableReplaceWith.append(selfElement.getChildren())
    }

    if let selection = try getSelection() as? RangeSelection { // TODO: the logic here differs from web. Web clones the selection further up. Should make iOS match.
      let anchor = selection.anchor
      let focus = selection.focus

      if anchor.key == toReplaceKey {
        moveSelectionPointToEnd(point: anchor, node: writableReplaceWith)
      }

      if focus.key == toReplaceKey {
        moveSelectionPointToEnd(point: focus, node: writableReplaceWith)
      }
    }

    return writableReplaceWith
  }

  /// Moves selection to the previous sibling of this node, at the specified offsets.
  @discardableResult
  public func selectPrevious(anchorOffset: Int?, focusOffset: Int?) throws -> RangeSelection {
    try errorOnReadOnly()
    let parent = try getParentOrThrow()
    let previousSibling = getPreviousSibling()

    if previousSibling == nil {
      return try parent.select(anchorOffset: 0, focusOffset: 0)
    }

    switch previousSibling {
    case let elementNode as ElementNode:
      return try elementNode.select(anchorOffset: nil, focusOffset: nil)
    case let textNode as TextNode:
      return try textNode.select(anchorOffset: anchorOffset, focusOffset: focusOffset)
    default:
      let index = (previousSibling?.getIndexWithinParent() ?? 0) + 1
      return try parent.select(anchorOffset: index, focusOffset: index)
    }
  }

  /// Moves selection to the next sibling of this node, at the specified offsets.
  public func selectNext(anchorOffset: Int?, focusOffset: Int?) throws -> RangeSelection {
    try errorOnReadOnly()
    let nextSibling = getNextSibling()
    let parent = try getParentOrThrow()

    if nextSibling == nil {
      return try parent.select(anchorOffset: nil, focusOffset: nil)
    }

    switch nextSibling {
    case let elementNode as ElementNode:
      return try elementNode.select(anchorOffset: 0, focusOffset: 0)
    case let textNode as TextNode:
      return try textNode.select(anchorOffset: anchorOffset, focusOffset: focusOffset)
    default:
      let index = nextSibling?.getIndexWithinParent()
      return try parent.select(anchorOffset: index, focusOffset: index)
    }
  }

  public func isSameNode(_ node: Node) -> Bool {
    return getKey() == node.getKey()
  }
}

extension Node: Hashable {
  public func hash(into hasher: inout Hasher) {
    hasher.combine(ObjectIdentifier(self))
  }
}

extension Node: Equatable {
  public static func == (lhs: Node, rhs: Node) -> Bool {
    //    return ObjectIdentifier(lhs) == ObjectIdentifier(rhs)
    return lhs.isSameKey(rhs)
  }

  /// Returns true if there is a path between this node and the RootNode, false otherwise. This is a way of determining if the node is "attached" EditorState. Unattached nodes won't be reconciled and will ultimately be cleaned up by the Lexical GC.
  public func isAttached() -> Bool {
    var nodeKey: NodeKey? = key

    while nodeKey != nil {
      if nodeKey == kRootNodeKey {
        return true
      }

      guard let key = nodeKey, let node = getNodeByKey(key: key) else { break }

      nodeKey = node.parent
    }

    return false
  }

  /// Returns true if this node is contained within the provided Selection., false otherwise. Relies on the algorithms implemented in ``BaseSelection/getNodes()`` to determine what's included.
  public func isSelected() throws -> Bool {
    guard let selection = try getSelection() else {
      return false
    }

    let isSelected = try selection.getNodes().contains(where: { $0.key == self.key })

    if isTextNode(self) {
      return isSelected
    }
    // For inline images inside of element nodes.
    // Without this change the image will be selected if the cursor is before or after it.
    if let selection = selection as? RangeSelection,
      selection.anchor.type == .element && selection.focus.type == .element && selection.anchor.key == selection.focus.key && selection.anchor.offset == selection.focus.offset
    {
      return false
    }
    return isSelected
  }
}
