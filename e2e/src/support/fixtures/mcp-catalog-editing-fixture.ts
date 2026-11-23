export class McpCatalogEditingFixture {
  readonly initialServerName = 'Synthetic editable workspace MCP';
  readonly editedServerName = 'Synthetic enabled workspace MCP';
  readonly initialDescription = 'Synthetic MCP catalog entry before editing';
  readonly editedDescription = 'Synthetic MCP catalog entry after editing';
  readonly command = process.execPath;
  readonly args = ['--version'];
}
