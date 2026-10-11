import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  IosSimulatorCommandSchema,
  IosSimulatorResponseSchema,
  IosSimulatorUdidSchema,
  type IosSimulatorCommand,
} from '@lody/shared';

export const IOS_SIMULATOR_PREVIEW_TOOL_NAME = 'lody_ios_simulator_preview';

const inputSchema = z
  .object({
    action: z.enum(['list', 'start', 'status', 'stop']),
    udid: IosSimulatorUdidSchema.optional().describe(
      'Required for start. Choose a UDID returned by list.'
    ),
    operationId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Required for stop; optional for status. Use the operationId returned by start or status.'
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = IosSimulatorCommandSchema.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

export function registerIosSimulatorPreviewTool(
  server: McpServer,
  request: (command: IosSimulatorCommand) => Promise<unknown>
) {
  server.registerTool(
    IOS_SIMULATOR_PREVIEW_TOOL_NAME,
    {
      title: 'iOS Simulator Preview',
      description:
        'Preview a native iOS app in an iOS Simulator inside Lody’s dedicated simulator panel. Use this tool when developing, debugging, or demonstrating an iOS app and the user needs to see or interact with the simulator. Supports listing simulators, starting a preview, checking status, and stopping a preview on the current session’s Mac. Listing does not boot a device. Starting boots the selected simulator if needed; preparation is asynchronous and the stream connects when the user opens the iOS Simulator panel. Each simulator can be controlled by only one session; occupied devices cannot be taken over. Stopping the preview leaves the simulator running. This tool does not build or install apps. For web pages or web apps, use lody_report_preview_candidate.',
      inputSchema,
    },
    async (args) => {
      try {
        const result = IosSimulatorResponseSchema.parse(
          await request(IosSimulatorCommandSchema.parse(args))
        );
        // Viewer capabilities and free-form diagnostics must never enter tool history.
        const preview = result.preview;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: result.success,
                devices: result.devices,
                preview: preview && {
                  operationId: preview.operationId,
                  udid: preview.udid,
                  phase: preview.phase,
                },
                error: result.error,
                note: 'Open the iOS Simulator panel in this session to view the device, or use Refresh in its device picker if it is already open. Start is asynchronous; use status to check progress. Stop requires the exact operationId and never shuts down the device.',
              }),
            },
          ],
          ...(result.success ? {} : { isError: true }),
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Unable to control iOS Simulator. Check the current session’s Mac, active turn, Xcode and Lody version, then retry.',
            },
          ],
        };
      }
    }
  );
}
