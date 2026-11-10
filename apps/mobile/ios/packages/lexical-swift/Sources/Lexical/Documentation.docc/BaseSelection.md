# ``Lexical/BaseSelection``

## Topics

### Cloning & Equality

- ``BaseSelection/clone()``
- ``isSelection(_:)``
- ``dirty``

### Reading

- ``getNodes()``
- ``extract()``
- ``getTextContent()``

### Modifying

- ``insertNodes(nodes:selectStart:)``
- ``insertRawText(_:)``

### Event handling

- ``deleteCharacter(isBackwards:)``
- ``deleteWord(isBackwards:)``
- ``deleteLine(isBackwards:)``
- ``insertText(_:)``
- ``insertParagraph()``
- ``insertLineBreak(selectStart:)``
