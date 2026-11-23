import * as stylex from '@stylexjs/stylex';
import { hx } from './harness.tokens.stylex';

/** The file the choices write, drawn as a sheet of TOML. */
export const fileStyles = stylex.create({
  file: {
    borderRadius: '12px',
    overflow: 'hidden',
    backgroundColor: hx.panel,
    boxShadow: `${hx.highlight}, ${hx.card}`,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    height: '34px',
    padding: '0 4px 0 12px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: hx.lineSoft,
    backgroundColor: hx.sunken,
  },
  dots: { display: 'flex', gap: '5px' },
  dot: { width: '8px', height: '8px', borderRadius: '999px', backgroundColor: hx.line },
  name: {
    flex: 1,
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
    fontSize: '11.5px',
    color: hx.muted,
  },
  body: {
    margin: 0,
    padding: '10px 0 12px',
    fontSize: '11.5px',
    lineHeight: '19px',
    overflowX: 'auto',
    fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
  },
  line: { display: 'flex', whiteSpace: 'pre-wrap' },
  no: {
    width: '30px',
    flexShrink: 0,
    paddingInlineEnd: '10px',
    textAlign: 'end',
    color: hx.faint,
    opacity: 0.6,
    userSelect: 'none',
  },
  /** Long arrays wrap with a hanging indent under the value column. */
  text: {
    flex: 1,
    minWidth: 0,
    paddingInline: '12px',
    paddingInlineStart: 'calc(4px + 11ch)',
    textIndent: '-11ch',
    overflowWrap: 'anywhere',
    color: hx.text,
  },
  textComment: { color: hx.faint, fontStyle: 'italic' },
  textSection: { color: hx.ink, fontWeight: 600 },
  tokenKey: { color: hx.tkKey },
  tokenOperator: { color: hx.tkEq },
  tokenString: { color: hx.tkStr },
  tokenLiteral: { color: hx.tkBool },
});
