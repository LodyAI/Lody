# Introduction

Lexical for iOS is an extensible text editor framework written in Swift, backed by TextKit/UIKit. 

## Overview

Lexical iOS aims to be sympathetic counterpart to [Lexical JavaScript](https://lexical.dev/docs/intro), with similar or identical functions for manipulating the data model, but a platform-specific design for interoperating with TextKit. For example, where on Lexical JS, the data model is mapped to a DOM tree and styling elements is handled by CSS classes, on iOS, the data model is mapped to an attributed string and styling happens by means of applying attributes.

Lexical works by attaching itself to a TextKit stack (i.e. our set of custom subclasses of `NSLayoutManager`, `NSTextContainer` and `NSTextStorage`). From there you can work with Lexical's declarative APIs to make things happen without needing to worry about specific edge-cases around attributed string creation, text ranges, UIKit events and the like. This TextKit stack is owned by a Lexical frontend. We currently ship with two frontends, ``LexicalView`` (an editable text frontend that uses UITextView behind the scenes), and ``LexicalReadOnlyView`` (a simpler view for rendering read-only text, with support for height calculations and custom truncation).

### What can be built with Lexical iOS?

Lexical iOS can create complex rich-text editing experiences (like Lexical JS), and it can also be used to create read-only text experiences. These read-only experiences let you use the same Lexical plugins for styling text and working with the expressive Lexical data model, making things such as custom drawing much easier than building straight on top of TextKit. Here are some (but not all) examples of what you can do with Lexical:

* Simple plain-text editors that have more requirements than a basic `UITextView`, such as requiring features like mentions, custom emojis, links and hashtags.
* More complex rich-text editors that can be used to post content on blogs, social media, messaging applications.
* A full-blown WYSIWYG editor that can be used in a CMS or rich content editor.
* Read-only text display with height calculation, so that your read-only experience can use the same rendering code as your editing experience.

### Editor Instances

Editor instances are the core thing that wires everything together. You can attach a TextKit stack to editor instances, and also register listeners and commands. Most importantly, the editor allows for updates to its ``EditorState``. You can create an editor instance by instantiating ``Editor``, however you normally would create an instance of one of our frontends (``LexicalView`` or ``LexicalReadOnlyView``), and the frontend would create the Editor for you. (There is also the option to create a headless Editor, if you just need to manipulate a data model with no rendering. You can do this with ``Editor/createHeadless(editorConfig:)``.)

### Editor States​

An Editor State is the underlying data model that represents what you want to show on the DOM. Editor States contain two parts:

* a Lexical node tree
* a Lexical selection object

Editor States are immutable once created, and in order to create one, you must do so via ``Editor/update(_:)``. However, you can also "hook" into an existing update using node transforms or command handlers – which are invoked as part of an existing update workflow to prevent cascading/water-falling of updates. You can retrieve the current editor state using ``Editor/getEditorState()``.

Editor States are also fully serializable to and from JSON using ``EditorState/toJSON()`` and ``EditorState/fromJSON(json:editor:)``.

### Editor Updates

When you want to change something in an Editor State, you must do it via an update, ``Editor/update(_:)``. The closure passed to the update call is important. It's a place where you have full "lexical" context of the active editor state, and it exposes access to the underlying Editor State's node tree. In Lexical JS, functions that must be inside an update closure are prefixed with a `$`. This is not the case on iOS, alas, as in Swift you cannot start a function name with a `$`. (Suggestions for an alternative naming scheme are welcome!) Attempting to use them outside of an update will trigger a runtime error with an appropriate error. 

### TextStorage Reconciler

Lexical has its own reconciler that takes a set of Editor States (always the "current" and the "pending") and applies a "diff" on them. It then uses this diff to update only the parts of the `NSTextStorage` that need changing. TextKit is then smart enough to notice the location of Lexical's updates within the attributed string, and to trigger re-rendering where needed.

### Listeners, Node Transforms and Commands​

Outside of invoking updates, the bulk of work done with Lexical is via listeners, node transforms and commands. These all stem from the editor and are prefixed with `register`. Another important feature is that all the register methods return a function to easily unsubscribe them. For example here is how you listen to an update to a Lexical editor:

```swift
let unregisterListener = editor.registerUpdateListener { activeEditorState, previousEditorState, dirtyNodes in
  print(activeEditorState)
}

// Ensure we remove the listener later!
unregisterListener();
```

Commands are the communication system used to wire everything together in Lexical. Custom commands can be created using ``Editor/registerCommand(type:listener:priority:)`` and dispatched to an editor using ``Editor/dispatchCommand(type:payload:)``. Lexical dispatches commands internally when key presses are triggered and when other important signals occur. Incoming commands are propagated through all handlers by priority until a handler stops the propagation (in a similar way to event propagation in the browser).




