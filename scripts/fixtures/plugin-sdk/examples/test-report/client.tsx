import { defineClientPlugin, useHost, type ToolRenderProps } from '@lody/plugin-sdk/client';
import { Badge, Button, Switch, Table, type TableColumn } from '@lody/ui';
import { useState } from 'react';
import type { z } from 'zod';
import { runSuiteTool, type TestCaseResult } from './shared';

type ReportProps = ToolRenderProps<
  z.infer<typeof runSuiteTool.input>,
  z.infer<typeof runSuiteTool.output>
>;

const columns: readonly TableColumn<TestCaseResult>[] = [
  { key: 'suite', header: 'Suite', cell: (row) => row.suite },
  { key: 'name', header: 'Test', cell: (row) => row.name, wrap: true },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <Badge
        tone={row.status === 'failed' ? 'danger' : row.status === 'passed' ? 'success' : 'neutral'}
      >
        {row.status}
      </Badge>
    ),
  },
  { key: 'duration', header: 'Time', numeric: true, cell: (row) => `${row.durationMs} ms` },
];

function CompletedTestReport({
  output,
  session,
  appendToDraft,
}: {
  output: z.infer<typeof runSuiteTool.output>;
  session: ReportProps['session'];
  appendToDraft: ReportProps['appendToDraft'];
}) {
  const host = useHost();
  const [failedOnly, setFailedOnly] = useState(output.failed > 0);
  const [selected, setSelected] = useState<string[]>([]);

  const visible = failedOnly
    ? output.cases.filter((item) => item.status === 'failed')
    : output.cases;

  const addSelectedFailuresToDraft = () => {
    const picked = output.cases.filter((item) => selected.includes(item.id));
    if (picked.length === 0) return;
    const summary = picked
      .map((item) => `- ${item.suite} > ${item.name}: ${item.failureMessage ?? 'failed'}`)
      .join('\n');
    appendToDraft({ kind: 'text', text: `Investigate failing tests:\n${summary}` });
  };

  return (
    <div>
      <div>
        <Badge tone={output.failed > 0 ? 'danger' : 'success'}>
          {output.failed} failed / {output.passed} passed
        </Badge>
        <Switch checked={failedOnly} onCheckedChange={setFailedOnly} />
        <Button
          size="small"
          variant="secondary"
          disabled={selected.length === 0}
          onClick={addSelectedFailuresToDraft}
        >
          Add to draft ({selected.length})
        </Button>
        {selected[0] && (
          <Button
            size="small"
            variant="ghost"
            onClick={() =>
              host.panels.openSession(session, 'suite-inspector', { caseId: selected[0]! })
            }
          >
            Inspect case
          </Button>
        )}
      </div>
      <Table
        columns={columns}
        rows={visible}
        rowKey={(row) => row.id}
        selected={selected}
        onSelectedChange={setSelected}
        empty="No matching test cases."
      />
    </div>
  );
}

function TestReportCard(props: ReportProps) {
  if (props.status === 'running') {
    return (
      <div>
        <Badge tone="running">
          Running suite{props.input.filter ? ` (${props.input.filter})` : ''}…
        </Badge>
      </div>
    );
  }
  return (
    <CompletedTestReport
      output={props.output}
      session={props.session}
      appendToDraft={props.appendToDraft}
    />
  );
}

export default defineClientPlugin((lody) => {
  lody.tools.render(runSuiteTool, TestReportCard);
});
