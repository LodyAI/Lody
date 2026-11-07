# ``Lexical/Editor``

## Topics

### Initialisation

- ``init(editorConfig:)``
- ``createHeadless(editorConfig:)``

### Registering listeners and other things

- ``registerUpdateListener(listener:)``
- ``registerTextContentListener(listener:)``
- ``registerCommand(type:listener:priority:)``
- ``registerNode(nodeType:constructor:)``
- ``addNodeTransform(nodeType:transform:)``
- ``registerCustomDrawing(customAttribute:layer:granularity:handler:)``
- ``registerErrorListener(listener:)``

### Working with the EditorState

- ``getEditorState()``
- ``setEditorState(_:)``
- ``resetEditor(pendingEditorState:)``
- ``clearEditor()``
- ``read(_:)``
- ``update(_:)``

### Dispatching commands

- ``dispatchCommand(type:payload:)``

### Getters

- ``getTheme()``
- ``isComposing()``

### Objective C compatibility

- ``getTextContentObjC()``
- ``registerCommandObjC(_:priority:block:)``
