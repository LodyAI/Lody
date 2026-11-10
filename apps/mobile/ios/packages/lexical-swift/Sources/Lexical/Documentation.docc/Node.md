# ``Lexical/Node``

## Topics

### Initialization and serialization

- ``init()``
- ``init(_:)``
- ``init(from:)``
- ``clone()``
- ``encode(to:)``

### Lifecycle

- ``getLatest()``
- ``getWritable()``

### Working with Editors

- ``didMoveTo(newEditor:)``

### Output

- ``getPreamble()``
- ``getPostamble()``
- ``getTextPart()``
- ``getTextContent(includeInert:includeDirectionless:)``
- ``getTextContentSize(includeInert:includeDirectionless:)``

### Theming

- ``getAttributedStringAttributes(theme:)``
- ``getBlockLevelAttributes(theme:)``

### Traversing the node tree

- ``getCommonAncestor(node:)``
- ``getIndexWithinParent()``
- ``getNextSibling()``
- ``getNextSiblings()``
- ``getNodesBetween(targetNode:)``
- ``getParent()``
- ``getParentOrThrow()``
- ``getParents()``
- ``getParentKeys()``
- ``getPreviousSibling()``
- ``getPreviousSiblings()``
- ``getTopLevelElement()``
- ``getTopLevelElementOrThrow()``
- ``isAttached()``
- ``isSelected()``

### Manipulating the node tree

- ``insertAfter(nodeToInsert:)``
- ``insertBefore(nodeToInsert:)``
- ``remove()``
- ``replace(replaceWith:)``
- ``removeNode(nodeToRemove:restoreSelection:)``
- ``selectNext(anchorOffset:focusOffset:)``
- ``selectPrevious(anchorOffset:focusOffset:)``

