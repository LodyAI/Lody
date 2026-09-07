import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const shutdownMarkerPath = process.argv[2];
process.on('SIGTERM', () => {
  if (shutdownMarkerPath) writeFileSync(shutdownMarkerPath, 'terminated', 'utf8');
  process.exit(0);
});

const agent = acp
  .agent({ name: 'custom-acp-auth-validation' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    if (process.env.TERM !== undefined) {
      throw new Error('TERM must not reach a headless ACP protocol process');
    }
    return {
      protocolVersion: params.protocolVersion,
      authMethods: [
        { id: 'browser', name: 'Browser' },
        { id: 'manual', name: 'Manual code' },
      ],
    };
  })
  .onRequest(acp.methods.agent.authenticate, async ({ params, client, requestId }) => {
    if (params.methodId !== 'manual') {
      throw new Error(`unexpected authentication method: ${params.methodId}`);
    }
    process.stderr.write(
      'Open https://provider.example.test/oauth/authorize?client_id=validation\n'
    );
    const response = await client.request(acp.methods.client.elicitation.create, {
      mode: 'form',
      requestId,
      message: 'Enter the synthetic validation credentials',
      requestedSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            title: 'Manual code',
            _meta: {
              lody: { elicitation: { version: 1, secret: true } },
            },
          },
          account: {
            type: 'string',
            title: 'Account',
            enum: ['personal', 'work'],
          },
        },
        required: ['code', 'account'],
      },
    });
    if (
      response.action !== 'accept' ||
      response.content?.code !== 'validation-secret' ||
      response.content?.account !== 'work'
    ) {
      throw new Error('unexpected elicitation response');
    }
    return {};
  });

agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
