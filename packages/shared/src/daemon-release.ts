import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const artifact = z
  .object({
    file: z.string().regex(/^[a-zA-Z0-9_-]+\.gz$/),
    sha256: hash,
    size: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    contentSha256: hash,
    contentSize: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
  })
  .strict();
export const DaemonReleaseSchema = z
  .object({
    format: z.literal(1),
    product: z.enum(['lody-oss', 'lody-cloud']),
    distribution: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    version,
    channel: z.enum(['stable', 'next', 'nightly']),
    platform: z.enum([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]),
    serviceProtocol: z.literal(1),
    dataFormat: z.literal(1),
    source: z.string().regex(/^[a-f0-9]{40}$/),
    payloadSha256: hash,
    nodeVersion: z.literal('26.13.0'),
    capsule: artifact,
    node: artifact,
  })
  .strict();
export type DaemonRelease = z.infer<typeof DaemonReleaseSchema>;
