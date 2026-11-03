import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  AndroidEmulatorCommandSchema,
  AndroidEmulatorResponseSchema,
  AndroidAvdNameSchema,
  type AndroidEmulatorCommand,
} from '@lody/shared';

export const ANDROID_EMULATOR_PREVIEW_TOOL_NAME = 'lody_android_emulator_preview';

const inputSchema = z
  .object({
    action: z.enum(['list', 'start', 'status', 'stop']),
    id: AndroidAvdNameSchema.optional().describe(
      'Required for start. Choose a AVD name returned by list.'
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
    const parsed = AndroidEmulatorCommandSchema.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

export function registerAndroidEmulatorPreviewTool(
  server: McpServer,
  request: (command: AndroidEmulatorCommand) => Promise<unknown>
) {
  server.registerTool(
    ANDROID_EMULATOR_PREVIEW_TOOL_NAME,
    {
      title: 'Android Emulator Preview',
      description:
        'Preview a native Android app in an Android Emulator inside Lody’s dedicated simulator panel. Use this tool when developing, debugging, or demonstrating an Android app and the user needs to see or interact with the simulator. Supports listing simulators, starting a preview, checking status, and stopping a preview on the current session’s machine. Listing does not boot a device. Starting boots the selected simulator if needed; preparation is asynchronous and the stream connects when the user opens the Android Emulator panel. Each simulator can be controlled by only one session; occupied devices cannot be taken over. Stopping the preview leaves the simulator running. This tool does not build or install apps. For web pages or web apps, use lody_report_preview_candidate.',
      inputSchema,
    },
    async (args) => {
      try {
        const result = AndroidEmulatorResponseSchema.parse(
          await request(AndroidEmulatorCommandSchema.parse(args))
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
                  id: preview.id,
                  phase: preview.phase,
                },
                error: result.error,
                note: 'Open the Android Emulator panel in this session to view the device, or use Refresh in its device picker if it is already open. Start is asynchronous; use status to check progress. Stop requires the exact operationId and never shuts down the device.',
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
              text: 'Unable to control Android Emulator. Check the current session’s machine, active turn, Android SDK and Lody version, then retry.',
            },
          ],
        };
      }
    }
  );
}
