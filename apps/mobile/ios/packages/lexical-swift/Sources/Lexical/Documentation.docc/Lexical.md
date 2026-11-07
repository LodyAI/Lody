#  ``Lexical``

Lexical for iOS is an extensible text rendering and editing framework written in Swift, backed by TextKit/UIKit.

## Topics

### Releases

- <doc:Changelog>

### Articles

- <doc:Introduction>
- <doc:QuickStart>
- <doc:Theming>

### Building your own node classes

- <doc:BuildingNodes>
- <doc:BuildingDecorators>
- <doc:CustomDrawing>

### Primary Classes

- ``Editor``
- ``EditorState``
- ``EditorConfig``
- ``BaseSelection``
- ``RangeSelection``
- ``Theme``
- ``Plugin``
- ``FeatureFlags``

### Frontend

- ``LexicalView``
- ``LexicalViewDelegate``
- ``LexicalReadOnlyView``
- ``LexicalReadOnlyTextKitContext``

### Nodes

- ``NodeType``
- ``NodeKey``
- ``Node``
- ``ElementNode``
- ``RootNode``
- ``ParagraphNode``
- ``DecoratorNode``
- ``LineBreakNode``
- ``UnknownNode``

### Text Nodes

- ``TextNode``
- ``TextFormat``
- ``TextFormatType``
- ``TextNodeThemeSubtype``

### Built-in Nodes

- ``HeadingNode``
- ``HeadingTagType``
- ``CodeNode``
- ``CodeHighlightNode``
- ``QuoteNode``

### Selection

- ``BaseSelection``
- ``SelectionType``
- ``RangeSelection``
- ``NodeSelection``
- ``GridSelection``
- ``Point``
- ``NativeSelection``

### History (undo/redo)

- ``HistoryState``
- ``HistoryStateEntry``
- ``EditorHistory``

### Attributes

- ``BlockLevelAttributes``
- ``CodeBlockCustomDrawingAttributes``
- ``QuoteCustomDrawingAttributes``

### Custom Drawing

- ``CustomDrawingLayer``
- ``CustomDrawingHandler``
- ``CustomDrawingGranularity``

### Logging

- ``LogLevel``
- ``LogFeature``
- ``LogPayload``
- ``Editor/log(_:_:_:_:)``

### TextKit

- ``LayoutManager``
- ``TextStorage``
- ``TextContainer``
- ``TextAttachment``
