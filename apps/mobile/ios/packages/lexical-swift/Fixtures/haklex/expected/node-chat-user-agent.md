A captured exchange between user and assistant:

> **Innei:** How does Lexical's DecoratorNode differ from ElementNode?

The two serve different purposes:

- **ElementNode** contains other nodes — paragraphs, headings, lists.
- **DecoratorNode** renders a React component as a leaf — polls, embeds, charts.

Use a decorator when the content isn't editable as text.

> **Innei:** Got it. So for the chat node we should subclass DecoratorNode.