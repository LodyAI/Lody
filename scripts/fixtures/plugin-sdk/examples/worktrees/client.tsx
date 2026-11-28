import {
  defineClientPlugin,
  lodyQueries,
  useLody,
  useLodyQuery,
  type ProjectPageProps,
  type WorktreeEntry,
} from "@lody/plugin-sdk/client";
import { Alert, Badge, Button, Table, type TableColumn } from "@lody/ui";

function WorktreeManagerPage({ project }: ProjectPageProps) {
  const lody = useLody();
  const gitState = useLodyQuery(project, lodyQueries.gitState);
  const worktrees = useLodyQuery(project, lodyQueries.worktrees, { limit: 50 });

  if (gitState.status === "ready" && !gitState.data.hasRepository) {
    return (
      <Alert.Root tone="neutral">
        <Alert.Description>
          This project has no Git repository attached.
        </Alert.Description>
      </Alert.Root>
    );
  }

  if (worktrees.status === "loading") {
    return <div>Loading worktrees…</div>;
  }

  if (worktrees.status === "unavailable") {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>
          Worktree state is currently {worktrees.reason}. Verify the owning
          machine is online.
        </Alert.Description>
      </Alert.Root>
    );
  }

  if (worktrees.status === "error") {
    return (
      <Alert.Root tone="danger">
        <Alert.Description>{worktrees.message}</Alert.Description>
      </Alert.Root>
    );
  }

  const columns: readonly TableColumn<WorktreeEntry>[] = [
    {
      key: "branch",
      header: "Branch",
      cell: (row) => row.branch ?? "(detached)",
    },
    {
      key: "path",
      header: "Path",
      cell: (row) => row.path,
      wrap: true,
    },
    {
      key: "locked",
      header: "Lock",
      cell: (row) => (
        <Badge tone={row.locked ? "warning" : "neutral"}>
          {row.locked === null ? "unknown" : row.locked ? "locked" : "unlocked"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "Session",
      cell: (row) => (
        <div>
          <Button
            size="mini"
            variant="secondary"
            onClick={() => lody.sessions.open(row.rootSession)}
          >
            Open
          </Button>
          <Button
            size="mini"
            variant="ghost"
            onClick={() => void lody.sessions.requestArchive(row.rootSession)}
          >
            Archive
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Table
      columns={columns}
      rows={worktrees.data.items}
      rowKey={(row) => row.path}
      empty="No active session worktrees in this repository."
    />
  );
}

export default defineClientPlugin((lody) => {
  lody.project.pages.add({
    id: "worktrees",
    title: "Worktrees",
    Component: WorktreeManagerPage,
  });
});
