type Agent = {
  id: string;
  machineId: string;
  cliType: string;
  agentType: string;
};
type Options = {
  agents: Agent[];
  capabilities: {
    machineId: string;
    agentConfigId?: string;
    cliType: string;
    agentType: string;
  }[];
};
/** Revalidate the selected config; coalesce probes and back off failures. */
export function createCapabilityRefresh(
  request: (
    workspace: string,
    agent: Agent,
    signal: AbortSignal,
  ) => Promise<unknown>,
  currentWorkspace: () => string,
  changed: () => void,
) {
  const attempted = new Map<string, number>();
  const received = new Map<
    string,
    {
      workspace: string;
      machineId: string;
      configId: string;
      value: Record<string, unknown>;
    }
  >();
  const queue: { workspace: string; agent: Agent }[] = [];
  const busy = new Set<string>();
  let running = 0;
  function drain() {
    while (running < 2) {
      const index = queue.findIndex((item) => !busy.has(item.agent.machineId));
      if (index < 0) return;
      const item = queue.splice(index, 1)[0];
      if (currentWorkspace() !== item.workspace) continue;
      running++;
      busy.add(item.agent.machineId);
      void request(item.workspace, item.agent, AbortSignal.timeout(120_000))
        .then((reply) => {
          if (currentWorkspace() !== item.workspace) return;
          const result = (
            reply as { result?: Record<string, unknown> } | undefined
          )?.result;
          if (
            result?.success !== true ||
            result.machineId !== item.agent.machineId ||
            result.configId !== item.agent.id ||
            result.cliType !== item.agent.cliType ||
            result.agentType !== item.agent.agentType ||
            !result.capability ||
            typeof result.capability !== 'object'
          )
            return;
          received.set(
            JSON.stringify([
              item.workspace,
              item.agent.machineId,
              item.agent.id,
            ]),
            {
              workspace: item.workspace,
              machineId: item.agent.machineId,
              configId: item.agent.id,
              value: {
                ...(result.capability as Record<string, unknown>),
                fetchedAt: Date.now(),
                cliType: item.agent.cliType,
                agentType: item.agent.agentType,
              },
            },
          );
        })
        .catch(() => {}) // A failed probe must retain the existing choices.
        .finally(() => {
          const key = JSON.stringify([
            item.workspace,
            item.agent.machineId,
            item.agent.id,
          ]);
          if (!received.has(key)) attempted.set(key, Date.now() + 30_000);
          running--;
          busy.delete(item.agent.machineId);
          if (currentWorkspace() === item.workspace) changed();
          drain();
        });
    }
  }
  const refresh = (workspace: string, options: Options) => {
    for (const agent of options.agents) {
      const key = JSON.stringify([workspace, agent.machineId, agent.id]);
      if ((attempted.get(key) ?? -Infinity) > Date.now()) continue;
      // In-flight probes and successful results are shared across native refreshes.
      attempted.set(key, Infinity);
      queue.push({ workspace, agent });
    }
    drain();
  };
  return Object.assign(refresh, {
    rows: (workspace: string) =>
      [...received.values()].filter((row) => row.workspace === workspace),
  });
}
