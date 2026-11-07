import { describe, expect, it } from 'vitest';
import {
  getPreferredWorkspaceSlug,
  getWorkspaceSlugRuleError,
  isNavigableWorkspaceSlug,
  isUsableWorkspaceSlug,
} from '../src/lib/workspace';

describe('getPreferredWorkspaceSlug', () => {
  it('prefers active workspace over remembered workspace', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];
    const activeOrganization = { slug: 'alpha' };

    expect(getPreferredWorkspaceSlug(activeOrganization, organizations, 'beta')).toBe('alpha');
  });

  it('falls back to remembered workspace when active workspace is missing', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'beta')).toBe('beta');
  });

  it('falls back to first available workspace when remembered workspace is not accessible', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'gamma')).toBe('alpha');
  });

  it('allows reserved workspace slugs when choosing existing workspaces', () => {
    const organizations = [{ slug: 'blog' }, { slug: 'beta' }];
    const activeOrganization = { slug: 'blog' };

    expect(getPreferredWorkspaceSlug(activeOrganization, organizations, 'docs')).toBe('blog');
  });

  it('allows short existing workspace slugs when choosing a workspace', () => {
    const organizations = [{ slug: 'zh' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'zh')).toBe('zh');
  });
});

describe('workspace slug validation', () => {
  it('treats reserved workspace slugs as unavailable', () => {
    expect(getWorkspaceSlugRuleError('blog')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('Changelog')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('download')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('zh')).toBe('unavailable');
  });

  it('separates navigable existing workspace slugs from creatable workspace slugs', () => {
    expect(isNavigableWorkspaceSlug('zh')).toBe(true);
    expect(isUsableWorkspaceSlug('zh')).toBe(false);
  });
});
