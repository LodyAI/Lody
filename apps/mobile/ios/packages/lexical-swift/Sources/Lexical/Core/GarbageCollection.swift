/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

internal func garbageCollectDetachedDeepChildNodes(
  node: ElementNode,
  parentKey: NodeKey,
  prevNodeMap: [NodeKey: Node],
  nodeMap: [NodeKey: Node],
  dirtyNodes: DirtyNodeMap
) {
  var dirtyNodes = dirtyNodes
  var nodeMap = nodeMap
  let children = node.children

  for childKey in children {
    let child = nodeMap[childKey]

    if let child = child as? ElementNode, child.parent == parentKey {
      garbageCollectDetachedDeepChildNodes(
        node: child,
        parentKey: childKey,
        prevNodeMap: prevNodeMap,
        nodeMap: nodeMap,
        dirtyNodes: dirtyNodes
      )
    }

    if prevNodeMap[childKey] == nil {
      dirtyNodes.removeValue(forKey: childKey)
    }

    nodeMap.removeValue(forKey: childKey)
  }
}

func garbageCollectDetachedNodes(
  prevEditorState: EditorState,
  editorState: EditorState,
  dirtyLeaves: DirtyNodeMap
) {
  let prevNodeMap = prevEditorState.nodeMap
  var nodeMap = editorState.nodeMap
  var dirtyLeaves = dirtyLeaves
  var dirtyElements = DirtyNodeMap()

  for (nodeKey, _) in dirtyLeaves {
    if let node = nodeMap[nodeKey] {
      if node is ElementNode {
        dirtyElements[nodeKey] = .editorInitiated
        continue
      }
      if !node.isAttached() {
        if prevNodeMap[nodeKey] == nil {
          dirtyLeaves.removeValue(forKey: nodeKey)
        }

        nodeMap.removeValue(forKey: nodeKey)
      }
    }
  }

  for (nodeKey, _) in dirtyElements {
    if let node = nodeMap[nodeKey] {
      if !node.isAttached() {
        if let node = node as? ElementNode {
          garbageCollectDetachedDeepChildNodes(node: node, parentKey: nodeKey, prevNodeMap: prevNodeMap, nodeMap: nodeMap, dirtyNodes: dirtyElements)
        }

        if prevNodeMap[nodeKey] == nil {
          dirtyElements.removeValue(forKey: nodeKey)
        }

        nodeMap.removeValue(forKey: nodeKey)
      }
    }
  }

  editorState.nodeMap = nodeMap
}
