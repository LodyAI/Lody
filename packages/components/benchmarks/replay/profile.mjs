import fs from 'node:fs';
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
for (const n of nodes.values())
  for (const child of n.children ?? []) nodes.get(child).parent = n.id;
const self = new Map(),
  inclusive = new Map();
const key = (n) =>
  `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url}:${n.callFrame.lineNumber + 1}`;
for (let i = 0; i < profile.samples.length; i++) {
  let n = nodes.get(profile.samples[i]);
  const dt = profile.timeDeltas[i] / 1000;
  const seen = new Set();
  if (n) self.set(key(n), (self.get(key(n)) ?? 0) + dt);
  while (n) {
    const k = key(n);
    if (!seen.has(k)) {
      inclusive.set(k, (inclusive.get(k) ?? 0) + dt);
      seen.add(k);
    }
    n = nodes.get(n.parent);
  }
}
/** @type {Array<[string, Map<string, number>]>} */
const tables = [
  ['SELF', self],
  ['INCLUSIVE (overlapping)', inclusive],
];
for (const [label, values] of tables) {
  console.log(label);
  for (const [k, v] of [...values].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(v.toFixed(2), k);
}
