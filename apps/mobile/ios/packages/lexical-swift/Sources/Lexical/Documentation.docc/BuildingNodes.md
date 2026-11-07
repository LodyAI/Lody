# Building Custom Node Classes

There's a lot you can do with the built in node classes, in conjunction with <doc:Theming>. But sometimes you need more control and customisation. Read on!

## Types of node

The three main types of node that you may want to subclass are ``ElementNode``, ``TextNode`` and ``DecoratorNode``. First you'll need to choose between them.

### Element Nodes

These nodes don't contain any text of their own, but they can have child nodes. For example, a Heading node is an Element node -- the text of the heading is attached to a ``TextNode`` that is a child of the ``HeadingNode``. One reason that this is a good choice is, the user might want to make a single word within a heading have some formatting, like Italic. The only way to do this is by having multiple Text nodes within the heading. If Heading node was a subclass of TextNode, it would not be possible to format a subset of the heading text.

You can still use Element nodes to apply styling and custom rendering behaviour to their content.

Element nodes can contain any kind of node as children: TextNodes, Decorators, other Elements...

### Text Nodes

A Text node is a leaf node. It is the thing that actually contains text. You might want to subclass ``TextNode`` if you want to add a new kind of inline styling.

### Decorator Nodes

Decorator nodes are special: these provide a way to embed an arbitrary UIView to be displayed inline inside the Lexical document. For more information on decorator nodes, read: <doc:BuildingDecorators>.

Decorator nodes are leaf nodes: they don't contain child nodes. (If they did, Lexical wouldn't know what to do with them, because a decorator node just renders as its associated UIView.) If you want a decorator to wrap some other Lexical nodes, you need to use Nested Editors, and put a new Lexical instance into your decorator's UIView.

## Defining your new class

Here's an example node definition:

```swift
extension NodeType {
  static let link = NodeType(rawValue: "link")
}

open class LinkNode: ElementNode {

  override public init() {
    super.init()
    self.type = NodeType.link
  }

  public required init(url: String, key: NodeKey?) {
    super.init(key)
    self.url = url
    self.type = NodeType.link
  }

  override open func clone() -> Self {
    Self(url: url, key: key)
  }

  // MARK: - Serialization

  enum CodingKeys: String, CodingKey {
    case url
  }

  public required init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try super.init(from: decoder)

    self.url = try container.decode(String.self, forKey: .url)
    self.type = NodeType.link
  }

  override open func encode(to encoder: Encoder) throws {
    try super.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(self.url, forKey: .url)
  }

  // MARK: - Custom Properties

  private var url: String = ""

  public func getURL() -> String {
    let latest: LinkNode = getLatest()
    return latest.url
  }

  public func setURL(_ url: String) throws {
    try errorOnReadOnly()
    try getWritable().url = url
  }
}
```

The above listing shows a number of bits of boilerplate you have to do to build a node.

### Node type

You need to extend ``NodeType`` to add a new type for your node. You are responsible for making sure the raw value of your type doesn't conflict with any other node class that you're using!

Then, make sure you set `self.type` in all of your initialisers.

> tip: ``NodeType`` is used in serialization. If you match the NodeType string with an equivalent on Lexical JavaScript, and you also match up your node's properties, then you can get Lexical JSON output that can be loaded into both Lexical iOS and Lexical JavaScript. 

### At least one init method that takes all your properties plus NodeKey

You'll need this when you come to implement ``Node/clone()``. However, it's also useful to make this public, so the people using your node can use it!

### Clone

This is required. Lexical works by making copies of your node whenever it is changed (rather than mutating the original object). The ``Node/clone()`` method must be overridden to also copy every custom property you have on your node.

> tip: While Lexical does not mandate you doing a deep copy of your properties, be aware that if the contents of your node's properties change, Lexical won't know to re-render the node unless the node is marked as dirty. That's why we tell you to call ``Node/getWritable()`` in your property's setter (see below). 

### Decoders/Encoders

If you want to support serialization to JSON, you'll need to implement these. Lexical will handle things like child nodes, but any custom properties you have to handle as shown.

### Custom properties

For any custom properties, you need to make sure you do the following:

- term Properties are private: Due to how Lexical copies nodes, you want to make sure all public access to your node's data is done through getters/setters.
- term Support your property in init, clone, and decoder: See the sections above.
- term Getters/setters: Your getters for custom properties must call ``Node/getLatest()``, and your setters must call ``Node/getWritable()``. The reason for calling these is to handle marking the node as dirty when its properties are modified.

> Warning: If you don't call ``Node/getLatest()``/``Node/getWritable()`` in your getters/setters, or if you forget to correctly clone your custom properties, you may end up reading/modifying stale data by accident, which can lead to really subtle and hard to track down bugs.

## Register your node class

Before your node class can be used, it must be registered. The recommended way to do this is by creating a ``Plugin``. Here's an example:

```swift
open class LinkPlugin: Plugin {
  public init() {}

  weak var editor: Editor?

  public func setUp(editor: Editor) {
    self.editor = editor
    do {
      try editor.registerNode(nodeType: NodeType.link, constructor: { decoder in try LinkNode(from: decoder) })
    } catch {
      // ...
    }
  }

  public func tearDown() {
  }
}
```

The above is a really simple plugin that just handles registering the new node.

Then to use your plugin, when you're setting up the Lexical editor, instantiate your plugin and include it in the ``EditorConfig``.

```swift
let myPlugin = LinkPlugin()
let config = EditorConfig(theme: Theme(), plugins: [myPlugin])
```

Don't forget when making a plugin, that it is also a great place to register listeners and transforms to add Lexical behaviour to work with your new node type!

## Customisation points

There are methods you can override to customise the behaviour of your node.

- term ``ElementNode/isInline()``: Element nodes can automatically surround themselves with newlines (like a `<p>` or `<div>` tag on the web). If you want this behaviour, return `false` for ``ElementNode/isInline()``. If on the other hand you don't want the newlines, return `true`.
Examples: a heading node would return `false` to ``ElementNode/isInline()``, since headings go on their own line. A link node would return `true`, since a link sits inline within its paragraph.
- term ``Node/getAttributedStringAttributes(theme:)``: This is the main place to customise how your node renders. You can return attributes that TextKit uses to format your node. Lexical handles cascading styling, so the attributes you return here will also be applied to children of your node (unless they override them)! You have access to the ``Theme`` here, so you can pull data from the theme, allowing users of your node to customise its rendering.
- term ``Node/getTextPart()``, ``Node/getPreamble()``, ``Node/getPostamble()``: It is unlikely that you will need to override these, as the defaults (inherited from ``ElementNode`` or ``TextNode``) are fine for the vast majority of cases.
- term ``ElementNode/canInsertTextAfter()``, ``ElementNode/insertNewAfter(selection:)``, ``ElementNode/canBeEmpty()``, etc: There are many methods you can override to customise your node's behaviour. Take a look at ``ElementNode`` for more details.

Note that in ``Node/getAttributedStringAttributes(theme:)``, you can return your own custom attribute keys as well as using UIKit-provide or Lexical-provided ones. You'll want to do this if you're doing <doc:CustomDrawing>, or if you're extending the TextKit rendering in some other way.
