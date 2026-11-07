/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import Lexical
import UIKit

extension CommandType {
  public static let link = CommandType(rawValue: "link")
  public static let removeLink = CommandType(rawValue: "removeLink")
}

public struct LinkPayload {
  let urlString: String?
  let originalSelection: RangeSelection?

  public init(urlString: String?, originalSelection: RangeSelection?) {
    self.urlString = urlString
    self.originalSelection = originalSelection
  }
}

open class LinkPlugin: Plugin {
  public init() {}

  weak var editor: Editor?
  public weak var lexicalView: LexicalView?

  public func setUp(editor: Editor) {
    self.editor = editor
    do {
      try editor.registerNode(nodeType: NodeType.link, class: LinkNode.self)
      try editor.registerNode(nodeType: NodeType.autoLink, class: AutoLinkNode.self)
    } catch {
      print("\(error)")
    }

    _ = editor.registerCommand(
      type: .link,
      listener: { [weak self] payload in
        guard let self,
          let linkPayload = payload as? LinkPayload,
          let editor = self.editor
        else { return false }

        self.insertLink(linkPayload: linkPayload, editor: editor)
        return true
      })

    _ = editor.registerCommand(
      type: .removeLink,
      listener: { [weak self] _ in
        guard let self,
          let editor = self.editor
        else { return false }

        self.insertLink(linkPayload: nil, editor: editor)
        return true
      })
  }

  public func tearDown() {
  }

  public func createLinkNode(url: String) -> LinkNode {
    LinkNode(url: url, key: nil)
  }

  public func isLinkNode(_ node: Node?) -> Bool {
    node is LinkNode
  }

  func insertLink(linkPayload: LinkPayload?, editor: Editor) {
    do {
      var modifiedSelection: BaseSelection?
      try editor.update {
        getActiveEditorState()?.selection = linkPayload?.originalSelection
        try toggleLink(url: linkPayload?.urlString)
        modifiedSelection = try getSelection()?.clone()
      }
      lexicalView?.textViewBecomeFirstResponder()
      try editor.update {
        getActiveEditorState()?.selection = modifiedSelection
      }
    } catch {
      print("\(error)")
    }
  }

  func toggleLink(url: String?) throws {
    guard let selection = try getSelection() else { return }
    var nodes = try selection.extract()

    guard let url else {
      // Remove linkNode
      try nodes.forEach { node in
        if let parent = node.getParent() as? LinkNode {
          for child in parent.getChildren() {
            try parent.insertBefore(nodeToInsert: child)
          }

          try parent.remove()
        }
      }
      return
    }

    if nodes.isEmpty || (nodes.count == 1 && nodes.first is ElementNode) {
      // We have a URL but no nodes. Insert a text node representing the URL.
      let node = TextNode(text: url)
      let result = try selection.insertNodes(nodes: [node], selectStart: false)
      if result {
        nodes = [node]
      } else {
        // could not insert node
        return
      }
    }

    // Add or merge LinkNodes
    if nodes.count == 1 {
      // if the firstNode is LinkNode or if its parent is a LinkNode, we update the url
      if let firstNode = nodes.first as? LinkNode {
        try firstNode.setURL(url)
        return
      } else if let parent = nodes.first?.getParent() as? LinkNode {
        // set parent to be current linkNode so that other nodes in the same parent aren't handled separately below.
        try parent.setURL(url)
        return
      }
    }

    var prevParent: ElementNode?
    var linkNode: LinkNode?

    try nodes.forEach { node in
      let parent = node.getParent()

      if let elementNode = node as? ElementNode, !elementNode.isInline() || parent == linkNode || parent == nil {
        return
      }

      if let parentNode = parent as? LinkNode {
        linkNode = parentNode
        try parentNode.setURL(url)
        return
      }

      if parent != prevParent {
        prevParent = parent
        linkNode = createLinkNode(url: url)

        guard let linkNode else {
          return
        }

        if isLinkNode(parent) {
          if node.getPreviousSibling() == nil {
            try parent?.insertBefore(nodeToInsert: linkNode)
          } else {
            try parent?.insertAfter(nodeToInsert: linkNode)
          }
        } else {
          try node.insertBefore(nodeToInsert: linkNode)
        }
      }

      if isLinkNode(node) {
        if node == linkNode {
          return
        }

        if linkNode != nil {
          guard let elementNode = node as? ElementNode else { return }

          let children = elementNode.getChildren()
          for child in children {
            try linkNode?.append([child])
          }
        }

        try node.remove()
        return
      }

      if linkNode != nil {
        try linkNode?.append([node])
      }
    }
  }
}
