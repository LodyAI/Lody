# Quick Start

This section covers how to use Lexical with UIKit to support editable text.

## Overview

You interact with Lexical in a few ways:

* To get some text onto the screen, use one of the Lexical frontends, such as ``LexicalView``.
* To programatically manipulate the data model, you talk to the ``Editor``. Usually the frontend you're using creates the editor, and gives you access to it.
* If you want to work with a Lexical data model without rendering anything on screen, you can use an Editor directly in headless mode.

In this article we will be using ``LexicalView`` as our frontend. `LexicalView` encapsulates a `UITextView` and supports editable text, keyboard input etc.

## Creating a LexicalView

```swift
// set up your plugins
let listPlugin = ListPlugin()
let loggingPlugin = MetaLexicalLoggingPlugin()
let linkPlugin = LinkPlugin()
let autoLinkPlugin = AutoLinkPlugin()
let imagePlugin = InlineImagePlugin()

// set up your theme
let theme = Theme()
theme.paragraph = [
  .fontSize: CGFloat(15),
  .foregroundColor: UIColor.black,
]

// create the view
let lexicalView = LexicalView(
  editorConfig: EditorConfig(
    theme: theme,
    plugins: [listPlugin, loggingPlugin, linkPlugin, autoLinkPlugin, imagePlugin]
  ), featureFlags: FeatureFlags())

// add it to the view hierarchy
lexicalView.frame = CGRect(x: 0, y: 0, width: 300, height: 200)
self.view.addSubview(lexicalView)
```

As you can see, a ``LexicalView`` takes an ``EditorConfig`` as a passed in parameter, which holds a ``Theme`` and some ``Plugin``s.

Without any plugins, Lexical can function as a rich text editor with support for basic text styling, headings, etc. However plugins can add additional node types and do more customisation.

## Working with Editor States

With Lexical, the source of truth is not the `NSTextStorage`, but rather an underlying state model that Lexical maintains and associates with an editor instance. You can get the latest editor state from an editor by calling `editor.getEditorState()`.

To access the editor, you can simply access `lexicalView.editor`. For example:

```swift
let editor = self.lexicalView.editor
let currentEditorState = editor.getEditorState()

// turn the editor state into stringified JSON
guard let jsonString = try? currentEditorState.toJSON() else { /* handle error */ }

// turn the JSON back into a new editor state
guard let newEditorState = try? EditorState.fromJSON(json: jsonString, editor: editor) else { /* ... */ }

// install the new editor state into your editor
try? editor.setEditorState(newEditorState)
```

Obviously the code above is not very useful -- we end up with a new editor state that is identical in content to our old one. But it shows how the editor state can be extracted, serialised, etc.

## Updating an editor

If you want to make programmatic changes to the content of your editor, there are a few ways to do it:

* Trigger an update with ``Editor/update(_:)``
* Setting the editor state via ``Editor/setEditorState(_:)``
* Applying a change as part of an existing update via ``Editor/addNodeTransform(nodeType:transform:)``
* Using a command listener with ``Editor/registerCommand(type:listener:priority:)``

The most common way to update the editor is to use ``Editor/update(_:)``. Calling this function requires a closure to be passed in that will provide access to mutate the underlying editor state. When starting a fresh update, the current editor state is cloned and used as the starting point. From a technical perspective, this means that Lexical leverages a technique called double-buffering during updates. There's an editor state to represent what is current on the screen, and another work-in-progress editor state that represents future changes.

> Tip: In Lexical JavaScript, updates are asynchronous; however in iOS they are synchronous. You must not dispatch to another thread during an update.

Here's an example of how you can update an editor instance:

```swift
try editor.update {
  // Get the RootNode from the EditorState
  guard let root = getRoot() else { /* ... */ }

  // Get the selection from the EditorState
  guard let selection = try getSelection() else { /* ... */ }

  // Create a new ParagraphNode
  let paragraphNode = ParagraphNode()

  // Create a new TextNode
  let textNode = TextNode(text: "Hello world")

  // Append the text node to the paragraph
  try paragraphNode.append([textNode])

  // Finally, append the paragraph to the root
  try root.append([paragraphNode])
}
```

## User input and update listeners

The ``LexicalView`` handles user input: selection, typing, deleting, etc. 

The Lexical editor state is updated based on the user interaction, which in turn drives the updating of the text the user can see on the screen. Thus the Lexical editor state is always the source of truth.

If you want to know when the editor updates so you can react to the changes, you can add an update listener to the editor, as shown below:

```swift
_ = editor.registerUpdateListener(listener: { editorState, previousEditorState, dirtyNodes in
  // The latest EditorState can be found as `editorState`.
  // To read the contents of the EditorState, use the following API:

  try editorState.read {
    // Just like editor.update(), .read() expects a closure where you can use
    // functions that access the data model of the editor state.
  }
})
```

> Warning: In Lexical JavaScript, function names are prefixed with `$` if you can only use them inside `update` or `read` blocks.
>
> But since Swift does not support a `$` at the start of a function name, we have not used this convention in Lexical iOS. 
