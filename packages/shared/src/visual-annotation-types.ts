export const SET_ANNOTATION_MODE_MESSAGE_TYPE = 'SET_ANNOTATION_MODE' as const;
export const VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE = 'VISUAL_ANNOTATION_TARGET' as const;
export const RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE =
  'RESOLVE_VISUAL_ANNOTATION_ANCHORS' as const;
export const VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE =
  'VISUAL_ANNOTATION_ANCHORS_RESOLVED' as const;
export const MANAGED_BROWSER_COMMAND_MESSAGE_TYPE = 'LODY_MANAGED_BROWSER_COMMAND' as const;
export const MANAGED_BROWSER_STATE_MESSAGE_TYPE = 'LODY_MANAGED_BROWSER_STATE' as const;
export const MANAGED_BROWSER_READY_MESSAGE_TYPE = 'LODY_MANAGED_BROWSER_READY' as const;
export const MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE =
  'LODY_MANAGED_BROWSER_NAVIGATION_REQUEST' as const;

export type ManagedBrowserCommand = 'back' | 'forward' | 'reload' | 'stop';

export type ManagedBrowserCommandMessage = {
  type: typeof MANAGED_BROWSER_COMMAND_MESSAGE_TYPE;
  command: ManagedBrowserCommand;
};

export type ManagedBrowserStateMessage = {
  type: typeof MANAGED_BROWSER_STATE_MESSAGE_TYPE;
  payload: {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  };
};

export type ManagedBrowserNavigationRequestMessage = {
  type: typeof MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE;
  payload: {
    url: string;
  };
};

export type SetAnnotationModeMessage = {
  type: typeof SET_ANNOTATION_MODE_MESSAGE_TYPE;
  enabled: boolean;
};

export type VisualAnnotationTargetMessage = {
  type: typeof VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE;
  payload: VisualAnnotationInspectPayload;
};

export type ResolveVisualAnnotationAnchorsMessage = {
  type: typeof RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE;
  payload: {
    anchors: Array<{
      commentId: string;
      anchor: MinimalVisualAnnotationAnchor;
    }>;
  };
};

export type VisualAnnotationResolvedAnchor = {
  commentId: string;
  resolved: boolean;
  rect?: VisualAnnotationRect;
  rectRatio?: VisualAnnotationRectRatio;
  selector?: string;
  xpath?: string;
};

export type VisualAnnotationAnchorsResolvedMessage = {
  type: typeof VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE;
  payload: {
    viewport: VisualAnnotationViewport;
    results: VisualAnnotationResolvedAnchor[];
  };
};

export type VisualAnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type VisualAnnotationRectRatio = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VisualAnnotationViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

export type VisualAnnotationComputedStyleField =
  | 'display'
  | 'position'
  | 'width'
  | 'height'
  | 'margin'
  | 'padding'
  | 'gap'
  | 'color'
  | 'backgroundColor'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'border'
  | 'borderRadius'
  | 'opacity'
  | 'visibility'
  | 'overflow'
  | 'zIndex';

export type VisualAnnotationAncestorSummary = {
  tag: string;
  id?: string;
  className?: string;
  role?: string;
  text?: string;
  selector: string;
  attributes: Record<string, string>;
};

export type VisualAnnotationInspectPayload = {
  page: {
    url: string;
    pathname: string;
    title: string;
    viewport: VisualAnnotationViewport;
  };
  click: {
    clientX: number;
    clientY: number;
    pageX: number;
    pageY: number;
  };
  target: {
    tag: string;
    id?: string;
    className?: string;
    role?: string;
    attributes: Record<string, string>;
    text?: string;
    rect: VisualAnnotationRect;
    selector: string;
    xpath: string;
    outerHTMLPreview: string;
  };
  ancestors: VisualAnnotationAncestorSummary[];
  nearbyText: {
    self?: string;
    parentSummary?: string;
    siblingTexts?: string[];
  };
  style: Record<VisualAnnotationComputedStyleField, string>;
};

export type MinimalVisualAnnotationAnchor = {
  version: 1;
  page: {
    url: string;
    pathname: string;
    viewport: VisualAnnotationViewport;
  };
  click: VisualAnnotationInspectPayload['click'] & {
    viewportXRatio: number;
    viewportYRatio: number;
  };
  target: {
    tag: string;
    id?: string;
    role?: string;
    attributes: Record<string, string>;
    text?: string;
    rect: Pick<VisualAnnotationRect, 'x' | 'y' | 'width' | 'height'>;
    rectRatio: VisualAnnotationRectRatio;
    selector: string;
    xpath?: string;
  };
  context: {
    ancestors: Array<{
      tag: string;
      id?: string;
      role?: string;
      selector?: string;
      text?: string;
    }>;
    nearbyText?: string[];
  };
};

export const VISUAL_ANNOTATION_STYLE_FIELDS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'gap',
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'border',
  'borderRadius',
  'opacity',
  'visibility',
  'overflow',
  'zIndex',
] as const satisfies readonly VisualAnnotationComputedStyleField[];
