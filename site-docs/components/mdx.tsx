import * as AccordionComponents from './docs-ui/accordion';
import { Callout, CalloutContainer, CalloutTitle, CalloutDescription } from './docs-ui/callout';
import { Card, Cards } from './docs-ui/card';
import * as StepsComponents from './docs-ui/steps';
import * as TabsComponents from './docs-ui/tabs';
import Link from 'fumadocs-core/link';
import { Heading } from './docs-ui/heading';
import {
  CodeBlock,
  Pre,
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from './docs-ui/codeblock';
import { Table } from './docs-ui/table';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { MentionPreview, SlashCommandsPreview } from './docs-replica/command-reference-previews';
import {
  BrowserPreview,
  ConversationDiffPreview,
  DiffViewerPreview,
  ImageInputPreview,
  ImageOutputPreview,
  SessionFilesPreview,
} from './docs-replica/conversation-reference-previews';
import { GithubRepoPickerPreview } from './docs-replica/github-repo-picker-preview';
import {
  AgentConfigPreview,
  AskQuestionPreview,
  CliRuntimePreview,
  FastModePreview,
  GoalPreview,
} from './docs-replica/runtime-reference-previews';
import { SessionListPreview } from './docs-replica/session-list-preview';
import {
  NotificationPreview,
  QuotaPreview,
  UsagePreview,
} from './docs-replica/settings-reference-previews';

type StaticImageLike = {
  src: string;
  width?: number;
  height?: number;
};

function isStaticImageLike(value: unknown): value is StaticImageLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'src' in value &&
    typeof (value as { src?: unknown }).src === 'string'
  );
}

function normalizeImageProps(
  src: ComponentProps<'img'>['src'] | StaticImageLike | undefined,
  props: Omit<ComponentProps<'img'>, 'src'>
) {
  if (!isStaticImageLike(src)) {
    return { src, props };
  }

  return {
    src: src.src,
    props: {
      ...props,
      width: props.width ?? src.width,
      height: props.height ?? src.height,
    },
  };
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    a: Link,
    h2: (props) => <Heading as="h2" {...props} />,
    h3: (props) => <Heading as="h3" {...props} />,
    h4: (props) => <Heading as="h4" {...props} />,
    h5: (props) => <Heading as="h5" {...props} />,
    h6: (props) => <Heading as="h6" {...props} />,
    table: Table,
    pre: (props) => (
      <CodeBlock {...props}>
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    CodeBlockTab,
    CodeBlockTabs,
    CodeBlockTabsList,
    CodeBlockTabsTrigger,
    ...AccordionComponents,
    Callout,
    CalloutContainer,
    CalloutTitle,
    CalloutDescription,
    Card,
    Cards,
    ...StepsComponents,
    ...TabsComponents,
    // Site-owned product previews rendered from mock data; see
    // `components/docs-replica/`. Long-form docs pass a `locale` so the mock
    // copy follows the page language.
    AgentConfigPreview,
    AskQuestionPreview,
    BrowserPreview,
    CliRuntimePreview,
    ConversationDiffPreview,
    DiffViewerPreview,
    FastModePreview,
    GithubRepoPickerPreview,
    GoalPreview,
    ImageInputPreview,
    ImageOutputPreview,
    MentionPreview,
    NotificationPreview,
    QuotaPreview,
    SessionFilesPreview,
    SessionListPreview,
    SlashCommandsPreview,
    UsagePreview,
    // Page shells already render the document title as H1.
    h1: () => null,
    img: ({ ref: _ref, src, ...props }) => {
      const normalized = normalizeImageProps(src, props);
      // Prefer natural aspect ratio. Explicit width/height attrs are fine for
      // layout, but never force a mismatched CSS height that squashes the image.
      const { style, ...rest } = normalized.props;
      const safeStyle =
        style && typeof style === 'object' ? { ...style, height: style.height ?? 'auto' } : style;

      return (
        <img loading="lazy" decoding="async" src={normalized.src} {...rest} style={safeStyle} />
      );
    },
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
