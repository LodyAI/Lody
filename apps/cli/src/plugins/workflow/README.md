# Workflow contributions

[中文](README.zh.md)

An enabled installation exposes its Roles, Skills, MCP servers and ACP providers under `plugin:<plugin-id>:<contribution-id>`. A Role’s `promptPath` is read from the installed generation. Its `skills` refer to `skills/<name>/SKILL.md` in that same package; its `mcpServers` refer to local manifest IDs. Editing a contributed Role creates a separate user Role. Disabling the installation removes its contributions and closes the MCP and ACP processes it owns.

Use `transport: "stdio"` for a Node MCP entrypoint that exchanges MCP messages on stdin/stdout. For `transport: "http"`, listen on the socket named by `process.env.LODY_MCP_SOCKET` and serve Streamable HTTP at `/mcp`. From the listening callback send `process.send('lody:mcp-ready')`; Lody waits up to ten seconds before failing startup. Lody supplies a session-specific authenticated loopback URL to the ACP client; the plugin does not need a public port. Both transports and bundled ACP providers run outside the daemon with a minimal environment; list string or secret configuration keys in `envKeys` to opt in to those values.
