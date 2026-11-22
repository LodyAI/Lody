import { defineTool } from "@lody/plugin-sdk";
import { z } from "zod";

export const testCaseSchema = z.object({
  id: z.string(),
  suite: z.string(),
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().nonnegative(),
  failureMessage: z.string().optional(),
});

export type TestCaseResult = z.infer<typeof testCaseSchema>;

export const runSuiteTool = defineTool("run-suite", {
  title: "Run Test Suite",
  description: "Execute project tests and return structured pass/fail cases.",
  input: z.object({
    filter: z.string().optional(),
  }),
  output: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cases: z.array(testCaseSchema),
  }),
});
