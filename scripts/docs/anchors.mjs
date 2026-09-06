// AfterRay-inspired marker -> declaration -> content hash, using the TS parser
// rather than brace counting. Repository TypeScript is loaded only for anchors.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
export const sourceRoots = ['apps', 'packages'];
export const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export function extractAnchors(file, text) {
  if (!text.includes('@dec:')) return [];
  const ts = require('typescript');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`${file}: cannot parse anchored source`);
  const declarations = [];
  const comments = new Map();
  function visit(node) {
    for (const comment of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      comments.set(comment.pos, comment);
    }
    if (ts.isStatement(node) || ts.isClassElement(node) || ts.isTypeElement(node)) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const anchors = [];
  for (const comment of comments.values()) {
    const raw = text.slice(comment.pos, comment.end);
    if (!raw.includes('@dec:')) continue;
    const match = /^\/\/\s*@dec:([^\s]+)\s*$/.exec(raw);
    if (!match) throw new Error(`${file}: use // @dec:<document topic path>`);
    const candidates = declarations.filter(
      (node) =>
        node.getStart(ast) >= comment.end &&
        (ts.getLeadingCommentRanges(text, node.pos) ?? []).some((c) => c.pos === comment.pos)
    );
    candidates.sort((a, b) => a.getStart(ast) - b.getStart(ast) || b.end - a.end);
    const node = candidates[0];
    if (!node || ts.isBlock(node) || ts.isEmptyStatement(node))
      throw new Error(`${file}: @dec:${match[1]} has no following declaration`);
    const body = text
      .slice(node.getStart(ast), node.end)
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n');
    const signature = body.split('\n')[0].trim();
    anchors.push({
      topic: match[1],
      file,
      signature,
      hash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    });
  }
  return anchors;
}
