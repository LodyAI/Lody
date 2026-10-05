import { ArrowRight } from 'lucide-react';
import { Faq, PageShell } from './coding-agent-pages';
import { SiteAnchor } from './site-anchor';

const routes = [
  [
    'Codex',
    'Built-in integration',
    'Choose a Codex Agent Config and a model available to your account. Lody dispatches scheduled prompts through that config; it does not import OpenAI automations.',
    '/docs/claude-codex-capabilities/#codex',
  ],
  [
    'Claude Code',
    'Built-in integration',
    'Schedule a prompt through your Claude Code config with its available model and permissions. Lody Schedules is separate from Claude Code /loop, Desktop tasks, and cloud routines.',
    '/docs/claude-codex-capabilities/#claude-code',
  ],
  [
    'Kimi Code',
    'Managed runtime',
    'Use the managed Kimi Code config on the execution machine. Complete its sign-in and test the selected model before relying on a recurring run.',
    '/docs/agents/#kimi',
  ],
  [
    'GLM over Claude Code',
    'Provider configuration',
    'Choose the GLM preset with a compatible endpoint and credentials. The scheduled task uses the Claude Code runtime with that provider configuration, not a separate native GLM agent.',
    '/docs/agents/#glm',
  ],
  [
    'DeepSeek Harness',
    'Built-in ACP provider',
    'Select the Harness config and its supported model. This is distinct from DeepSeek over Claude Code and from the upstream Harness Schedule subsystem.',
    '/docs/agents/#deepseek-harness',
  ],
  [
    'Pi',
    'Managed runtime',
    'Select a configured Pi provider on the machine. Providers without a permission selector use their own execution policy; ordinary provider and Session validation still applies.',
    '/docs/agents/#pi',
  ],
] as const;

export function CodingAgentSchedulerPage() {
  return (
    <PageShell kind="scheduler">
      <section className="agent-page__hero agent-page__hero--gui">
        <p className="agent-page__eyebrow">One schedule workflow. Your choice of agent.</p>
        <h1>
          Schedule Your <span>Coding Agents</span>
        </h1>
        <p className="agent-page__lead">
          Turn repeatable coding work into a task you can review. Choose the agent, execution
          machine, project, and cadence in Lody, then open each run as an ordinary conversation.
          Keep Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and Pi in one
          interface.
        </p>
        <div className="agent-page__actions">
          <SiteAnchor className="agent-page__button" href="/download/">
            Get Lody <ArrowRight size={17} aria-hidden="true" />
          </SiteAnchor>
          <SiteAnchor
            className="agent-page__button agent-page__button--secondary"
            href="/docs/scheduled-tasks/"
          >
            Set up a scheduled task
          </SiteAnchor>
        </div>
        <p className="agent-page__note">
          Runs on your own awake execution machine with the Lody CLI running. Scheduling does not
          wake a sleeping computer.
        </p>
      </section>

      <section className="agent-page__section" aria-labelledby="examples">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Start small</p>
          <h2 id="examples">A useful routine, with a clear result.</h2>
          <p>
            Copy a prompt into a new schedule, choose your project and Agent Config, and test it
            with Run now. These are example instructions, not measured agent results.
          </p>
        </div>
        <div className="agent-page__feature-grid">
          <article>
            <h3>Weekday change digest</h3>
            <p>Every weekday at 09:00 · New chat each run</p>
            <p>
              “Summarize commits from the last 24 hours in this checkout. Group changes by feature,
              include commit IDs, and flag items needing human review. Do not modify files or
              publish anything.”
            </p>
          </article>
          <article>
            <h3>Weekly maintenance brief</h3>
            <p>Every Friday at 15:00 · New chat each run</p>
            <p>
              “Inspect this repository’s dependency manifests and maintenance notes. List outdated
              assumptions and follow-up checks with file references. Do not install dependencies,
              edit files, or open pull requests.”
            </p>
          </article>
          <article>
            <h3>Repeatable test triage</h3>
            <p>Manual · Run now when needed</p>
            <p>
              “Run the test command documented for this project. Summarize failing tests and likely
              causes with evidence. Do not change code or retry commands that modify external
              services.”
            </p>
          </article>
        </div>
        <p className="agent-page__note">
          Prompts describe intent; they do not replace runtime permissions. Review the selected
          mode, credentials, commands, and likely usage costs before leaving a task unattended.
        </p>
      </section>

      <section className="agent-page__section" aria-labelledby="setup">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">From prompt to recurring work</p>
          <h2 id="setup">Configure. Confirm. Review.</h2>
        </div>
        <ol className="agent-page__steps">
          <li>
            <span>01</span>
            <h3>Choose where and how it runs</h3>
            <p>
              Open Schedules → New schedule. Set the prompt, machine, Agent Config, model, and
              available permissions. Add a project and worktree when the task needs a repository.
            </p>
          </li>
          <li>
            <span>02</span>
            <h3>Check the time and destination</h3>
            <p>
              Choose a daily, weekday, weekly, monthly, interval, one-time, or manual trigger. Check
              Next runs in the execution machine’s time zone. Send runs to a new chat, one chat for
              the task, or an existing chat.
            </p>
          </li>
          <li>
            <span>03</span>
            <h3>Test and inspect the result</h3>
            <p>
              Use Run now, then open Last run or Run history. A saved schedule is not proof that its
              Agent Config can execute successfully. Start with a narrow task and review its first
              runs.
            </p>
          </li>
        </ol>
        <p className="agent-page__note">
          An agent can also propose a task in chat. Review the Schedule this task? card and press
          Create to save it. Ignore leaves it uncreated.{' '}
          <SiteAnchor href="/docs/scheduled-tasks/">
            Follow the complete operating guide →
          </SiteAnchor>
        </p>
      </section>

      <section className="agent-page__section" aria-labelledby="agent-support">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Six integration routes</p>
          <h2 id="agent-support">The same list. Different runtimes.</h2>
          <p>
            These routes use Lody’s shared schedule and Session workflow. Models, authentication,
            permissions, and options depend on the selected config and installed runtime; coverage
            here is not an all-agent execution certification.
          </p>
        </div>
        <div className="agent-page__agent-grid">
          {routes.map(([name, type, description, href]) => (
            <article className="agent-page__agent" key={name}>
              <p className="agent-page__label">{type}</p>
              <h3>{name}</h3>
              <p>{description}</p>
              <SiteAnchor href={href}>
                Setup and capabilities <ArrowRight size={15} aria-hidden="true" />
              </SiteAnchor>
            </article>
          ))}
        </div>
        <p className="agent-page__note">
          Configuration validation can block a run before a chat starts. A reported case involving a
          saved Fast option with the value "false" is tracked in{' '}
          <SiteAnchor href="https://github.com/LodyAI/Lody/issues/1247#issuecomment-5986803074">
            issue #1247
          </SiteAnchor>
          ; DISPATCH_UNAVAILABLE can mask that validation failure.{' '}
          <SiteAnchor href="/docs/scheduled-tasks/#why-did-a-saved-task-fail-before-starting-a-chat">
            Read the troubleshooting guidance
          </SiteAnchor>
          .
        </p>
      </section>

      <section className="agent-page__section" aria-labelledby="official-options">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Choose the right workflow</p>
          <h2 id="official-options">Claude Code scheduled tasks and Codex automations.</h2>
          <p>
            Lody is an independent cross-agent workspace. Vendor scheduling features have their own
            execution environments and controls.
          </p>
        </div>
        <div className="agent-page__comparison-grid">
          <article>
            <h3>Claude Code scheduled tasks</h3>
            <p>
              Anthropic documents session-scoped /loop, Desktop scheduled tasks, and cloud routines.
              Choose its native workflow when those environments fit your Claude Code work. Lody
              adds its own Schedules list and run history across your configured agents; it does not
              promise identical timing or permissions.
            </p>
            <SiteAnchor href="https://code.claude.com/docs/en/scheduled-tasks">
              Compare Anthropic’s scheduling options ↗
            </SiteAnchor>
          </article>
          <article>
            <h3>Codex automations</h3>
            <p>
              OpenAI’s Codex automations guide now redirects to its Scheduled tasks documentation.
              That guide covers local project tasks and web tasks with different requirements. A
              Codex task in Lody runs through your chosen Lody Agent Config on its owning machine,
              alongside other supported agents.
            </p>
            <SiteAnchor href="https://developers.openai.com/codex/app/automations/">
              Read OpenAI’s current scheduling guide ↗
            </SiteAnchor>
          </article>
        </div>
        <p className="agent-page__note">
          DeepSeek Harness also documents an{' '}
          <SiteAnchor href="https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md">
            upstream Schedule subsystem
          </SiteAnchor>
          . Its tools and delivery semantics are separate from Lody Schedules. Sources checked
          October 5, 2026; source changes do not establish which runtime is installed on your
          machine.
        </p>
      </section>

      <Faq
        items={[
          {
            question: 'Will a task run while my computer is asleep?',
            answer: (
              <p>
                No. The owning machine must be awake with the Lody CLI running and the required
                runtime and resources available. You can manage tasks from another device, but that
                device does not replace the execution machine.
              </p>
            ),
          },
          {
            question: 'What happens to missed runs?',
            answer: (
              <p>
                Schedules created in the editor catch up once for the latest missed slot when the
                machine is available again. They do not replay every missed slot. If a previous run
                is still active, at most one follow-up waits. Advanced stored skip policies can
                differ.
              </p>
            ),
          },
          {
            question: 'Which time zone does the scheduler use?',
            answer: (
              <p>
                The editor uses the selected machine’s reported local time zone for input and
                preview. Once saves an absolute instant; calendar repeats retain the local-time
                rule. Older machines without time-zone metadata fall back to the viewing device’s
                zone, so update the CLI and inspect Next runs before saving.
              </p>
            ),
          },
          {
            question: 'Does an agent’s proposal automatically create a schedule?',
            answer: (
              <p>
                No. A proposal remains pending until you confirm Create in the card. Agents with the
                schedule tools can inspect tasks and pause an existing one; proposal confirmation is
                specifically the creation boundary.
              </p>
            ),
          },
          {
            question: 'Does Pause cancel a running task?',
            answer: (
              <p>
                Pause stops future scheduled runs. Stop an already-started chat separately. Review
                run history and the actual conversation before treating a run as successful.
              </p>
            ),
          },
        ]}
      />
      <section className="agent-page__closing">
        <p className="agent-page__eyebrow">Keep recurring work reviewable</p>
        <h2>Give your next routine a home.</h2>
        <p>Start with one task, one configured agent, and a result you can inspect.</p>
        <div className="agent-page__actions">
          <SiteAnchor className="agent-page__button" href="/docs/scheduled-tasks/">
            Create your first schedule <ArrowRight size={17} aria-hidden="true" />
          </SiteAnchor>
        </div>
      </section>
    </PageShell>
  );
}
