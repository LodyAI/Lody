import { createHash } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { getQuickJS } from 'quickjs-emscripten';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { automationCommandSchema } from '@lody/shared/automations';
import { evaluateAutomationProgram } from '../../automations/programs/quickjs';
import { registerAutomationTools } from '../automation-tools';
import { skillEntrySchema } from './catalog';
import { LODY_SKILL_INSTRUCTIONS, registerLodySkills } from './server';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture() {
  const server = new McpServer(
    { name: 'lody', version: 'test' },
    {
      instructions: LODY_SKILL_INSTRUCTIONS,
    }
  );
  registerLodySkills(server);
  const registrations: string[] = [];
  registerAutomationTools(server, async (command) => {
    if (command.type !== 'register') throw new Error('Expected registration');
    registrations.push(command.program);
    return { id: 'wait-1', sessionId: 'session', state: 'waiting' };
  });
  const client = new Client({ name: 'skill-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(() => Promise.all([client.close(), server.close()]));
  return { client, registrations };
}

const listingSchema = z.object({
  resultType: z.literal('complete').optional(),
  ttlMs: z.number(),
  cacheScope: z.literal('public'),
  skills: z.array(skillEntrySchema),
});

function textContent(value: unknown): string {
  return z
    .object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
    .parse(value)
    .content.map((block) => block.text)
    .join('\n');
}

async function readText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  return z.object({ text: z.string() }).parse(result.contents[0]).text;
}

describe('Lody Skills MCP server contract', () => {
  it('discovers complete manifests without loading bodies and serves the exact advertised bytes', async () => {
    const { client } = await fixture();
    expect(client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/skills']).toEqual(
      {}
    );
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const listed = await client.request({ method: 'skills/list', params: {} }, listingSchema);
    expect(listed.skills).toHaveLength(1);
    const entry = skillEntrySchema.parse(listed.skills[0]);
    const fetched = await client.request(
      { method: 'skills/get', params: { uri: entry.uri } },
      z.object({ skill: skillEntrySchema })
    );
    expect(fetched.skill).toEqual(entry);
    const resourceUris = new Set((await client.listResources()).resources.map((file) => file.uri));
    for (const file of entry.resources) {
      expect(resourceUris.has(file.uri)).toBe(true);
      const result = await client.readResource({ uri: file.uri });
      const content = z.object({ uri: z.string(), text: z.string() }).parse(result.contents[0]);
      expect(content.uri).toBe(file.uri);
      expect(Buffer.byteLength(content.text)).toBe(file.size);
      expect(`sha256:${createHash('sha256').update(content.text).digest('hex')}`).toBe(file.digest);
      if (file.uri.endsWith('.md')) {
        for (const link of content.text.matchAll(/\]\(([^)]+)\)/g)) {
          const target = new URL(z.string().parse(link[1]), file.uri).href;
          expect(resourceUris.has(target), `Unreachable skill link: ${target}`).toBe(true);
          expect((await client.readResource({ uri: target })).contents.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('registers the resource-served example through MCP and evaluates its condition', async () => {
    const { client, registrations } = await fixture();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['lody_automation']);
    const { skills } = await client.request({ method: 'skills/list', params: {} }, listingSchema);
    const entry = skills[0];
    if (!entry) throw new Error('Missing Automation skill');
    const guide = await readText(client, entry.uri);
    const example = /```json\n([\s\S]*?)\n```/.exec(guide)?.[1];
    if (!example) throw new Error('Missing registration example');
    const args = z.object({ command: automationCommandSchema }).parse(JSON.parse(example));
    const registered = await client.callTool({ name: 'lody_automation', arguments: args });
    expect(JSON.parse(textContent(registered))).toEqual({
      id: 'wait-1',
      sessionId: 'session',
      state: 'waiting',
    });
    const program = z.string().parse(registrations[0]);
    const module = await getQuickJS();
    const context = { sessionId: 'session', workspaceId: 'workspace', now: 100 };
    for (const value of ['unknown', 'no', 'yes']) {
      const result = await evaluateAutomationProgram(module, program, context, async (input) => {
        expect(input).toEqual({ resource: 'session.group', parameters: {} });
        return { observedAt: 100, value: { value, reason: 'synthetic' } };
      });
      if (value === 'yes')
        expect(result).toEqual({
          resumeText: 'Related work is complete. Continue summarizing the results.',
        });
      else expect(result).toBe(false);
    }
  });

  it('runs the served CI example against unavailable, passing and failing source observations', async () => {
    const { client } = await fixture();
    const program = await readText(client, 'skill://lody-automations/examples/wait-for-ci.js');
    const module = await getQuickJS();
    const context = { sessionId: 'session', workspaceId: 'workspace', now: 100 };
    const failed = { runId: 123, status: 'completed', conclusion: 'failure' };
    const observations = [
      { status: 'unknown', reason: 'no_linked_pull_request' },
      { status: 'observed', pullRequests: [{ runs: [{ ...failed, conclusion: 'success' }] }] },
      { status: 'observed', pullRequests: [{ runs: [failed] }] },
    ];
    const results = [];
    for (const value of observations)
      results.push(
        await evaluateAutomationProgram(module, program, context, async () => ({
          observedAt: 100,
          value,
        }))
      );
    expect(results).toEqual([
      false,
      false,
      {
        resumeText: 'CI failed. Inspect these runs and continue fixing the current task.',
        payload: [failed],
      },
    ]);
  });

  it('rejects unknown skill identities, cursors and file escapes', async () => {
    const { client } = await fixture();
    for (const uri of [
      'skill://missing/SKILL.md',
      'file:///etc/passwd',
      'skill://lody-automations/../../AGENTS.md',
      'skill://lody-automations/%2e%2e/AGENTS.md',
    ]) {
      await expect(
        client.request({ method: 'skills/get', params: { uri } }, z.object({}))
      ).rejects.toMatchObject({ code: -32602 });
      await expect(client.readResource({ uri })).rejects.toBeDefined();
    }
    await expect(
      client.request({ method: 'skills/list', params: { cursor: 'unknown' } }, listingSchema)
    ).rejects.toMatchObject({ code: -32602 });
  });
});
