import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';

/**
 * The range a chip was committed with. Only `value` and `kind` identify it; the
 * owner's other fields (`insertText`, `onMentionSelect`, …) ride along by
 * reference so reading the document back returns the same objects the owner
 * gave, with fresh offsets.
 */
export type MentionNodeRange = {
  start: number;
  end: number;
  value: string;
  kind?: string;
};

export type SerializedMentionNode = Spread<
  { text: string; value: string; kind?: string },
  SerializedLexicalNode
>;

/** What the decorator renderer receives for one chip. */
export type MentionDecoration = {
  text: string;
  range: MentionNodeRange;
};

/**
 * One committed mention as an atomic inline island. Its text content is exactly
 * the text the range covered, so the composer string reads back unchanged; the
 * caret can sit on either side but never inside it.
 */
export class MentionDecoratorNode extends DecoratorNode<MentionDecoration> {
  __text: string;
  __range: MentionNodeRange;

  static getType(): string {
    return 'lody-mention';
  }

  static clone(node: MentionDecoratorNode): MentionDecoratorNode {
    return new MentionDecoratorNode(node.__text, node.__range, node.__key);
  }

  static importJSON(serialized: SerializedMentionNode): MentionDecoratorNode {
    return $createMentionNode(serialized.text, {
      start: 0,
      end: serialized.text.length,
      value: serialized.value,
      ...(serialized.kind === undefined ? {} : { kind: serialized.kind }),
    });
  }

  constructor(text: string, range: MentionNodeRange, key?: NodeKey) {
    super(key);
    this.__text = text;
    this.__range = range;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: MentionDecoratorNode.getType(),
      version: 1,
      text: this.__text,
      value: this.__range.value,
      ...(this.__range.kind === undefined ? {} : { kind: this.__range.kind }),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('span');
    element.contentEditable = 'false';
    element.dataset.mentionValue = this.__range.value;
    element.dataset.mentionKind = this.__range.kind ?? 'mention';
    return element;
  }

  updateDOM(prev: MentionDecoratorNode, element: HTMLElement): boolean {
    if (prev.__range.value !== this.__range.value) {
      element.dataset.mentionValue = this.__range.value;
    }
    if (prev.__range.kind !== this.__range.kind) {
      element.dataset.mentionKind = this.__range.kind ?? 'mention';
    }
    return false;
  }

  getTextContent(): string {
    return this.__text;
  }

  getRange(): MentionNodeRange {
    return this.getLatest().__range;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  /** Arrow keys step over a chip instead of selecting it as a node. */
  isKeyboardSelectable(): boolean {
    return false;
  }

  decorate(): MentionDecoration {
    return { text: this.__text, range: this.__range };
  }
}

export function $createMentionNode(text: string, range: MentionNodeRange): MentionDecoratorNode {
  return $applyNodeReplacement(new MentionDecoratorNode(text, range));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionDecoratorNode {
  return node instanceof MentionDecoratorNode;
}
