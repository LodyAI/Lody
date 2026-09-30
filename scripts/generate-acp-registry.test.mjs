import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRegistryIconArtifacts,
  validateRegistryIconSvg,
  normalizeRegistryAgents,
} from './generate-acp-registry.mjs';

const SAFE_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" d="M0 0h16v16H0z"/>
</svg>`;

void describe('ACP registry icon generation', () => {
  void it('downloads each unique icon once and maps aliases to the bundled asset', async () => {
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(url);
      return new Response(SAFE_SVG, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      });
    };

    const artifacts = await buildRegistryIconArtifacts(
      [
        { id: 'antigravity-acp', icon: 'https://cdn.example.test/antigravity.svg' },
        { id: 'kimi', icon: 'https://cdn.example.test/kimi.svg' },
        { id: 'kimi-code', icon: 'https://cdn.example.test/kimi.svg' },
      ],
      fetchImpl
    );

    assert.deepEqual(requestedUrls, [
      'https://cdn.example.test/antigravity.svg',
      'https://cdn.example.test/kimi.svg',
    ]);
    assert.deepEqual([...artifacts.assets.keys()], ['antigravity-acp', 'kimi']);
    assert.match(artifacts.moduleContent, /'antigravity-acp': antigravityAcpSvg/);
    assert.match(artifacts.moduleContent, /'kimi-code': kimiSvg/);
    assert.doesNotMatch(artifacts.moduleContent, /kimi-code\.svg\?raw/);
  });

  void it('rejects active SVG content before it can be bundled', () => {
    assert.throws(
      () =>
        validateRegistryIconSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          'unsafe-agent'
        ),
      /unsafe active or external content/
    );
    assert.throws(
      () =>
        validateRegistryIconSvg(
          '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M0 0"/></svg>',
          'fixed-color-agent'
        ),
      /must use currentColor/
    );
  });

  void it('strips a benign XML declaration from registry SVGs', () => {
    assert.equal(
      validateRegistryIconSvg(`<?xml version="1.0" standalone="no" ?>\n${SAFE_SVG}`, 'xml-agent'),
      `${SAFE_SVG}\n`
    );
  });
});

void it('excludes builtin duplicates without reintroducing local Kimi fallbacks', () => {
  const agents = ['devin', 'dimcode', 'kimi', 'kimi-code', 'third-party'].map((id) => ({
    id,
    name: id,
    version: '1.0.0',
    distribution: { npx: { package: `${id}@1.0.0` } },
  }));
  const ids = normalizeRegistryAgents(agents).map(({ id }) => id);
  assert.ok(ids.includes('third-party'));
  for (const id of ['devin', 'dimcode', 'kimi', 'kimi-code']) assert.ok(!ids.includes(id));
  const fallbackIds = normalizeRegistryAgents([]).map(({ id }) => id);
  assert.ok(!fallbackIds.includes('kimi'));
  assert.ok(!fallbackIds.includes('kimi-code'));
});
