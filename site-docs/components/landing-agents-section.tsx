'use client';

/**
 * LandingAgentsSection — the landing's third screen: "every coding agent".
 *
 * Three layers, back to front:
 *   1. `LandingAgentBanner` — every ACP mark in a bottom marquee strip;
 *   2. the multi-agent plate — the count lockup + copy over a background image
 *      slot the designer fills later (`--uw-agents-art`, see `app/underwater.css`);
 *   3. the built-in runtime matrix — what Codex / Claude Code / Kimi Code get
 *      beyond plain ACP.
 *
 * Two blocks and a banner keep the section roughly one viewport tall; a third
 * block would bury the matrix below the fold on a typical laptop height.
 *
 * Deliberately BORDERLESS: separation comes from surface tint, spacing and one
 * accent, never from outlines. See `app/underwater.css` (`.uw-agents*`).
 */

import { LandingAgentBanner } from './landing-agent-banner';
/* Matrix header marks come from the same generated set the banner uses, so a
   registry refresh can never leave the table on a stale logo. */
import { LANDING_AGENTS } from './landing-agents.generated';
import type { LandingLocale } from './landing';

export type AgentsSectionCopy = {
  eyebrow: string;
  /** Display count, e.g. "40+". Reads as the first half of `title`. */
  count: string;
  /** Headline continuing the count, e.g. "coding agents, one workspace". */
  title: string;
  body: string;
  /** Accessible name for the decorative agent marquee. */
  dropLabel: string;
  matrix: {
    title: string;
    note: string;
    /** Header column labels; index-aligned with `CAPABILITY_AGENTS`. */
    columns: [string, string, string];
    rows: [string, string, string];
  };
};

/** The three built-in runtimes, in the matrix's column order. */
const CAPABILITY_AGENTS = ['codex', 'claude-code', 'kimi'] as const;

const MARK_BY_ID = new Map(LANDING_AGENTS.map((agent) => [agent.id, agent]));

function CheckMark() {
  return (
    <svg viewBox="0 0 20 20" className="uw-agents__check" aria-hidden="true" focusable="false">
      <path
        d="M4.5 10.6 8.3 14.4 15.5 6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LandingAgentsSection({
  copy,
  locale,
}: {
  copy: AgentsSectionCopy;
  locale: LandingLocale;
}) {
  const supportedLabel = locale === 'zh' ? '支持' : 'Supported';

  return (
    <section className="uw-agents" aria-labelledby="uw-agents-title">
      <LandingAgentBanner label={copy.dropLabel} />

      <div className="uw-agents__inner">
        {/* Multi-agent plate. `--uw-agents-art` is the background image slot;
            until it is set, the plate paints the procedural field defined in the
            stylesheet. */}
        <div className="uw-agents__plate">
          <div className="uw-agents__art" aria-hidden="true" />
          <div className="uw-agents__plate-copy">
            <p className="uw-agents__eyebrow">{copy.eyebrow}</p>
            <h2 className="uw-agents__title" id="uw-agents-title">
              <span className="uw-agents__count">{copy.count}</span>
              <span className="uw-agents__title-rest">{copy.title}</span>
            </h2>
            <p className="uw-agents__body">{copy.body}</p>
          </div>
        </div>

        {/* Built-in runtime matrix — no rules, no cell borders: the header row
            and the zebra wash carry the alignment. */}
        <div className="uw-agents__matrix">
          <div className="uw-agents__matrix-head">
            <p className="uw-agents__matrix-title">{copy.matrix.title}</p>
            <p className="uw-agents__matrix-note">{copy.matrix.note}</p>
          </div>

          <table className="uw-agents__table">
            <caption className="sr-only">{copy.matrix.title}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{copy.matrix.title}</span>
                </th>
                {copy.matrix.columns.map((column, index) => {
                  const mark = MARK_BY_ID.get(CAPABILITY_AGENTS[index]);
                  return (
                    <th key={column} scope="col">
                      <span className="uw-agents__col">
                        {mark ? (
                          <span
                            className="uw-agents__col-mark"
                            aria-hidden="true"
                            // Registry marks are trusted build-time assets
                            // inlined by scripts/generate-landing-agents.mjs.
                            dangerouslySetInnerHTML={{ __html: mark.svg }}
                          />
                        ) : null}
                        <span className="uw-agents__col-name">{column}</span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {copy.matrix.rows.map((row) => (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  {copy.matrix.columns.map((column) => (
                    <td key={column}>
                      <CheckMark />
                      <span className="sr-only">{supportedLabel}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default LandingAgentsSection;
