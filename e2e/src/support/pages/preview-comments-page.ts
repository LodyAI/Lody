import { expect, type Page } from '@playwright/test';

/** Real Browser and annotation controls; no store/IPC authoring shortcuts. */
export class PreviewCommentsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    const open = this.page.getByRole('button', { name: /^(Open preview|打开预览)$/u });
    await expect(open).toBeVisible({ timeout: 60_000 });
    await open.click();
    await expect(
      this.page
        .frameLocator('iframe:visible')
        .getByRole('heading', { name: 'Synthetic Preview target', exact: true })
    ).toBeVisible({ timeout: 60_000 });
  }

  async add(body: string, target: string): Promise<void> {
    const annotate = this.page.getByRole('button', { name: /^(Annotate page|标注页面)$/u });
    if (await annotate.count()) {
      await expect(annotate).toBeEnabled({ timeout: 60_000 });
      await annotate.click();
    }
    const heading = this.page
      .frameLocator('iframe:visible')
      .getByRole('heading', { name: target, exact: true });
    await expect(heading).toBeVisible();
    const bounds = await heading.boundingBox();
    if (!bounds) throw new Error('Preview annotation target has no visible bounds');
    // Annotation mode intentionally owns a hit-testing overlay above the page.
    // Use a real pointer at the visible target, letting that overlay inspect it.
    await this.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const draft = this.page.locator('[data-lody-visual-comment-draft="true"]');
    await expect(draft).toBeVisible();
    await draft.getByRole('textbox').fill(body);
    await draft.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(draft).toHaveCount(0);
    await this.expectComment(body);
  }

  async resolve(body: string): Promise<void> {
    const comment = this.page.locator('[data-visual-comment-id]').filter({ hasText: body });
    await expect(comment).toBeVisible();
    await comment.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(comment).toHaveCount(0);
  }

  async expectComment(body: string): Promise<void> {
    await expect(
      this.page.locator('[data-visual-comment-id]').filter({ hasText: body })
    ).toBeVisible({ timeout: 60_000 });
  }

  async expectResolved(body: string): Promise<void> {
    await expect(
      this.page.locator('[data-visual-comment-id]').filter({ hasText: body })
    ).toHaveCount(0);
  }
}
