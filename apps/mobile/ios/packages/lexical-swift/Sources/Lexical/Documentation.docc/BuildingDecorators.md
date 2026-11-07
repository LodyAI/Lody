# Building Custom Decorator Nodes

Decorator nodes are arbitrary UIViews that can be embedded in a Lexical document. Lexical is responsible for leaving enough space for them when laying out text, and repositioning them as the text reflows.

Note that there are two ways to get custom non-text content into Lexical. Decorator nodes are if you want to position a rectangular `UIView`, and have space left for it. <doc:CustomDrawing>, on the other hand, allows you to draw arbitrary graphics around and above the text of your node, without affecting layout. These methods are both useful in different situations.

## Pieces of the puzzle

For a decorator node, you need to build a subclass of ``DecoratorNode``. You will also need some kind of `UIView`, whether it be your own `UIView` subclass, or a system or third party provided one.

You'll need to implement all the node boilerplate from <doc:BuildingNodes>, in addition to a few extra things described in this document.

## Source of truth

The source of truth for all state that needs to be persisted is your ``DecoratorNode`` subclass. By Lexical's API contract, it is at liberty to destroy and recreate your UIView if it wants. (In the current implementation, Lexical caches and reuses your view wherever possible, but future optimisations may not guarantee this.)

## Methods to override

The main methods to override are: 

- ``DecoratorNode/createView()``
- ``DecoratorNode/decorate(view:)``
- ``DecoratorNode/sizeForDecoratorView(textViewWidth:)``

Here is an example:

```swift
var url: URL? // NB getters/setters/encoding/init/clone methods for these properties are not shown here.
var size = CGSize.zero

override public func createView() -> UIImageView {
  let view = UIImageView(frame: CGRect(origin: CGPoint.zero, size: size))
  view.isUserInteractionEnabled = true
  view.backgroundColor = .lightGray
  return view
}

override open func decorate(view: UIView) {
  if let view = view as? UIImageView {
    loadImage(imageView: view)
  }
}

let maxImageHeight: CGFloat = 600.0
override open func sizeForDecoratorView(textViewWidth: CGFloat) -> CGSize {
  if size.width <= textViewWidth {
    return size
  }
  return AVMakeRect(aspectRatio: size, insideRect: CGRect(x: 0, y: 0, width: textViewWidth, height: maxImageHeight)).size
}

// MARK: - Private helpers

private func loadImage(imageView: UIImageView) {
  // update the image that's shown in the view, based on this node's url property
}
```

## createView

In this method, you need to create your `UIView` subclass. You can set up any properties here that will never change. Note that ``DecoratorNode/decorate(view:)`` will always be called immediately after this, so you don't need to repeat yourself.

## decorate

This is the method where you apply all the state from your node to your view. ``DecoratorNode/decorate(view:)`` will be called every time your ``DecoratorNode`` is marked dirty (e.g. its properties have changed). This is where you update your view.

## sizeForDecoratorView

Lexical handles positioning your view based on the size you return here.

You are given the size of the text view that contains your decorator. 

> note: Despite the parameter being called `textViewWidth`, it is in fact the layout width of the text that you get passed here. That is to say, `textContainerInset` and `lineFragmentPadding` are subtracted from the text view's actual width to get this value.
> 
> You can consider this value to be the maximum width of a line of text.


## Handling interaction

You may want your views to be interactive. The best way to do that is for your `UIView` subclass to store a reference to the Lexical editor.

It is safe to call ``getActiveEditor()`` inside the ``DecoratorNode/createView()`` and ``DecoratorNode/decorate(view:)`` methods. You can then pass this editor to your `UIView` subclass, which can store it in a weak instance variable.

> tip: Don't forget to make the ivar `weak`, otherwise you'll end up with a retain cycle!

Then, the recommended way to handle interaction is to use Commands. Lexical allows you to register custom commands, and listen for them elsewhere. Your view can therefore dispatch a custom command, and something else (e.g. your plugin class, or something inside your app's view controller, or whatever) can listen for that command. 

See ``Editor/registerCommand(type:listener:priority:)`` for more information on listening for custom commands.

You should extend ``CommandType`` to keep track of your command's identifier.

## Using decorator nodes within editable Lexical

> warning: As of March 2023, decorator nodes have only shipped in read-only surfaces. Some (small amount of) additional work is needed to make them usable within Editable surfaces. This section documents what is needed.

Decorator nodes should automatically flow within the text. As text is typed/edited, the decorator node should be repositioned automatically.

The main missing thing at the moment is a selection interaction for selecting the decorator node. Currently, if a text selection (aka ``RangeSelection``) is dragged across a decorator node, then e.g. pressing backspace __will__ delete the decorator. But, tapping once on a decorator node will not select it. This functionality needs building before working with decorators in editable mode will be a good experience.

## Nested editors

This refers to the concept of a decorator node containing a whole other nested Lexical instance.

> warning: As above, nested editors have only been shipped on a read-only surface. Additional work is probably needed to make them work with editable Lexical.

Conceptually, nested editors work like this:

* Your ``DecoratorNode`` should create any child editors it needs, e.g. in ``DecoratorNode/init()``. The child editor should have its ``Editor/parentEditor`` property correctly set.
* In ``DecoratorNode/createView()``, attach the editor you've created to some kind of Lexical frontend (e.g. ``LexicalView`` or ``LexicalReadOnlyView``).
* If you want the contents of your nested editor to affect the size of your decorator view (e.g. the height of the decorator view depends on the amount of text inside it), you should create an update listener on the child editor via ``Editor/registerUpdateListener(listener:)``. In the callback for this listener, you should mark your ``DecoratorNode`` as dirty by calling ``Node/getWritable()``. To work out the height needed for your child editor, if you're using ``LexicalReadOnlyTextKitContext`` you can call ``LexicalReadOnlyTextKitContext/setTextContainerSize(forWidth:)`` then ``LexicalReadOnlyTextKitContext/requiredSize()``.
* To support JSON serialization of your decorator node, don't forget to serialize the nested editors in your encode/decode methods.

> tip: You cannot reuse an ``EditorConfig``, since an EditorConfig contains instantiated plugins and plugins are not clonable. 
>
> In the future, we would like to improve the APIs here to make this easier. In the mean time, the best thing to do is let your ``DecoratorNode`` take a property of a closure that creates brand new ``EditorConfig``s for its child editors.

> tip: ``LexicalReadOnlyView`` has a great way of attaching and detatching its editor, via ``LexicalReadOnlyTextKitContext``. Eventually I would like to bring the same functionality to ``LexicalView``, to facilitate using child editors with editable Lexical.

## View Lifecycle

As mentioned above, decorator views have some level of caching so that they are not recreated too often. 

To detect when Lexical is placing one on the screen, you can use ``DecoratorNode/decoratorWillAppear(view:)`` and ``DecoratorNode/decoratorDidDisappear(view:)``.

## Decorators expanding outside the text view

The decorator view itself cannot be wider than the text layout, as defined by TextKit. This is enforced by how decorator view layout works: the layout is calculated as part of the TextKit layout process, and is placed inside the region that TextKit leaves empty for the decorator. 

However, if you turn off `clipsToBounds`, your decorator view can have _subviews_ that go outside that area.
