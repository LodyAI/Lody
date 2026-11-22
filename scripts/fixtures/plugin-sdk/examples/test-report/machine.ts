import { defineMachinePlugin } from "@lody/plugin-sdk/machine";
import { runSuiteTool } from "./shared";

export default defineMachinePlugin((machine) => {
  machine.tool(runSuiteTool, async (_ctx, input) => {
    const cases = [
      {
        id: "auth.login",
        suite: "auth",
        name: "rejects expired session token",
        status: "failed" as const,
        durationMs: 42,
        failureMessage: "Expected 401, received 200",
      },
      {
        id: "auth.refresh",
        suite: "auth",
        name: "rotates refresh token",
        status: "passed" as const,
        durationMs: 18,
      },
    ].filter((item) => !input.filter || item.name.includes(input.filter));

    return {
      passed: cases.filter((c) => c.status === "passed").length,
      failed: cases.filter((c) => c.status === "failed").length,
      cases,
    };
  });
});
