/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

// MARK: - Datatypes
enum PartialCodingKeys: String, CodingKey {
  case type
}

public struct SerializedEditorState: Codable {
  enum RootCodingKeys: String, CodingKey {
    case root
  }

  public var rootNode: RootNode?

  public init(rootNode: RootNode) {
    self.rootNode = rootNode
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: RootCodingKeys.self)
    self.rootNode = try container.decode(RootNode.self, forKey: .root)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: RootCodingKeys.self)
    try container.encode(rootNode, forKey: .root)
  }
}

public struct SerializedNodeArray: Decodable {
  enum PartialCodingKeys: String, CodingKey {
    case type
  }

  public var nodeArray: [Node]

  public init(nodeArray: [Node]) {
    self.nodeArray = nodeArray
  }

  public init(from decoder: Decoder) throws {
    var container = try decoder.unkeyedContainer()
    var nodeArray = [Node]()

    self.nodeArray = nodeArray

    guard let editor = getActiveEditor() else { return }

    let deserializationMap = editor.registeredNodes

    while !container.isAtEnd {
      var containerCopy = container
      let unprocessedContainer = try container.nestedContainer(keyedBy: PartialCodingKeys.self)
      let type = try NodeType(rawValue: unprocessedContainer.decode(String.self, forKey: .type))
      let klass = deserializationMap[type] ?? UnknownNode.self
      nodeArray.append(try decodeNodePreservingJSON(klass, from: containerCopy.superDecoder()))
    }

    self.nodeArray = nodeArray
  }
}

public typealias DeserializationConstructor = (Decoder) throws -> Node
typealias DeserializationMapping = [NodeType: DeserializationConstructor]

// A node whose registered class rejects its JSON is kept verbatim rather than dropped from the document.
func decodeNodePreservingJSON(_ klass: Node.Type, from decoder: Decoder) throws -> Node {
  do {
    return try klass.init(from: decoder)
  } catch {
    getActiveEditor()?.log(.other, .error, "Keeping undecodable node verbatim: \(error)")
    return UnknownNode(data: try decoder.singleValueContainer().decode(UnknownNode.SupportedValue.self))
  }
}

// MARK: - Utilities

// NB: We are assuming JSON serialization here initially
let sharedDecoder = JSONDecoder()

let defaultDeserializationMapping: DeserializationMapping = [
  NodeType.root: { decoder in try RootNode(from: decoder) },
  NodeType.text: { decoder in try TextNode(from: decoder) },
  NodeType.element: { decoder in try ElementNode(from: decoder) },
  NodeType.heading: { decoder in try HeadingNode(from: decoder) },
  NodeType.paragraph: { decoder in try ParagraphNode(from: decoder) },
  NodeType.quote: { decoder in try QuoteNode(from: decoder) },
]

func makeDeserializationMap() -> DeserializationMapping {
  return defaultDeserializationMapping
}
