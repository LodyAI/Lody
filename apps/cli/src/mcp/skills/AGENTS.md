# Built-in MCP skills

Parent MCP rules apply. [MCP guide](../README.md#skills-over-mcp).

- Serve only bundled product guidance. Caller URIs never select local files,
  network endpoints, user skills or another Session's resources.
- Protocol manifests and resource reads use one bundle;
  digests and byte lengths describe the exact served UTF-8 text.
- Keep model discovery to metadata. Load bodies and references into context on demand; loading a skill
  does not change execution permissions or run example programs.
- Skill discovery and activation belong to the MCP host's skill loader. Do not add
  product-specific reader tools or describe resource delivery as native activation.
- Generate schema references from the executing contracts. Examples must be runnable
  through the real condition interpreter with synthetic observations.
- Bundle text in both production and development builds; installed apps must not
  depend on a source checkout or writes to an Agent's skill directory.
- Use ACP `mcpServers` for connection setup. Skill consumption belongs to the Agent's
  MCP host; do not introduce ACP skill metadata, local snapshot installation or reader tools.
