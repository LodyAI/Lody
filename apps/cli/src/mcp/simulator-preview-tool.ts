import type { LodyToolServer } from './tool-help';
import { z } from 'zod';
import {
  AndroidAvdNameSchema,
  AndroidEmulatorCommandSchema,
  AndroidEmulatorResponseSchema,
  IosSimulatorCommandSchema,
  IosSimulatorResponseSchema,
  IosSimulatorUdidSchema,
  type AndroidEmulatorCommand,
  type IosSimulatorCommand,
} from '@lody/shared';

export const SIMULATOR_PREVIEW_TOOL_NAME = 'lody_simulator_preview';

export type SimulatorPreviewPlatform = 'ios' | 'android';

/**
 * iOS Simulators need Xcode on macOS; Android Emulators run on every desktop OS. The
 * server is built per connection on the Session's own machine, so the offered
 * platforms are fixed for that connection and never change mid-session.
 */
export const simulatorPreviewPlatforms = (
  hostPlatform: NodeJS.Platform = process.platform
): [SimulatorPreviewPlatform, ...SimulatorPreviewPlatform[]] =>
  hostPlatform === 'darwin' ? ['ios', 'android'] : ['android'];

type Requests = {
  ios: (command: IosSimulatorCommand) => Promise<unknown>;
  android: (command: AndroidEmulatorCommand) => Promise<unknown>;
};

const PANEL = { ios: 'iOS Simulator', android: 'Android Emulator' } as const;

const failure = (platform: SimulatorPreviewPlatform) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text:
        platform === 'ios'
          ? 'Unable to control iOS Simulator. Check the current session’s Mac, active turn, Xcode and Lody version, then retry.'
          : 'Unable to control Android Emulator. Check the current session’s machine, active turn, Android SDK and Lody version, then retry.',
    },
  ],
});

export function registerSimulatorPreviewTool(
  server: LodyToolServer,
  requests: Requests,
  platforms: [SimulatorPreviewPlatform, ...SimulatorPreviewPlatform[]] = simulatorPreviewPlatforms()
) {
  const inputSchema = z
    .object({
      platform: z.enum(platforms),
      action: z.enum(['list', 'start', 'status', 'stop']),
      udid: IosSimulatorUdidSchema.optional().describe('iOS start: a UDID returned by list.'),
      id: AndroidAvdNameSchema.optional().describe('Android start: an AVD name returned by list.'),
      operationId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Required for stop; optional for status. Returned by start or status.'),
    })
    .strict()
    .superRefine(({ platform, ...command }, ctx) => {
      // Each platform keeps its own strict command contract (udid only for iOS, id only for Android).
      const parsed = (
        platform === 'ios' ? IosSimulatorCommandSchema : AndroidEmulatorCommandSchema
      ).safeParse(command);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    });
  const devices = platforms.map((platform) => PANEL[platform]).join(' or ');
  server.registerTool(
    SIMULATOR_PREVIEW_TOOL_NAME,
    {
      summary: `Preview ${devices} devices in Lody: list/start/status/stop, without building or installing apps.`,
      title: 'Simulator Preview',
      description: [
        `Preview a native ${platforms.includes('ios') ? 'iOS or Android' : 'Android'} app in an ${devices} inside Lody’s dedicated simulator panel. Use this tool when developing, debugging, or demonstrating a native app and the user needs to see or interact with the simulator. Supports listing simulators, starting a preview, checking status, and stopping a preview on the current session’s machine. Listing does not boot a device. Starting boots the selected simulator if needed; preparation is asynchronous and the stream connects when the user opens the matching simulator panel. Each simulator can be controlled by only one session; occupied devices cannot be taken over. Stopping the preview leaves the simulator running. This tool does not build or install apps. For web pages or web apps, use lody_report_preview_candidate.`,
        platforms.includes('ios')
          ? 'platform=ios selects a device by udid and needs this macOS machine’s Xcode; platform=android selects an AVD by id.'
          : 'platform=android selects an AVD by id. iOS Simulators are unavailable because this machine is not macOS.',
      ].join('\n\n'),
      inputSchema,
    },
    async ({ platform, ...args }) => {
      try {
        if (platform === 'ios') {
          const result = IosSimulatorResponseSchema.parse(
            await requests.ios(IosSimulatorCommandSchema.parse(args))
          );
          // Viewer capabilities and free-form diagnostics must never enter tool history.
          const preview = result.preview;
          return reply(platform, result.success, {
            success: result.success,
            devices: result.devices,
            preview: preview && {
              operationId: preview.operationId,
              udid: preview.udid,
              phase: preview.phase,
            },
            error: result.error,
          });
        }
        const result = AndroidEmulatorResponseSchema.parse(
          await requests.android(AndroidEmulatorCommandSchema.parse(args))
        );
        const preview = result.preview;
        return reply(platform, result.success, {
          success: result.success,
          devices: result.devices,
          preview: preview && {
            operationId: preview.operationId,
            id: preview.id,
            phase: preview.phase,
          },
          error: result.error,
        });
      } catch {
        return failure(platform);
      }
    }
  );
}

function reply(platform: SimulatorPreviewPlatform, success: boolean, body: object) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...body,
          note: `Open the ${PANEL[platform]} panel in this session to view the device, or use Refresh in its device picker if it is already open. Start is asynchronous; use status to check progress. Stop requires the exact operationId and never shuts down the device.`,
        }),
      },
    ],
    ...(success ? {} : { isError: true }),
  };
}
