'use client';

/**
 * Landing — one agent runs the others.
 * Scannable claim + short use cases + a simple fan-out visual (no MCP diagram, no CLI).
 */

import { LANDING_AGENTS } from './landing-agents.generated';

const MARK_BY_ID = new Map(LANDING_AGENTS.map((agent) => [agent.id, agent]));

export type OrchestrationSectionCopy = {
  title: string;
  body: string;
  docsLink?: { href: string; label: string };
  useCases: readonly { title: string; body: string }[];
  hubLabel: string;
  sessions: readonly { task: string; agentId: string }[];
};

export function LandingOrchestrationSection({ copy }: { copy: OrchestrationSectionCopy }) {
  return (
    <section className="uw-orch" aria-labelledby="uw-orch-title">
      <div className="uw-orch__inner">
        <div className="uw-orch__layout">
          <div className="uw-orch__copy">
            <header className="uw-orch__header">
              <h2 className="uw-orch__title" id="uw-orch-title">
                {copy.title}
              </h2>
              <p className="uw-orch__body">{copy.body}</p>
              {copy.docsLink ? (
                <p className="uw-section-docs">
                  <a href={copy.docsLink.href}>{copy.docsLink.label}</a>
                </p>
              ) : null}
            </header>

            <ul className="uw-orch__cases">
              {copy.useCases.map((item) => (
                <li key={item.title} className="uw-orch__case">
                  <strong className="uw-orch__case-title">{item.title}</strong>
                  <span className="uw-orch__case-body">{item.body}</span>
                </li>
              ))}
            </ul>
          </div>

          <figure className="uw-orch__visual" aria-label={copy.title}>
            <div className="uw-orch__hub">
              <span className="uw-orch__hub-label">{copy.hubLabel}</span>
            </div>
            <div className="uw-orch__fan" aria-hidden="true">
              <span className="uw-orch__fan-stem" />
              <span className="uw-orch__fan-bar" />
            </div>
            <ul className="uw-orch__sessions">
              {copy.sessions.map((session) => {
                const mark = MARK_BY_ID.get(session.agentId);
                return (
                  <li key={session.task} className="uw-orch__session">
                    <span className="uw-orch__session-mark" aria-hidden="true">
                      {mark ? (
                        <span
                          className="uw-orch__session-glyph"
                          dangerouslySetInnerHTML={{ __html: mark.svg }}
                        />
                      ) : null}
                    </span>
                    <span className="uw-orch__session-copy">
                      <span className="uw-orch__session-task">{session.task}</span>
                      {mark ? <span className="uw-orch__session-agent">{mark.name}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        </div>
      </div>
    </section>
  );
}

export default LandingOrchestrationSection;
