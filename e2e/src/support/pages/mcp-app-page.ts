import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { MCP_APP_PROMPT, type McpAppFixture } from '../fixtures/mcp-app-fixture.js';

const AGENT_NAME = 'Deterministic MCP App Agent';
const SANDBOX_URL = 'lody-mcp-app://sandbox/';
const CONTROL_KEY = 'lody-e2e-mcp-app-storage-control';
const WORKING_STORAGE = { origin: 'null', storage: 'ok', session: 'ok', cookie: 'ok' } as const;

/** What the synthetic app reports after touching Web Storage and cookies (see `mcp-app-scripted-acp.mjs`). */
type StorageProbe = {
  origin: string;
  storage: string;
  session: string;
  cookie: string;
  before: string | null;
  marker: string;
};

/** Files under `root` whose bytes contain `marker` as Latin-1 or UTF-16LE (Chromium's DOM storage encodings). */
function filesContaining(root: string, marker: string): string[] {
  const needles = [Buffer.from(marker, 'latin1'), Buffer.from(marker, 'utf16le')];
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).size > 0) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(path);
        } catch (error) {
          // Windows denies reads of files Chromium holds exclusively (LevelDB `LOCK`).
          if ((error as NodeJS.ErrnoException).code === 'EBUSY') continue;
          throw error;
        }
        if (needles.some((needle) => bytes.includes(needle))) found.push(path);
      }
    }
  };
  visit(root);
  return found;
}

export class McpAppPage {
  private acpSessionId: string | undefined;
  private readonly storageProbes: StorageProbe[] = [];

  constructor(
    private readonly page: Page,
    private readonly electronApp: ElectronApplication,
    private readonly fixture: McpAppFixture
  ) {}

  async configureAgentFromSettings(): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Agents', exact: true }).click();
    const addProvider = settings.getByRole('button', { name: /^(Add provider|添加 Provider)$/u });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill(AGENT_NAME);
    await this.page.locator('#custom-acp-command').fill(this.fixture.agentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(AGENT_NAME, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }

  async sendMcpAppPrompt(): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(MCP_APP_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    const prompt = await this.fixture.waitForEvent(
      (event) => event.event === 'prompt-end' && event.mode === 'mcp-app'
    );
    this.acpSessionId = prompt.sessionId;
    await expect(this.page.getByText('Synthetic board opened.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }

  async expectCardShowsToolResult(): Promise<void> {
    const card = this.page.getByTestId('mcp-app-tool-call');
    await expect(card.getByText(/^(Opened|已打开) Synthetic Board$/u)).toBeVisible();
    const frame = card.getByTestId('mcp-app-frame');
    await expect(frame).toHaveAttribute('title', 'Synthetic Board');
    // Any extra sandbox token would let untrusted app HTML escape its opaque origin.
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('credentialless', '');
    await expect(frame).toHaveAttribute('src', SANDBOX_URL);
    await expect(this.app().locator('#result')).toHaveText('Synthetic board has 3 cards', {
      timeout: 30_000,
    });
    await expect(this.app().locator('#mode')).toHaveText('inline');
  }

  async expectAppStorageInOpaqueOrigin(): Promise<void> {
    const probe = await this.readStorageProbe();
    expect(probe).toMatchObject({ ...WORKING_STORAGE, before: null });
    this.storageProbes.push(probe);
  }

  async reloadMainWindow(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(this.page.getByTestId('mcp-app-tool-call')).toBeVisible({ timeout: 60_000 });
  }

  /**
   * The proxy's in-memory storage never reaches Chromium, so the app marker must
   * be absent from user data. The renderer's own `localStorage` write is the
   * positive control proving the disk scan can see a flushed value.
   */
  async expectAppStorageWasEphemeral(evidencePath: string, screenshotPath: string): Promise<void> {
    const [first] = this.storageProbes;
    expect(first).toBeDefined();
    await expect(this.app().locator('#result')).toHaveText('Synthetic board has 3 cards', {
      timeout: 30_000,
    });
    const reloaded = await this.readStorageProbe();
    expect(reloaded).toMatchObject({ ...WORKING_STORAGE, before: null });
    expect(reloaded.marker).not.toBe(first!.marker);
    this.storageProbes.push(reloaded);

    const userDataDir = await this.electronApp.evaluate(({ app }) => app.getPath('userData'));
    const control = `lody-e2e-control-${randomUUID()}`;
    await this.page.evaluate(([key, value]) => localStorage.setItem(key, value), [
      CONTROL_KEY,
      control,
    ] as const);
    await this.electronApp.evaluate(({ session }) => session.defaultSession.flushStorageData());
    await expect
      .poll(() => filesContaining(userDataDir, control).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const persisted = this.storageProbes.flatMap((probe) =>
      filesContaining(userDataDir, probe.marker)
    );
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          probes: this.storageProbes,
          controlFoundIn: filesContaining(userDataDir, control),
          probeFoundIn: persisted,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await this.page.evaluate((key) => localStorage.removeItem(key), CONTROL_KEY);
    expect(persisted).toEqual([]);
    await this.page.getByTestId('mcp-app-tool-call').screenshot({ path: screenshotPath });
  }

  async addCardFromApp(): Promise<void> {
    await this.app().getByRole('button', { name: 'Add card', exact: true }).click();
  }

  async expectRoundTripUpdatedApp(screenshotPath: string): Promise<void> {
    await expect(this.app().locator('#result')).toHaveText('Synthetic board has 4 cards', {
      timeout: 30_000,
    });
    const sessionId = this.acpSessionId;
    expect(sessionId).toBeTruthy();
    const events = this.fixture.readEvents();
    const toolCalls = events.filter((event) => event.event === 'mcp-app-tool-call');
    expect(toolCalls).toMatchObject([{ sessionId, name: 'add_card', cards: 4 }]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'mcp-app-load', sessionId, toolCallId: 'mcp-app-call-1' })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'mcp-app-resource-read',
        sessionId,
        uri: 'ui://synthetic/board.html',
      })
    );
    const initialize = events.find(
      (event) => event.event === 'initialize' && event.pid === toolCalls[0]!.pid
    );
    expect(initialize?.clientMcpApps).toEqual({ version: 1 });
    await this.page.getByTestId('mcp-app-tool-call').screenshot({ path: screenshotPath });
  }

  private async readStorageProbe(): Promise<StorageProbe> {
    const storage = this.app().locator('#storage');
    await expect(storage).not.toBeEmpty({ timeout: 30_000 });
    return JSON.parse((await storage.textContent()) ?? '') as StorageProbe;
  }

  private app() {
    return this.page.getByTestId('mcp-app-tool-call').getByTestId('mcp-app-frame').contentFrame();
  }
}
