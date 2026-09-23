import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CloudOff, Lock, type LucideIcon } from 'lucide-react';
import type {
  LocalProjectBrowseDirectoryEntry,
  LocalProjectBrowseDirectoryResult,
  LocalProjectBrowseRootsResult,
  LocalProjectId,
  MachineId,
} from '@lody/shared';
import type { AddLocalProjectResult } from '@/lib/local-project-import';

/**
 * Result wrapper for the injected directory-browsing operations. Keeps the
 * picker decoupled from the RPC layer: the container maps the runtime response
 * into `{ ok, value }` / `{ ok, errorCode, message }`, and the picker renders
 * localized state from the (stable) `errorCode` rather than the raw message.
 */
export type RemoteDirectoryOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode?: string; message: string };

export interface RemoteDirectoryOps {
  listRoots: (
    machineId: MachineId
  ) => Promise<RemoteDirectoryOpResult<LocalProjectBrowseRootsResult>>;
  browseDir: (
    machineId: MachineId,
    args: { absolutePath?: string; cursor?: string }
  ) => Promise<RemoteDirectoryOpResult<LocalProjectBrowseDirectoryResult>>;
  // The project name is derived from the path by the host; the picker just
  // sends the chosen root.
  addProject: (
    machineId: MachineId,
    args: { rootPath: string }
  ) => Promise<RemoteDirectoryOpResult<AddLocalProjectResult>>;
}

export interface RemoteDirectoryPickerMachine {
  id: MachineId;
  name: string;
  online: boolean;
  ownerName: string | null;
  canAddProjects: boolean;
}

export type RemoteDirectoryPickerPhase = 'machine' | 'browse';
export type RemoteDirectoryBrowseStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RemoteDirectoryPickerArgs {
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading?: boolean;
  initialMachineId?: MachineId | null;
  ops: RemoteDirectoryOps;
  onAdded: (info: {
    machineId: MachineId;
    localProjectId: LocalProjectId;
    name: string;
    rootPath: string;
  }) => void;
  onLocateRegistered?: (machineId: MachineId, localProjectId: LocalProjectId) => void;
  onClose: () => void;
}

export function splitBreadcrumbs(
  fullPath: string,
  sep: '/' | '\\'
): { label: string; path: string }[] {
  if (!fullPath) return [];
  if (sep === '/') {
    const parts = fullPath.split('/').filter(Boolean);
    const crumbs = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  // Windows: first segment is the drive root (e.g. "C:"), which we render as "C:\".
  const normalized = fullPath.replace(/\\+$/, '');
  const parts = normalized.split('\\');
  const root = parts.shift() ?? '';
  const crumbs = [{ label: `${root}\\`, path: `${root}\\` }];
  let acc = root;
  for (const part of parts) {
    if (!part) continue;
    acc += `\\${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/**
 * Split a path into a truncatable `head` and an always-visible `tail` (the last
 * two segments), so the footer can ellipsize the prefix while keeping the folder
 * name and its parent readable. Derived from `splitBreadcrumbs` output so the
 * root/separator handling stays consistent with the breadcrumb bar; `tail` is a
 * literal suffix of the full path, so `head + tail` reconstructs it exactly.
 */
export function splitPathForTailPriority(
  crumbs: { label: string; path: string }[],
  sep: '/' | '\\'
): { head: string; tail: string } {
  if (crumbs.length === 0) return { head: '', tail: '…' };
  const fullPath = crumbs[crumbs.length - 1].path;
  const segments = crumbs.slice(1).map((crumb) => crumb.label);
  if (segments.length === 0) return { head: '', tail: crumbs[0].label };
  const tail = segments.slice(-2).join(sep);
  return { head: fullPath.slice(0, fullPath.length - tail.length), tail };
}

export function getTailPriorityBreadcrumbs<T>(
  crumbs: T[],
  visibleTailCount = 3
): { hiddenPrefix: boolean; visibleCrumbs: T[]; startIndex: number } {
  const startIndex = crumbs.length > visibleTailCount + 1 ? crumbs.length - visibleTailCount : 0;
  return {
    hiddenPrefix: startIndex > 0,
    visibleCrumbs: crumbs.slice(startIndex),
    startIndex,
  };
}

export function describeBrowseError(
  code: string | undefined,
  fallback: string,
  t: (key: string, defaultValue: string) => string
): { icon: LucideIcon; title: string; description: string } {
  if (code === 'access_denied') {
    return {
      icon: Lock,
      title: t('localProjects.add.deniedTitle', 'Access denied'),
      description:
        fallback ||
        t(
          'localProjects.add.deniedDescription',
          'Only the machine owner can browse and add directories.'
        ),
    };
  }
  if (code === 'timeout' || code === 'daemon_unavailable') {
    return {
      icon: CloudOff,
      title: t('localProjects.add.offlineTitle', 'Machine offline'),
      description: t(
        'localProjects.add.offlineDescription',
        "Can't reach this machine right now. Try again once it is back online."
      ),
    };
  }
  if (code === 'path_invalid' || code === 'execution_failed') {
    return {
      icon: AlertTriangle,
      title: t('localProjects.add.pathErrorTitle', "Can't open this folder"),
      description: fallback,
    };
  }
  return {
    icon: AlertTriangle,
    title: t('localProjects.add.genericErrorTitle', 'Something went wrong'),
    description: fallback,
  };
}

export function mergeRemoteDirectoryPage(
  current: LocalProjectBrowseDirectoryResult | null,
  page: LocalProjectBrowseDirectoryResult
): LocalProjectBrowseDirectoryResult | null {
  if (!current || current.path !== page.path) {
    return current;
  }
  return { ...page, entries: [...current.entries, ...page.entries] };
}

/**
 * Shared state machine for the add-local-project flow (machine select →
 * directory browse → confirm). The desktop dialog and the mobile sheet render
 * very differently but drive identical behavior off this hook.
 */
export function useRemoteDirectoryPicker({
  machines,
  machinesLoading = false,
  initialMachineId,
  ops,
  onAdded,
  onLocateRegistered,
  onClose,
}: RemoteDirectoryPickerArgs) {
  // Default to machine selection; specific entry points can pass
  // `initialMachineId` when the surrounding UI already chose the machine.
  const [phase, setPhase] = useState<RemoteDirectoryPickerPhase>('machine');
  const [selectedMachineId, setSelectedMachineId] = useState<MachineId | null>(null);
  const [blockedMachineId, setBlockedMachineId] = useState<MachineId | null>(null);
  const [roots, setRoots] = useState<LocalProjectBrowseRootsResult | null>(null);
  const [current, setCurrent] = useState<LocalProjectBrowseDirectoryResult | null>(null);
  const [status, setStatus] = useState<RemoteDirectoryBrowseStatus>('idle');
  const [browseError, setBrowseError] = useState<{ code?: string; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Guards against out-of-order responses when the user navigates quickly.
  const requestSeq = useRef(0);

  const sep = roots?.pathSeparator ?? '/';

  const browseTo = useCallback(
    async (machineId: MachineId, absolutePath: string | undefined) => {
      const seq = ++requestSeq.current;
      setStatus('loading');
      setBrowseError(null);
      setEditingPath(false);
      const res = await ops.browseDir(machineId, { absolutePath });
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        setStatus('error');
        setBrowseError({ code: res.errorCode, message: res.message });
        return;
      }
      setCurrent(res.value);
      setStatus('ready');
    },
    [ops]
  );

  const loadMachine = useCallback(
    async (machineId: MachineId) => {
      const seq = ++requestSeq.current;
      setStatus('loading');
      setBrowseError(null);
      const rootsRes = await ops.listRoots(machineId);
      if (seq !== requestSeq.current) return;
      if (!rootsRes.ok) {
        setStatus('error');
        setBrowseError({ code: rootsRes.errorCode, message: rootsRes.message });
        return;
      }
      setRoots(rootsRes.value);
      await browseTo(machineId, rootsRes.value.homeDir);
    },
    [ops, browseTo]
  );

  const initialMachineLoadRef = useRef<MachineId | null>(null);
  useEffect(() => {
    if (!initialMachineId) {
      initialMachineLoadRef.current = null;
      return;
    }
    const machine = machines.find((item) => item.id === initialMachineId);
    if (!machine?.online || !machine.canAddProjects) {
      return;
    }
    if (initialMachineLoadRef.current === initialMachineId) {
      return;
    }
    initialMachineLoadRef.current = initialMachineId;
    setSelectedMachineId(initialMachineId);
    setPhase('browse');
    void loadMachine(initialMachineId);
  }, [initialMachineId, loadMachine, machines]);

  const selectMachine = useCallback(
    (machineId: MachineId) => {
      const machine = machines.find((item) => item.id === machineId);
      if (!machine?.canAddProjects) {
        setBlockedMachineId(machineId);
        return;
      }
      if (!machine.online) {
        return;
      }
      setBlockedMachineId(null);
      setSelectedMachineId(machineId);
      setPhase('browse');
      void loadMachine(machineId);
    },
    [loadMachine, machines]
  );

  const navigate = useCallback(
    (absolutePath: string) => {
      if (selectedMachineId) void browseTo(selectedMachineId, absolutePath);
    },
    [selectedMachineId, browseTo]
  );

  const entryClick = useCallback(
    (entry: LocalProjectBrowseDirectoryEntry) => {
      if (!selectedMachineId) return;
      if (entry.error === 'unreadable') return;
      void browseTo(selectedMachineId, entry.absolutePath);
    },
    [selectedMachineId, browseTo]
  );

  const loadMore = useCallback(async () => {
    if (!selectedMachineId || !current?.truncated || !current.nextCursor) return;
    setLoadingMore(true);
    const res = await ops.browseDir(selectedMachineId, {
      absolutePath: current.path,
      cursor: current.nextCursor,
    });
    setLoadingMore(false);
    if (!res.ok || res.value.path !== current.path) return;
    setCurrent((prev) => mergeRemoteDirectoryPage(prev, res.value));
  }, [selectedMachineId, current, ops]);

  const startEditPath = useCallback(() => {
    setPathDraft(current?.path ?? '');
    setEditingPath(true);
  }, [current]);

  const cancelEditPath = useCallback(() => setEditingPath(false), []);

  const submitPath = useCallback(() => {
    const value = pathDraft.trim();
    if (!value || !selectedMachineId) return;
    setEditingPath(false);
    void browseTo(selectedMachineId, value);
  }, [pathDraft, selectedMachineId, browseTo]);

  // Adds the currently-browsed folder directly — there is no separate naming /
  // confirmation step. The host derives the project name from the path.
  const addCurrentFolder = useCallback(async () => {
    if (!current || !selectedMachineId || adding) return;
    setAdding(true);
    setAddError(null);
    const res = await ops.addProject(selectedMachineId, { rootPath: current.path });
    setAdding(false);
    if (!res.ok) {
      setAddError(res.message);
      return;
    }
    if (res.value.status === 'existing') {
      onLocateRegistered?.(selectedMachineId, res.value.localProjectId);
      onClose();
      return;
    }
    onAdded({
      machineId: selectedMachineId,
      localProjectId: res.value.localProjectId,
      name: res.value.name,
      rootPath: res.value.rootPath,
    });
    onClose();
  }, [current, selectedMachineId, adding, ops, onAdded, onLocateRegistered, onClose]);

  const back = useCallback(() => {
    // From the directory browser, step back to machine selection.
    requestSeq.current += 1;
    setPhase('machine');
    setSelectedMachineId(null);
    setBlockedMachineId(null);
    setCurrent(null);
    setRoots(null);
    setStatus('idle');
    setBrowseError(null);
  }, []);

  const retry = useCallback(() => {
    if (!selectedMachineId) return;
    if (current) void browseTo(selectedMachineId, current.path);
    else void loadMachine(selectedMachineId);
  }, [selectedMachineId, current, browseTo, loadMachine]);

  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
  const blockedMachine = machines.find((m) => m.id === blockedMachineId) ?? null;

  return {
    phase,
    machines,
    machinesLoading,
    selectedMachine,
    blockedMachine,
    roots,
    current,
    sep,
    status,
    browseError,
    loadingMore,
    editingPath,
    pathDraft,
    adding,
    addError,
    selectMachine,
    navigate,
    entryClick,
    loadMore,
    startEditPath,
    cancelEditPath,
    setPathDraft,
    submitPath,
    addCurrentFolder,
    back,
    retry,
    close: onClose,
  };
}

export type RemoteDirectoryPickerController = ReturnType<typeof useRemoteDirectoryPicker>;
