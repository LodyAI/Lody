import { defineQuery } from "@lody/plugin-sdk";
import { z } from "zod";

export const workflowStatusQuery = defineQuery("session", "workflow.status", {
  input: z.object({}),
  output: z.object({
    lastVerifiedTurnId: z.string().nullable(),
    verifierSessionId: z.string().nullable(),
  }),
});
