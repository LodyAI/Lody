// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { FileLinkCandidateDialog } from '../src/components/sessions/file-link-candidate-dialog';
import { initI18n } from '../src/i18n';

const candidates = ['main', 'nested'].map((name) => ({
  path: `${name}/docs/guide.md`,
  absolutePath: `/repo/${name}/docs/guide.md`,
  worktreeRoot: `/repo/${name}`,
  branch: `refs/heads/${name}`,
  head: 'a'.repeat(40),
  mtimeMs: 1000,
}));

it.each(['select', 'cancel'])(
  'shows both identities and handles %s without guessing',
  async (action) => {
    await initI18n();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      return selected === null ? (
        <FileLinkCandidateDialog
          candidates={candidates}
          onSelect={(candidate) => setSelected(candidate.path)}
          onClose={() => setSelected('cancelled')}
        />
      ) : (
        <output>{selected}</output>
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      expect(document.body.textContent).toContain('/repo/main/docs/guide.md');
      expect(document.body.textContent).toContain('/repo/nested/docs/guide.md');
      expect(host.querySelector('output')).toBeNull();
      const buttons = [...document.querySelectorAll('button')];
      const button =
        action === 'select'
          ? buttons.filter((item) => item.textContent === 'Open this file')[1]
          : buttons.find((item) => item.textContent === 'Cancel');
      if (!button) throw new Error('Missing file choice action');
      await act(async () => button.click());
      expect(host.querySelector('output')?.textContent).toBe(
        action === 'select' ? 'nested/docs/guide.md' : 'cancelled'
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
);
