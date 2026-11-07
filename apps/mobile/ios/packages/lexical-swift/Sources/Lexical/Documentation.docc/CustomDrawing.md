# Custom Drawing

Augmenting TextKit's rendering by drawing things yourself.

## What is custom drawing?

When it comes down to it, TextKit's job is to turn attributed string information into pixels. It is common for developers to want to have a bit more control of those pixels. For example, maybe you want every @-mention of a username to be surrounded by a rounded rectangle with a slight shadow. This isn't something TextKit can do natively, but with custom drawing you can do it.

If you were using TextKit directly, custom drawing involves subclassing `NSLayoutManager` and overriding `drawBackground()` or `drawGlyphs()`. The hard part of doing this is working out when and where you need to draw. Luckily, Lexical adds an API over the top of TextKit that makes things much easier.

## Registering a custom drawing handler

To register for custom drawing, call ``Editor/registerCustomDrawing(customAttribute:layer:granularity:handler:)``.

```swift
func registerCustomDrawing(
  customAttribute: NSAttributedString.Key,
  layer: CustomDrawingLayer,
  granularity: CustomDrawingGranularity,
  handler: @escaping CustomDrawingHandler
) throws
```

The best place to do this is in your ``Plugin``'s ``Plugin/setUp(editor:)`` method. But if you're not building a plugin, you can call this method anywhere before the text is rendered.

In Lexical, custom drawing is always triggered by a certain attribute. See the article on <doc:Theming> for more information about this.

### Layer

The ``CustomDrawingLayer`` type lets you specify ``CustomDrawingLayer/background`` or ``CustomDrawingLayer/text``. Essentially, this is specifying whether you want to draw in front of or behind the text characters.

### Granularity

This feature is unique to Lexical.

For custom drawing, Lexical calculates rectangles to tell you where to draw. Granularity lets you specify ``CustomDrawingGranularity/characterRuns``, ``CustomDrawingGranularity/singleParagraph``, or ``CustomDrawingGranularity/contiguousParagraphs``. 

* ``CustomDrawingGranularity/characterRuns`` would be appropriate if you were doing e.g. a custom strikethrough or highlight effect. You get a callback for every run of characters with your attribute, i.e. each line or part of a line.
* ``CustomDrawingGranularity/singleParagraph`` gives you a callback per paragraph.
* ``CustomDrawingGranularity/contiguousParagraphs`` merges paragraphs with a matching value for your attribute that are contiguous, giving you a single callback with a large rectangle encompassing all the paragraphs.

### The handler

The ``CustomDrawingHandler`` may seem quite complicated, because there is a lot of information passed in:

```swift
typealias CustomDrawingHandler = (
  _ attributeKey: NSAttributedString.Key,
  _ attributeValue: Any,
  _ layoutManager: LayoutManager,
  _ attributeRunCharacterRange: NSRange,
  _ granularityExpandedCharacterRange: NSRange,
  _ glyphRange: NSRange,
  _ rect: CGRect,
  _ firstLineFragment: CGRect
) -> Void
```

Let's take a look at each parameter in turn

- term `attributeKey`: The custom attribute key that you used to register this drawing handler.
- term `attributeValue`: The value for the attribute in question.
- term `layoutManager`: The layout manager rendering the text.
- term `attributeRunCharacterRange`: The overall character range for this attribute run, without respect for the granularity value. That is, the longest contiguous character range with a matching value for the custom attribute. Note that the character ranges are always given as per `NSString` ranges, i.e. UTF16 ranges. If you're using Swift strings, you'll have to either cast the strings to NSString, or correctly convert the ranges to Swift ranges.
- term `granularityExpandedCharacterRange`: The character range that corresponds to the granularity rectangle that you are given. If your granularity is ``CustomDrawingGranularity/characterRuns``, you'll get one callback per line or part of a line, and the `granularityExpandedCharacterRange` parameter will correspond to those characters that are in the line or part of a line for the current callback. Note that for the ``CustomDrawingGranularity/singleParagraph`` and ``CustomDrawingGranularity/contiguousParagraphs`` granularities, if your attribute range doesn't perfectly line up with paragraphs, the character range is expanded outwards to the nearest paragraph boundary. So in those cases, `granularityExpandedCharacterRange` may encompass more characters than `attributeRunCharacterRange`.
- term `glyphRange`: The equivalent of `attributeRunCharacterRange` but in terms of glyphs, not characters.
- term `rect`: The rectangle that matches the granularity you specified.
- term `firstLineFragment`: A rectangle that represents the first line fragment that crosses the character range you're working with. This is a convenience because it's a common thing to need. For example, when drawing a bulleted list, the granularity will need to be ``CustomDrawingGranularity/singleParagraph`` (since each paragraph counts as a list item). However, the bullet needs to be drawn vertically centred on the first line, not vertically centred on the entire paragraph.

## Putting it all together

This is the code that is used to draw a custom rectangular background for a code block.

```swift
try editor.registerCustomDrawing(customAttribute: .codeBlockCustomDrawing, layer: .background, granularity: .contiguousParagraphs) {
  attributeKey, attributeValue, layoutManager, characterRange, expandedCharRange, glyphRange, rect, firstLineFragment in

  guard let context = UIGraphicsGetCurrentContext(), let attributeValue = attributeValue as? CodeBlockCustomDrawingAttributes else { return }

  context.setFillColor(attributeValue.background.cgColor)
  context.fill(rect)
  context.setStrokeColor(attributeValue.border.cgColor)
  context.stroke(rect, width: attributeValue.borderWidth)
}
```

A custom class, ``CodeBlockCustomDrawingAttributes``, is created to hold the required data. (In this case, the border colour, background colour, and border width.)

> Warning: The class for your attribute value must implement `NSObject` equality. This is because TextKit internally does comparisons to check for contiguous attribute ranges, etc. Not doing this will result in obscure bugs.

A custom attribute name, `codeBlockCustomDrawing`, was also created.

Because the granularity is ``CustomDrawingGranularity/contiguousParagraphs``, Lexical makes one single callback for all contiguous paragraphs with the attribute. This is desired for a code block, which may have internal line breaks.

Inside the handler, in order to do drawing we call `UIGraphicsGetCurrentContext()` to obtain a graphics context. Then, standard Core Graphics functions can be used. In this case, we set the fill and stroke colour, and fill and stroke the `rect`.
