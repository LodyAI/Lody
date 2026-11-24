import { useRouter } from '@tanstack/react-router';

export function usePluginNavigation() {
  const router = useRouter({ warn: false });
  const navigate = (
    caller: string,
    id: string,
    kind: 'screen' | 'project' | 'panel',
    params: Readonly<Record<string, string>> = {},
    target?: { machineId: string; projectId?: string; sessionId?: string }
  ) => {
    const workspace = router.state.matches.flatMap(({ params }) =>
      'workspaceName' in params ? [params.workspaceName] : []
    )[0];
    if (!workspace) throw Error('Workspace unavailable');
    const [plugin, item] = id.includes(':') ? id.split(':') : [caller, id];
    const segments =
      kind === 'panel'
        ? ['sessions', target!.sessionId!]
        : kind === 'project'
          ? ['projects', target!.machineId, target!.projectId!, 'p', plugin, item]
          : ['p', plugin, item];
    const path = '/' + [workspace, ...segments].map(encodeURIComponent).join('/');
    const search = new URLSearchParams(
      kind === 'panel' && path === router.state.location.pathname
        ? router.state.location.searchStr
        : ''
    );
    for (const [key, value] of Object.entries(params)) search.set(key, value);
    if (kind === 'panel') search.set('panel', `${plugin}:${item}`);
    void router.navigate({ href: path + (search.size ? '?' + search : '') });
  };
  return Object.assign(navigate, {
    setParams(caller: string, next: Readonly<Record<string, string>>, replace = false) {
      const { pathname } = router.state.location;
      const parts = pathname.split('/').map(decodeURIComponent);
      if (parts.length !== 5 || parts[2] !== 'p' || parts[3] !== caller)
        throw Error('Screen not active');
      void router.navigate({ href: pathname + '?' + new URLSearchParams(next), replace });
    },
  });
}
