import { CONTROL_STREAM, DEVICE_HEADER } from '../../e2ee-demo/src/protocol';
import { deviceHex } from '../../e2ee-demo/src/device';
import type { HonestClient } from './actors';

export async function appendControlRecord(input: {
  baseUrl: string;
  client: HonestClient;
  genesisHex: string;
  record: Uint8Array;
  expectedOffset?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const framed = new Uint8Array(4 + input.record.length);
  new DataView(framed.buffer).setUint32(0, input.record.length, false);
  framed.set(input.record, 4);
  const response = await fetch(
    `${input.baseUrl}/ds/${input.genesisHex}/${CONTROL_STREAM}/append-cas`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.client.credential!.token}`,
        [DEVICE_HEADER]: deviceHex(input.client.device),
        'content-type': 'application/octet-stream',
        'stream-expected-offset': input.expectedOffset ?? '-1',
      },
      body: Buffer.from(framed),
    }
  );
  return { ok: response.ok, status: response.status, body: await response.text() };
}
