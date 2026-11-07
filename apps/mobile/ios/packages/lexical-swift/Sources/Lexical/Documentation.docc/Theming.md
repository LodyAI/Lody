# Theming

How to customise the look and feel of text in Lexical iOS.

## Overview

Theming in Lexical iOS is accomplished by passing `NSAttributedString` key/attribute pairs.

> Tip: Theming works quite differently in Lexical iOS compared with Lexical JavaScript. Because UIKit does not use CSS, we don't have a built in hierarchical styling system to build on top of.

## The Theme object

When creating an ``Editor`` (or a Lexical frontend that internally creates an Editor), you create and pass in a ``Theme``.

```swift
let theme = Theme()
let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: theme, plugins: []))
```

The code above shows passing in an empty theme, which means Lexical uses its default styling. But there's a lot of customisation you can do if you desire.

Here is how you would configure the theme for ``ParagraphNode``s:

```swift
let theme: Theme()
theme.paragraph = [
  .fontFamily: "Helvetica",
  .fontSize: 12.0,
  .lineHeight: 16.0,
  .foregroundColor: UIColor.black,
]
```

There's a lot going on in this small amount of code, so let's unpack it.

### Keying by node type

In the code snippet above, we set `theme.paragraph`. But there's no property on `Theme` called `paragraph` -- what's that about?

The Theme object is at heart a dictionary, mapping between ``NodeType`` and `[NSAttributedString.Key : Any]`. So in this case, `paragraph` is the ``NodeType`` for ``ParagraphNode``.

If you were to look in the code for ``ParagraphNode``, we see this method:

```swift
override public func getAttributedStringAttributes(theme: Theme) -> [NSAttributedString.Key: Any] {
  if let paragraph = theme.paragraph {
    return paragraph
  }
  return [:]
}
```

That is how `ParagraphNode` pulls the relevant content from the `Theme`. It's just a convention that nodes should use their node type as the key within the `Theme` -- if you built a new node and did not override ``Node/getAttributedStringAttributes(theme:)``, your node would not make use of the `Theme` at all. But it's a good idea for any reusable node to pull stuff from the `Theme`.

### Applying attributes hierarchically

When Lexical is applying attributes, it makes use of the node tree. Let's consider the following tree:

```
- Root
  - Paragraph
    - Text "Hello "
    - Link "world" (https://example.com)
```

When applying attributes to the text node in that example, Lexical will apply attributes for ``RootNode``, ``ParagraphNode`` and ``TextNode`` in order. If two of these nodes attempt to apply the same attribute, latest wins. So you could set the theme for `RootNode` to have a certain font size, and then increase that font size for a heading node. All non-headings would use the size set on `RootNode`, but the specifit size set on heading would override it. 

(To be clear, this relates to node tree hierarchy within your Lexical document. This is unrelated to class hierarchy of the node classes.)

### Custom attribute keys for fontFamily, etc

Lexical provides a set of additional attribute keys:

```swift
fontFamily // String
fontSize // String
bold // Bool
italic // Bool
textTransform // TextTransform
paddingHead // CGFloat
paddingTail // CGFloat
lineHeight // CGFloat
lineSpacing // CGFloat
paragraphSpacingBefore // CGFloat
```

These allow you to set properties on `UIFont` or `NSParagraphStyle`, without having to set an entire `UIFont` or `NSParagraphStyle` object. For example, a heading may wish to make the font size bigger, but inherit the font family from its container node.

You don't have to use these new attributes to specify fonts. You can use `.font` and specify a `UIFont` like normal. But if you do use these new attributes, Lexical attempts to unpack a font set by a parent node, and re-create it with the modifications given by these new attributes.

> Warning: If you have set a font on a parent node using `systemFont(ofSize:)` or similar, using the Lexical custom attributes on child nodes may not work. This is because UIKit's methods for modifying font descriptors (e.g. `.withFamily()`) do not work correctly for a dynamic font such as the system font. 

#### TextTransform

The `textTransform` custom attribute key allows you to force text to be upper case or lower case. This attribute is applied at display time, so the text stored in your data model remains the original case in which it was entered.

## Some node classes have theme subtypes

In the example above, we set the style on `paragraph`, so it applies to all paragraph nodes.

But what about something like ``HeadingNode``, which can have various levels of heading? We may want to apply separate styles for each level of heading. To do this, we can use a theme subtype. Instead of setting the attributes just using the node type as a property on theme, we use the method ``Theme/setValue(_:forSubtype:value:)``.

For example:

```swift
theme.setValue(.heading, forSubtype: "h1", value: [.bold: True])
```

It is up to each node class how/if they support subtypes. The heading node supports five subtypes, `"h1"` to `"h5"`.

## Block level attributes

There is some support for block level attributes, however this API could stand to be expanded in the future!

For some context, TextKit 1 (which is what Lexical uses)
lets attributes apply to a character range, or to a paragraph (by means of a subclass of `NSParagraphStyle`). A paragraph is defined
by TextKit as a piece of text surrounded by line break characters.

Consider, however, something like a code block. This is very likely to have multiple line breaks internally, but in order to style it, we might want to have
a larger margin at the top of the code block and the bottom of the code block. Telling TextKit how to render this is difficult -- we have to set a paragraph style
on the first paragraph of the code block with a bigger top margin, and a paragraph style on the last paragraph of the code block with a bigger bottom margin.

Since Lexical wants to make a developer's life easier, we do this calculation internally. Our ``BlockLevelAttributes`` currently support margin and padding for top and
bottom. This can be used in combination with Lexical's custom drawing support, to get the look you want. Apply block level attributes with ``Theme/setBlockLevelAttributes(_:value:)``.

## Some Lexical features use custom attributes

Lexical's philosophy is that any features that customise TextKit's layout or rendering should be triggered by means of custom attributes.

### Custom drawing

Custom Drawing is explained in more detail in its own article, <doc:CustomDrawing>. However it is worth mentioning here to explain how it uses custom attributes.

If you're making a node class that wants to do custom drawing, you'll need to register for it using the method ``Editor/registerCustomDrawing(customAttribute:layer:granularity:handler:)``. This method takes an attribute key as its first parameter, and it is this attribute key that triggers Lexical to apply your custom drawing handler.

It is up to you as the author of the node class how you wish to provide this custom attribute. You could hard code your node to provide the attribute in ``Node/getAttributedStringAttributes(theme:)``, or you could request your users pass it in through the ``Theme``. If you do the latter, then your custom drawing will only be triggered when the user passes in that attribute, of course.

### Decorator nodes

Some nodes, especially decorator nodes, need a way to pass arbitrary styling information to the node, but that styling information does not need to be given to TextKit.]

For example, our Table node has defined a `borderColor` custom attribute key. Then, in the ``DecoratorNode/createView()`` method, it fetches the theme from the active editor and retrieves this border colour value using ``Theme/getValue(_:withSubtype:)``. A custom attribute is ideal for allowing this kind of customisation on a decorator view.

### How to define custom attributes

If you need to define a custom attribute for any reason, make an extension on `NSAttributedString.Key`, like so:

```swift
extension NSAttributedString.Key {
  public static let borderColor: NSAttributedString.Key = .init(rawValue: "borderColor")
}
```
