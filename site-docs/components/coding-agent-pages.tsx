import '@site/app/coding-agent.css';
import { ArrowRight, GitBranch, Laptop, Layers, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { SiteAnchor } from './site-anchor';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';

export type CodingAgentPageKind = 'gui' | 'remote';

const agents = [
  {
    name: 'Codex',
    type: 'Built-in integration',
    gui: 'Use Codex in a visual workspace with conversations, worktrees, and diff review. Lody also exposes supported Codex controls such as steering and Fast Mode.',
    remote:
      'Choose a Codex config on the connected machine, send a task from your phone, and return to its conversation and changes in Lody.',
    limit:
      'Models and controls depend on your Codex account and the runtime’s advertised capabilities.',
    href: '/docs/claude-codex-capabilities/#codex',
  },
  {
    name: 'Claude Code',
    type: 'Built-in integration',
    gui: 'Keep Claude Code conversations, permission requests, and file changes together. Browse available slash commands and steer active work when the config supports it.',
    remote:
      'Start or continue a Lody-managed Claude Code session on your machine. Review its progress and answer supported approval requests from another device.',
    limit:
      'Claude Code authentication and permissions still apply; available controls are discovered per config.',
    href: '/docs/claude-codex-capabilities/#claude-code',
  },
  {
    name: 'Kimi Code',
    type: 'Managed runtime',
    gui: 'Select the managed Kimi Code provider and complete sign-in, then use the same project and conversation interface as your other agents.',
    remote:
      'Configure Kimi Code on the execution machine, then select it in Lody’s shared remote workflow. The managed runtime does the work on that machine.',
    limit:
      'Managed runtime support does not imply that every Kimi web or terminal feature is exposed in Lody.',
    href: '/docs/agents/#kimi',
  },
  {
    name: 'GLM over Claude Code',
    type: 'Provider preset',
    gui: 'Use the GLM preset to configure a compatible endpoint and API key. Work with GLM models through the Claude Code runtime in Lody’s GUI.',
    remote:
      'Choose the GLM over Claude Code config on your connected machine. Lody routes the remote conversation to that configured Claude Code runtime.',
    limit:
      'This is a provider preset, not a separate native GLM agent or Anthropic Remote Control.',
    href: '/docs/agents/#glm',
  },
  {
    name: 'DeepSeek Harness',
    type: 'Built-in ACP provider',
    gui: 'Choose DeepSeek Harness with a DeepSeek API token or compatible custom endpoint. Lody provides the integration without a separate dsh installation.',
    remote:
      'Select the Harness Agent Config on the remote machine and follow its conversation in Lody. This is distinct from DeepSeek over Claude Code.',
    limit:
      'Harness has a known subagent model-inheritance limitation; review the setup guide before delegating work.',
    href: '/docs/agents/#deepseek-harness',
  },
  {
    name: 'Pi',
    type: 'Managed runtime',
    gui: 'Use Lody’s built-in Pi provider with its managed ACP runtime. Keep Pi work alongside your other agents without treating every terminal extension as a GUI feature.',
    remote:
      'Set up the supported Pi runtime and credentials on the execution machine, then choose its config from Lody on your other device.',
    limit:
      'Platform, runtime, model, and extension support vary. Legacy Pi configs may require an explicit migration and a new chat.',
    href: '/docs/agents/#pi',
  },
] as const;

function Actions({ remote = false }: { remote?: boolean }) {
  return (
    <div className="agent-page__actions">
      <SiteAnchor className="agent-page__button" href="/download/">
        Get Lody <ArrowRight size={17} aria-hidden="true" />
      </SiteAnchor>
      <SiteAnchor
        className="agent-page__button agent-page__button--secondary"
        href={remote ? '/docs/mobile/' : '/docs/quickstart/'}
      >
        {remote ? 'Set up mobile access' : 'Follow the quick start'}
      </SiteAnchor>
    </div>
  );
}

function PageShell({ kind, children }: { kind: CodingAgentPageKind; children: ReactNode }) {
  return (
    <div className="landing-page-root marketing-shell agent-page">
      <a className="agent-page__skip" href="#main-content">
        Skip to content
      </a>
      <SiteNav locale="en" />
      <main id="main-content" className="agent-page__main">
        <nav className="agent-page__switch" aria-label="Coding agent guides">
          <SiteAnchor href="/coding-agent-gui/" aria-current={kind === 'gui' ? 'page' : undefined}>
            Agent GUI
          </SiteAnchor>
          <SiteAnchor
            href="/coding-agent-remote-control/"
            aria-current={kind === 'remote' ? 'page' : undefined}
          >
            Remote control
          </SiteAnchor>
        </nav>
        {children}
      </main>
      <SiteFooter locale="en" />
    </div>
  );
}

function AgentSupport({ kind }: { kind: CodingAgentPageKind }) {
  return (
    <section className="agent-page__section" aria-labelledby="agent-support">
      <div className="agent-page__section-heading">
        <p className="agent-page__eyebrow">Choose your agent</p>
        <h2 id="agent-support">
          Different runtimes.
          <br />
          One familiar workspace.
        </h2>
        <p>
          Start with an Agent Config on the machine doing the work. Each integration keeps its own
          authentication, models, and capabilities.
        </p>
      </div>
      <div className="agent-page__agent-grid">
        {agents.map((agent) => (
          <article className="agent-page__agent" key={agent.name}>
            <p className="agent-page__label">{agent.type}</p>
            <h3>{agent.name}</h3>
            <p>{agent[kind]}</p>
            <p className="agent-page__limit">{agent.limit}</p>
            <SiteAnchor className="agent-page__text-link" href={agent.href}>
              Setup and capabilities <ArrowRight size={15} aria-hidden="true" />
            </SiteAnchor>
          </article>
        ))}
      </div>
      <p className="agent-page__note">
        {kind === 'remote'
          ? 'Remote access uses Lody’s shared Agent Config workflow. Available controls depend on the selected runtime, model, mode, and extension support on the execution machine.'
          : 'A shared GUI does not make every runtime identical. Model selection, modes, slash commands, and extensions depend on the selected config and runtime version.'}{' '}
        <SiteAnchor href="/docs/cli-runtimes/">Read the runtime requirements</SiteAnchor>.
      </p>
    </section>
  );
}

function Faq({ items }: { items: { question: string; answer: ReactNode }[] }) {
  return (
    <section className="agent-page__section agent-page__faq" aria-labelledby="questions">
      <div className="agent-page__section-heading">
        <p className="agent-page__eyebrow">Good to know</p>
        <h2 id="questions">Questions, answered.</h2>
      </div>
      {items.map(({ question, answer }) => (
        <details key={question}>
          <summary>{question}</summary>
          <div>{answer}</div>
        </details>
      ))}
    </section>
  );
}

function Closing({ remote = false }: { remote?: boolean }) {
  return (
    <section className="agent-page__closing">
      <p className="agent-page__eyebrow">Your agents. Your workflow.</p>
      <h2>
        {remote
          ? 'Step away from your desk.\nStay close to the work.'
          : 'Bring your agents together.'}
      </h2>
      <p>
        {remote
          ? 'Connect a machine, choose an agent, and pick up the conversation from your phone.'
          : 'Choose the right agent for the task, with one place to run it and review the result.'}
      </p>
      <Actions remote={remote} />
      <SiteAnchor className="agent-page__text-link" href="/login">
        Already using Lody? Open the web app <ArrowRight size={15} aria-hidden="true" />
      </SiteAnchor>
    </section>
  );
}

export function CodingAgentGuiPage() {
  return (
    <PageShell kind="gui">
      <section className="agent-page__hero agent-page__hero--gui">
        <p className="agent-page__eyebrow">A unified coding agent GUI</p>
        <h1>
          One GUI for Your <br />
          <span>Coding Agents</span>
        </h1>
        <p className="agent-page__lead">
          Bring Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and Pi into
          one visual workspace. Run tasks, follow conversations, and review code changes without
          rebuilding your workflow around each agent.
        </p>
        <Actions />
        <p className="agent-page__hero-note">
          Desktop apps for macOS, Windows, and Linux · Web and mobile access
        </p>
      </section>

      <figure className="agent-page__desktop-shot">
        <img
          src="/_docs-assets/20260716-new-ui.png"
          width={1844}
          height={1344}
          alt="Lody desktop showing an agent conversation, session sidebar, tabs, and changed files"
          fetchPriority="high"
        />
        <figcaption>
          Real Lody desktop interface: sessions, conversation, and changed files together.
          Appearance varies by version.
        </figcaption>
      </figure>

      <section className="agent-page__section" aria-labelledby="workflow">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Less switching. More context.</p>
          <h2 id="workflow">
            From the first prompt
            <br />
            to the final diff.
          </h2>
        </div>
        <div className="agent-page__feature-grid">
          <article>
            <Layers aria-hidden="true" />
            <h3>Keep tasks in view</h3>
            <p>
              Move between conversations and agent configs in one workspace. Keep the prompt,
              progress, and result attached to the task.
            </p>
            <SiteAnchor href="/docs/parallel-agents/">Run agents in parallel →</SiteAnchor>
          </article>
          <article>
            <GitBranch aria-hidden="true" />
            <h3>Give work its own space</h3>
            <p>
              Use isolated Git worktrees for parallel changes, then inspect the diff before deciding
              what to keep.
            </p>
            <SiteAnchor href="/docs/worktrees/">Understand worktrees →</SiteAnchor>
          </article>
          <article>
            <Smartphone aria-hidden="true" />
            <h3>Continue from another device</h3>
            <p>
              Follow supported sessions from Lody on the web or your phone while the execution
              machine stays online.
            </p>
            <SiteAnchor href="/coding-agent-remote-control/">Explore remote control →</SiteAnchor>
          </article>
        </div>
      </section>

      <AgentSupport kind="gui" />

      <section className="agent-page__section" aria-labelledby="gui-options">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Choose what fits</p>
          <h2 id="gui-options">Already have an agent GUI?</h2>
          <p>
            Official interfaces are useful. Lody is an independent workspace for people who want to
            use several coding agents through a consistent project, session, and review workflow.
          </p>
        </div>
        <div className="agent-page__comparison-grid">
          <article>
            <h3>A Codex GUI for mixed-agent work</h3>
            <p>
              OpenAI provides its own graphical and cloud experiences for Codex. Choose those when
              you want the official OpenAI workflow. Lody is another option when you want Codex work
              beside Claude Code, Kimi Code, or Pi, with shared session organization and diff
              review.
            </p>
            <SiteAnchor href="https://developers.openai.com/codex/app/">
              OpenAI’s official app guide ↗
            </SiteAnchor>
          </article>
          <article>
            <h3>A Claude Code GUI alongside your other agents</h3>
            <p>
              Claude Code already has official desktop, IDE, and web interfaces. Lody brings its
              supported controls into the same workspace as your other runtimes, including
              configured Claude-compatible endpoints. That does not mean every official feature is
              available through Lody.
            </p>
            <SiteAnchor href="https://code.claude.com/docs/en/desktop">
              Claude Code’s official desktop guide ↗
            </SiteAnchor>
          </article>
        </div>
        <p className="agent-page__note">
          Kimi Code also offers an{' '}
          <SiteAnchor href="https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html">
            official web GUI
          </SiteAnchor>
          , and DeepSeek Harness ships its own{' '}
          <SiteAnchor href="https://github.com/deepseek-ai/deepseek-harness">Web UI</SiteAnchor>.
          Lody’s focus is the workflow across agents, rather than replacing every vendor-specific
          interface.
        </p>
      </section>

      <Faq
        items={[
          {
            question: 'Is Lody an official Codex or Claude Code app?',
            answer: (
              <p>
                No. Lody is an independent coding-agent workspace. Codex, Claude Code, and the other
                runtimes keep their own accounts, terms, and capabilities.
              </p>
            ),
          },
          {
            question: 'Can I use my existing subscriptions or API keys?',
            answer: (
              <p>
                For supported setups, Lody uses the selected runtime’s authentication on the
                execution machine. Claude-compatible provider presets use their configured endpoints
                and keys. Follow <SiteAnchor href="/docs/agents/">Agent Config</SiteAnchor> for the
                exact setup; Lody does not include unlimited model usage.
              </p>
            ),
          },
          {
            question: 'Can I add another coding agent?',
            answer: (
              <p>
                Use a supported registry runtime, or configure a Custom ACP launch command. The
                machine needs that runtime’s dependencies and credentials.{' '}
                <SiteAnchor href="/docs/cli-runtimes/">See runtime setup</SiteAnchor>.
              </p>
            ),
          },
          {
            question: 'How do I get started?',
            answer: (
              <p>
                <SiteAnchor href="/download/">Download Lody</SiteAnchor>, add a project, configure
                your agent, and start a conversation. The{' '}
                <SiteAnchor href="/docs/quickstart/">quick start</SiteAnchor> covers desktop and CLI
                setup.
              </p>
            ),
          },
        ]}
      />
      <Closing />
    </PageShell>
  );
}

export function CodingAgentRemotePage() {
  return (
    <PageShell kind="remote">
      <section className="agent-page__hero agent-page__hero--remote">
        <div>
          <p className="agent-page__eyebrow">Your machine. Within reach.</p>
          <h1>
            Remote Control <br />
            for Your <br />
            <span>Coding Agents</span>
          </h1>
          <p className="agent-page__lead">
            Keep up with Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and
            Pi through Lody’s shared remote workflow. Send a prompt, check progress, and review
            changes from your phone or another computer.
          </p>
          <Actions remote />
          <p className="agent-page__hero-note">
            Agents run on your connected machine. Keep it awake, online, and running the Lody CLI.
          </p>
        </div>
        <figure className="agent-page__phone-shot">
          <img
            src="/_docs-assets/mobile-portrait.png"
            width={1039}
            height={2048}
            alt="Lody mobile app showing a Codex conversation and message composer"
            fetchPriority="high"
          />
          <figcaption>
            Real Lody mobile conversation view.
            <br />
            UI and models vary by version.
          </figcaption>
        </figure>
      </section>

      <section className="agent-page__section" aria-labelledby="remote-setup">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">How remote access works</p>
          <h2 id="remote-setup">
            The phone is your control.
            <br />
            The machine does the work.
          </h2>
          <p>
            Your repository, runtime, and execution environment stay on the selected machine. Lody
            gives you a way to interact with that work across devices.
          </p>
        </div>
        <ol className="agent-page__steps">
          <li>
            <span>01</span>
            <h3>Connect the execution machine</h3>
            <p>
              Install Lody on your workstation, or run the CLI on a remote server. Sign in and
              confirm that the machine appears online in your workspace.
            </p>
            <code>npx lody daemon start</code>
            <SiteAnchor href="/docs/quickstart/">CLI prerequisites and setup →</SiteAnchor>
          </li>
          <li>
            <span>02</span>
            <h3>Choose the project and agent</h3>
            <p>
              Add a project on that machine and configure the runtime you want to use. Check its
              login, models, and permissions before leaving your desk.
            </p>
            <SiteAnchor href="/docs/agents/">Configure your agents →</SiteAnchor>
          </li>
          <li>
            <span>03</span>
            <h3>Pick up the conversation</h3>
            <p>
              Sign in to the same workspace on mobile or web. Select the machine, project, and Agent
              Config, then start or continue the task.
            </p>
            <SiteAnchor href="/docs/mobile/">Mobile setup and features →</SiteAnchor>
          </li>
        </ol>
      </section>

      <section
        className="agent-page__section agent-page__remote-features"
        aria-labelledby="away-from-desk"
      >
        <div>
          <p className="agent-page__eyebrow">Away from the desk</p>
          <h2 id="away-from-desk">
            See what changed.
            <br />
            Decide what’s next.
          </h2>
        </div>
        <div className="agent-page__feature-grid">
          <article>
            <Smartphone aria-hidden="true" />
            <h3>Follow the task</h3>
            <p>
              Read the conversation, watch progress, and respond to supported permission requests.
              Mobile notifications can alert you when attention is needed.
            </p>
          </article>
          <article>
            <GitBranch aria-hidden="true" />
            <h3>Review the result</h3>
            <p>
              Inspect session diffs, review comments, and browse project files while the owning
              machine is available. Mobile realtime file editing is coming soon.
            </p>
          </article>
          <article>
            <Laptop aria-hidden="true" />
            <h3>Keep the right machine running</h3>
            <p>
              Use a workstation or server with the tools and repository access the task needs. A
              phone connection cannot wake a sleeping machine or replace its runtime.
            </p>
          </article>
        </div>
      </section>

      <AgentSupport kind="remote" />

      <section className="agent-page__section" aria-labelledby="official-options">
        <div className="agent-page__section-heading">
          <p className="agent-page__eyebrow">Understand your options</p>
          <h2 id="official-options">
            Official remote tools,
            <br />
            or a cross-agent workspace.
          </h2>
          <p>
            Lody is an independent product. These official options have their own setup,
            eligibility, and behavior; use the vendor’s guide when that is the workflow you want.
          </p>
        </div>
        <div className="agent-page__comparison-grid">
          <article id="claude-code-remote-control">
            <h3>Claude Code remote control</h3>
            <p>
              Anthropic’s Remote Control connects a local Claude Code session to Claude’s web and
              mobile interfaces. It is a direct option if your work stays in Claude Code and your
              account and configuration meet its requirements.
            </p>
            <p>
              Lody’s remote workflow connects to a Lody-managed session through its Agent Config.
              Choose it when you want Claude Code tasks and other agents in one workspace. The GLM
              over Claude Code preset uses Lody’s connection; it is not Anthropic’s Remote Control
              feature.
            </p>
            <SiteAnchor href="https://code.claude.com/docs/en/remote-control">
              Read Anthropic’s Remote Control guide ↗
            </SiteAnchor>
          </article>
          <article id="codex-remote">
            <h3>Codex remote control in Lody</h3>
            <p>
              OpenAI provides official app and cloud workflows for Codex. A cloud task and a session
              running on your own machine have different execution environments, so choose the one
              that fits the repository, tools, and access you need.
            </p>
            <p>
              In Lody, select the connected machine and its Codex config. The work runs there while
              you follow the session from Lody on another device. This is useful when you want to
              manage Codex alongside Claude Code, Kimi Code, DeepSeek Harness, or Pi.
            </p>
            <SiteAnchor href="https://developers.openai.com/codex/app/">
              OpenAI’s app guide ↗
            </SiteAnchor>
            {' · '}
            <SiteAnchor href="https://developers.openai.com/codex/cloud/">
              Codex Cloud guide ↗
            </SiteAnchor>
          </article>
        </div>
        <p className="agent-page__note">
          Kimi Code has its own{' '}
          <SiteAnchor href="https://www.kimi.com/code/docs/en/kimi-code-cli/guides/remote-control.html">
            Remote Control
          </SiteAnchor>
          . DeepSeek Harness also has an{' '}
          <SiteAnchor href="https://github.com/deepseek-ai/deepseek-harness">
            official Web UI
          </SiteAnchor>{' '}
          and an optional{' '}
          <SiteAnchor href="https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md">
            Schedule overlay
          </SiteAnchor>
          ; those upstream features are not a promise of feature parity in Lody.
        </p>
      </section>

      <Faq
        items={[
          {
            question: 'Does the coding agent run on my phone?',
            answer: (
              <p>
                No. Your phone controls a session on the selected connected machine. That machine
                needs the repository, runtime, credentials, and tools required by the task.
              </p>
            ),
          },
          {
            question: 'What happens if my computer sleeps or the CLI stops?',
            answer: (
              <p>
                Live remote work needs the machine awake and online with the Lody CLI running.
                Cached conversations can still be viewed offline, but remote execution and current
                file access need the machine to be available again.
              </p>
            ),
          },
          {
            question: 'Can I edit project files on mobile?',
            answer: (
              <p>
                You can browse project files, preview text, and review session diffs. Realtime file
                editing is available on desktop; mobile editing is coming soon. You can send an
                instruction to the agent to make a change on the execution machine.
              </p>
            ),
          },
          {
            question: 'Will every agent expose the same controls remotely?',
            answer: (
              <p>
                No. Runtime capabilities determine model and mode selection, commands, and
                extensions. Refresh and test the Agent Config on the owning machine, and consult its
                setup notes.{' '}
                <SiteAnchor href="/docs/cli-runtimes/">Read the runtime requirements</SiteAnchor>.
              </p>
            ),
          },
        ]}
      />
      <Closing remote />
    </PageShell>
  );
}
