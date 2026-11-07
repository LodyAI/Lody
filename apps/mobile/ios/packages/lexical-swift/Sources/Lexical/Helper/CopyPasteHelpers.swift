/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import MobileCoreServices
import UIKit
import UniformTypeIdentifiers

internal func setPasteboard(selection: BaseSelection, pasteboard: UIPasteboard) throws {
  guard let editor = getActiveEditor() else {
    throw LexicalError.invariantViolation("Could not get editor")
  }
  let nodes = try generateArrayFromSelectedNodes(editor: editor, selection: selection).nodes
  let encodedData = try JSONEncoder().encode(nodes)
  guard let jsonString = String(data: encodedData, encoding: .utf8) else { return }

  let itemProvider = NSItemProvider()
  itemProvider.registerItem(forTypeIdentifier: LexicalConstants.pasteboardIdentifier) { completionHandler, expectedValueClass, options in
    let data = NSData(data: jsonString.data(using: .utf8) ?? Data())
    completionHandler?(data, nil)
  }

  if #available(iOS 14.0, *) {
    pasteboard.items =
      [
        [
          (UTType.rtf.identifier): try getAttributedStringFromFrontend().data(
            from: NSRange(location: 0, length: getAttributedStringFromFrontend().length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        ],
        [LexicalConstants.pasteboardIdentifier: encodedData],
      ]
  } else {
    pasteboard.items =
      [
        [
          (kUTTypeRTF as String): try getAttributedStringFromFrontend().data(
            from: NSRange(location: 0, length: getAttributedStringFromFrontend().length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        ],
        [LexicalConstants.pasteboardIdentifier: encodedData],
      ]
  }
}

internal func insertDataTransferForRichText(selection: RangeSelection, pasteboard: UIPasteboard) throws {
  let itemSet: IndexSet?
  if #available(iOS 14.0, *) {
    itemSet = pasteboard.itemSet(
      withPasteboardTypes: [
        (UTType.utf8PlainText.identifier),
        (UTType.url.identifier),
        LexicalConstants.pasteboardIdentifier,
      ]
    )
  } else {
    itemSet = pasteboard.itemSet(
      withPasteboardTypes: [
        (kUTTypeUTF8PlainText as String),
        (kUTTypeURL as String),
        LexicalConstants.pasteboardIdentifier,
      ]
    )
  }

  if let pasteboardData = pasteboard.data(
    forPasteboardType: LexicalConstants.pasteboardIdentifier,
    inItemSet: itemSet)?.last
  {
    let deserializedNodes = try JSONDecoder().decode(SerializedNodeArray.self, from: pasteboardData)

    guard let editor = getActiveEditor() else { return }

    _ = try insertGeneratedNodes(editor: editor, nodes: deserializedNodes.nodeArray, selection: selection)
    return
  }

  if #available(iOS 14.0, *) {
    if let pasteboardRTFData = pasteboard.data(
      forPasteboardType: (UTType.rtf.identifier),
      inItemSet: itemSet)?.last
    {
      let attributedString = try NSAttributedString(
        data: pasteboardRTFData,
        options: [.documentType: NSAttributedString.DocumentType.rtf],
        documentAttributes: nil
      )
      try insertRTF(selection: selection, attributedString: attributedString)
      return
    }
  } else {
    if let pasteboardRTFData = pasteboard.data(
      forPasteboardType: (kUTTypeRTF as String),
      inItemSet: itemSet)?.last
    {
      let attributedString = try NSAttributedString(
        data: pasteboardRTFData,
        options: [.documentType: NSAttributedString.DocumentType.rtf],
        documentAttributes: nil
      )

      try insertRTF(selection: selection, attributedString: attributedString)
      return
    }
  }

  if #available(iOS 14.0, *) {
    if let pasteboardStringData = pasteboard.data(
      forPasteboardType: (UTType.utf8PlainText.identifier),
      inItemSet: itemSet)?.last
    {
      try insertPlainText(selection: selection, text: String(decoding: pasteboardStringData, as: UTF8.self))
      return
    }
  } else {
    if let pasteboardStringData = pasteboard.data(
      forPasteboardType: (kUTTypeUTF8PlainText as String),
      inItemSet: itemSet)?.last
    {
      try insertPlainText(selection: selection, text: String(decoding: pasteboardStringData, as: UTF8.self))
      return
    }
  }

  if let url = pasteboard.urls?.first as? URL {
    let string = url.absoluteString
    try insertPlainText(selection: selection, text: string)
    return
  }
}

internal func insertPlainText(selection: RangeSelection, text: String) throws {
  var stringArray: [String] = []
  let range = text.startIndex..<text.endIndex
  text.enumerateSubstrings(in: range, options: .byParagraphs) { subString, _, _, _ in
    stringArray.append(subString ?? "")
  }

  if stringArray.count == 1 {
    try selection.insertText(text)
  } else {
    var nodes: [Node] = []
    var i = 0
    for part in stringArray {
      let textNode = createTextNode(text: String(part))
      if i != 0 {
        let paragraphNode = createParagraphNode()
        try paragraphNode.append([textNode])
        nodes.append(paragraphNode)
      } else {
        nodes.append(textNode)
      }
      i += 1
    }

    _ = try selection.insertNodes(nodes: nodes, selectStart: false)
  }
}

internal func insertRTF(selection: RangeSelection, attributedString: NSAttributedString) throws {
  let paragraphs = attributedString.splitByNewlines()

  var nodes: [Node] = []
  var i = 0

  for paragraph in paragraphs {
    var extractedAttributes = [(attributes: [NSAttributedString.Key: Any], range: NSRange)]()
    paragraph.enumerateAttributes(in: NSRange(location: 0, length: paragraph.length)) { (dict, range, stopEnumerating) in
      extractedAttributes.append((attributes: dict, range: range))
    }

    var nodeArray: [Node] = []
    for attribute in extractedAttributes {
      let text = paragraph.attributedSubstring(from: attribute.range).string
      let textNode = createTextNode(text: text)

      if (attribute.attributes.first(where: { $0.key == .font })?.value as? UIFont)?
        .fontDescriptor.symbolicTraits.contains(.traitBold) ?? false
      {
        textNode.format.bold = true
      }

      if (attribute.attributes.first(where: { $0.key == .font })?.value as? UIFont)?
        .fontDescriptor.symbolicTraits.contains(.traitItalic) ?? false
      {
        textNode.format.italic = true
      }

      if let underlineAttribute = attribute.attributes[.underlineStyle] {
        if underlineAttribute as? NSNumber != 0 {
          textNode.format.underline = true
        }
      }

      if let strikethroughAttribute = attribute.attributes[.strikethroughStyle] {
        if strikethroughAttribute as? NSNumber != 0 {
          textNode.format.strikethrough = true
        }
      }

      nodeArray.append(textNode)
    }

    if i != 0 {
      let paragraphNode = createParagraphNode()
      try paragraphNode.append(nodeArray)
      nodes.append(paragraphNode)
    } else {
      nodes.append(contentsOf: nodeArray)
    }
    i += 1
  }

  _ = try selection.insertNodes(nodes: nodes, selectStart: false)
}

public func insertGeneratedNodes(editor: Editor, nodes: [Node], selection: RangeSelection) throws {
  return try basicInsertStrategy(nodes: nodes, selection: selection)
}

func basicInsertStrategy(nodes: [Node], selection: RangeSelection) throws {
  var topLevelBlocks = [Node]()
  var currentBlock: ElementNode?
  for (index, _) in nodes.enumerated() {
    let node = nodes[index]
    if ((node as? ElementNode)?.isInline() ?? false) || isTextNode(node) || isLineBreakNode(node) {
      if let currentBlock {
        try currentBlock.append([node])
      } else {
        let paragraphNode = createParagraphNode()
        topLevelBlocks.append(paragraphNode)
        try paragraphNode.append([node])
        currentBlock = paragraphNode
      }
    } else {
      topLevelBlocks.append(node)
      currentBlock = nil
    }
  }

  _ = try selection.insertNodes(nodes: topLevelBlocks, selectStart: false)
}

func appendNodesToArray(
  editor: Editor,
  selection: BaseSelection?,
  currentNode: Node,
  targetArray: [Node] = []
) throws -> (shouldInclude: Bool, outArray: [Node]) {
  var array = targetArray
  var shouldInclude = selection != nil ? try currentNode.isSelected() : true
  let shouldExclude = (currentNode as? ElementNode)?.excludeFromCopy() ?? false
  var clone = try cloneWithProperties(node: currentNode)
  (clone as? ElementNode)?.children = []

  if let textClone = clone as? TextNode {
    if let selection {
      clone = try sliceSelectedTextNodeContent(selection: selection, textNode: textClone)
    }
  }

  guard let key = try generateKey(node: clone) else {
    throw LexicalError.invariantViolation("Could not generate key")
  }
  clone.key = key
  editor.getEditorState().nodeMap[key] = clone

  let children = (currentNode as? ElementNode)?.getChildren() ?? []
  var cloneChildren: [Node] = []

  for childNode in children {
    let internalCloneChildren: [Node] = []
    let shouldIncludeChild = try appendNodesToArray(
      editor: editor,
      selection: selection,
      currentNode: childNode,
      targetArray: internalCloneChildren
    )

    if !shouldInclude && shouldIncludeChild.shouldInclude && ((currentNode as? ElementNode)?.extractWithChild(child: childNode, selection: selection, destination: .clone) ?? false) {
      shouldInclude = true
    }

    cloneChildren.append(contentsOf: shouldIncludeChild.outArray)
  }

  for child in cloneChildren {
    (clone as? ElementNode)?.children.append(child.key)
  }

  if shouldInclude && !shouldExclude {
    array.append(clone)
  } else if let children = (clone as? ElementNode)?.children {
    for childKey in children {
      if let childNode = editor.getEditorState().nodeMap[childKey] {
        array.append(childNode)
      }
    }
  }

  return (shouldInclude, array)
}

public func generateArrayFromSelectedNodes(
  editor: Editor, selection: BaseSelection?
) throws -> (
  namespace: String,
  nodes: [Node]
) {
  var nodes: [Node] = []
  guard let root = getRoot() else {
    return ("", [])
  }
  for topLevelNode in root.getChildren() {
    var nodeArray: [Node] = []
    nodeArray = try appendNodesToArray(editor: editor, selection: selection, currentNode: topLevelNode, targetArray: nodeArray).outArray
    nodes.append(contentsOf: nodeArray)
  }
  return (
    namespace: "lexical",
    nodes
  )
}

// MARK: Extensions

extension NSAttributedString {
  public func splitByNewlines() -> [NSAttributedString] {
    var result = [NSAttributedString]()
    var rangeArray: [NSRange] = []

    (string as NSString).enumerateSubstrings(
      in: NSRange(location: 0, length: (string as NSString).length),
      options: .byParagraphs
    ) { subString, subStringRange, enclosingRange, stop in
      rangeArray.append(subStringRange)
    }

    for range in rangeArray {
      let attributedString = attributedSubstring(from: range)
      result.append(attributedString)
    }
    return result
  }
}
