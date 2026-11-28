import {
  defineAttachmentSource,
  defineMutation,
  defineQuery,
} from "@lody/plugin-sdk";
import { z } from "zod";

export const issueStateSchema = z.enum([
  "blocked",
  "ready",
  "in_progress",
  "done",
]);

export const issueRowSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  state: issueStateSchema,
  pinned: z.boolean(),
  url: z.string(),
  pullRequestUrl: z.string().optional(),
});

export type IssueRow = z.infer<typeof issueRowSchema>;

export const issueAttachmentSource = defineAttachmentSource("issues", {
  title: "Attach Issue",
  placeholder: "Search issues by key or title…",
  metadataSchema: z.object({
    identifier: z.string(),
    state: issueStateSchema,
  }),
});

export const listIssuesQuery = defineQuery("project", "issues.list", {
  input: z.object({ query: z.string().default("") }),
  output: z.array(issueRowSchema),
});

export const togglePinMutation = defineMutation("project", "issues.togglePin", {
  input: z.object({ issueId: z.string(), pinned: z.boolean() }),
  output: z.object({ ok: z.literal(true) }),
});

export const sessionScratchpadQuery = defineQuery(
  "session",
  "session.scratchpad",
  {
    input: z.object({}),
    output: z.object({
      linkedIdentifier: z.string().nullable(),
    }),
  },
);
