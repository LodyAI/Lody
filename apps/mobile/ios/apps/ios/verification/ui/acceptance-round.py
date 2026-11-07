#!/usr/bin/env python3
"""Export one finished offline UI verify run as one Acceptance round.

Reads a completed ``--output`` directory written by ``run.py`` and produces the
``result.json`` + ``report.md`` + ``assets/`` tree that
``lh acceptance run ingest`` publishes as an immutable round. It never re-runs a
case, never imports ``run.py``, and never touches the network.

Use it only for a visual or interaction requirement alignment — a delivery a
reviewer decides item by item. An ordinary regression run stays a programmatic
gate in CI and is never ingested (README.md, "Acceptance rounds").

    python3 acceptance-round.py \
      --output .artifacts/ui-parallel/send \
      --title '融合 Plus 的玻璃交互' \
      --requirement '输入框融合后的 Plus 随玻璃按压同步缩放，展开时不出现独立圆形阴影。' \
      --claims /tmp/glass-claims.json

The claims file is the plan: one entry per behavior this alignment claims.

    [
      {
        "id": "glass-fusion",
        "behavior": "聊天输入框融合后共用玻璃交互",
        "category": "输入框交互",
        "cases": ["composer-glass-chat"],
        "requiredEvidence": ["screenshot", "video"]
      }
    ]

A claim's ``cases`` must have produced a result, and every declared
``requiredEvidence`` type must appear in that case's artifacts; otherwise the
round is not written. ``verifier`` defaults to ``program`` because the case
script asserted the behavior; set ``"verifier": "agent"`` for a purely visual
claim.

Exit codes: 0 round written; 1 a claimed case produced no result or required
evidence is missing; 2 unusable input.
"""
import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

APPEARANCES = ('light', 'dark')
BINARY_EVIDENCE = {
    '.gif': 'gif',
    '.jpeg': 'screenshot',
    '.jpg': 'screenshot',
    '.m4a': 'audio',
    '.mov': 'video',
    '.mp3': 'audio',
    '.mp4': 'video',
    '.png': 'screenshot',
    '.wav': 'audio',
}
TEXT_EVIDENCE = {'.log': 'text', '.md': 'markdown', '.txt': 'text', '.json': 'text'}
EVIDENCE_TYPES = {
    'audio', 'dom_snapshot', 'gif', 'markdown', 'screenshot', 'text', 'transcript', 'video',
}
# run.py records these when the harness could not produce a run, not when the
# product violated a behavior, so they map to a blocked case instead of a fail.
BLOCKED_MARKERS = (
    'exited before its first frame',
    'Required video was not captured',
    'timed out',
    'Video recorder did not start',
)


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def resolve_output(path):
    """Accept the batch directory itself or the parent that holds exactly one."""
    if not path.is_dir():
        fail(f'{path} is not a directory', 2)
    if (path / 'results.json').is_file():
        return path
    children = [child for child in sorted(path.iterdir()) if (child / 'results.json').is_file()]
    if len(children) == 1:
        return children[0]
    fail(f'{path} holds no results.json; pass the directory run.py wrote', 2)


def load_claims(path):
    try:
        claims = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        fail(f'Cannot read claims {path}: {error}', 2)
    if not isinstance(claims, list) or not claims:
        fail('The claims file must hold a non-empty list', 2)
    seen = set()
    for claim in claims:
        identifier = claim.get('id')
        if not identifier or identifier in seen:
            fail(f'Claim id must be unique and non-empty: {identifier!r}', 2)
        seen.add(identifier)
        if not claim.get('behavior') or not claim.get('cases'):
            fail(f'Claim {identifier} needs a behavior and at least one case', 2)
        unknown = set(claim.get('requiredEvidence', [])) - EVIDENCE_TYPES
        if unknown:
            fail(f'Claim {identifier} declares unknown evidence {sorted(unknown)}', 2)
    return claims


def evidence_type(path):
    suffix = path.suffix.lower()
    if suffix in BINARY_EVIDENCE:
        return BINARY_EVIDENCE[suffix]
    if suffix in TEXT_EVIDENCE:
        # The accessibility tree ui.capture() writes next to its screenshot.
        if suffix == '.json' and any(path.with_suffix(other).is_file() for other in ('.png', '.jpg')):
            return 'dom_snapshot'
        return TEXT_EVIDENCE[suffix]
    return None


def collect_evidence(output, case):
    found = []
    for appearance in APPEARANCES:
        directory = output / appearance / case
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if not path.is_file() or path.stat().st_size == 0:
                continue
            kind = evidence_type(path)
            if kind is not None:
                found.append((appearance, path, kind))
    return found


def claim_status(entries):
    if all(entry.get('status') == 'passed' for entry in entries):
        return 'pass'
    errors = [entry.get('error') or entry.get('status') for entry in entries if entry.get('status') != 'passed']
    if all(any(marker in error for marker in BLOCKED_MARKERS) for error in errors):
        return 'blocked'
    return 'fail'


def describe(entries, status):
    runs = ', '.join(f"{entry['case']} · {entry['appearance']}" for entry in entries)
    if status == 'pass':
        return f'{len(entries)} 次运行全部通过：{runs}'
    details = '；'.join(
        f"{entry['case']} · {entry['appearance']}：{entry.get('error') or entry.get('status')}"
        for entry in entries
        if entry.get('status') != 'passed'
    )
    return f'{len(entries)} 次运行（{runs}），未通过于 {details}'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', required=True, type=Path, help='A finished run.py --output directory, or its batch parent')
    parser.add_argument('--claims', required=True, type=Path, help='The claim list for this alignment')
    parser.add_argument('--title', required=True)
    parser.add_argument('--requirement', help='One-sentence durable goal; the first ingest of an acceptance needs it')
    parser.add_argument('--conclusion', help='One-paragraph verdict; composed from the claims when omitted')
    parser.add_argument('--acceptance', help='Existing acceptance id; only shapes the printed ingest command')
    parser.add_argument('--dir', type=Path, help='Round directory; defaults to .artifacts/acceptance/<timestamp>-<slug>')
    args = parser.parse_args()

    output = resolve_output(args.output)
    claims = load_claims(args.claims)
    try:
        results = json.loads((output / 'results.json').read_text())
    except (OSError, ValueError) as error:
        fail(f'Cannot read {output / "results.json"}: {error}', 2)
    entries_by_case = {}
    for entry in results:
        entries_by_case.setdefault(entry['case'], []).append(entry)

    missing = sorted({case for claim in claims for case in claim['cases'] if case not in entries_by_case})
    if missing:
        fail(f'No result for claimed case(s): {", ".join(missing)}; run them before exporting', 1)

    prepared = []
    problems = []
    for claim in claims:
        entries = [entry for case in claim['cases'] for entry in entries_by_case[case]]
        evidence = [item for case in claim['cases'] for item in collect_evidence(output, case)]
        kinds = {kind for _, _, kind in evidence}
        for required in claim.get('requiredEvidence', []):
            if required not in kinds:
                problems.append(f"{claim['id']}: required {required} evidence is missing")
        prepared.append((claim, entries, claim_status(entries), evidence))
    if problems:
        fail('Required evidence is missing:\n  ' + '\n  '.join(problems), 1)

    slug = ''.join(c if c.isascii() and c.isalnum() else '-' for c in args.title.lower()).strip('-')[:40]
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    round_dir = args.dir or Path('.artifacts/acceptance') / f'{stamp}-{slug or "round"}'
    if round_dir.exists() and any(round_dir.iterdir()):
        fail(f'{round_dir} already holds a round; a published round is immutable — pass a new --dir', 1)

    environment = {}
    if (output / 'environment.json').is_file():
        environment = json.loads((output / 'environment.json').read_text())
    language = environment.get('language', 'en')
    revision = str(environment.get('baseCommit', 'unknown'))[:12]
    dirty = '工作树有未提交改动' if environment.get('worktreeDirty') else '工作树干净'
    claimed_cases = sorted({case for claim in claims for case in claim['cases']})
    case_flags = ' '.join(f'--case {case}' for case in claimed_cases)
    command = f"pnpm verify:ui --app {environment.get('app', '<Debug.app>')} {case_flags} --language {language}"

    assets = round_dir / 'assets'
    run_assets = assets / 'run'
    run_assets.mkdir(parents=True)
    provenance = []
    for name in ('environment.json', 'results.json'):
        if (output / name).is_file():
            shutil.copy2(output / name, run_assets / name)
            provenance.append(f'assets/run/{name}')

    plan = []
    cases = []
    for claim, entries, status, evidence in prepared:
        paths = list(provenance)
        for appearance, path, _ in evidence:
            target = assets / path.parent.name / appearance / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            paths.append(f'assets/{target.relative_to(assets)}')
        plan.append({
            'id': claim['id'],
            'title': claim['behavior'],
            'category': claim.get('category', 'UI'),
            'verifier': claim.get('verifier', 'program'),
            'method': command,
            'expected': claim['behavior'],
            'requiredEvidence': claim.get('requiredEvidence', []),
        })
        cases.append({
            'id': claim['id'],
            'category': claim.get('category', 'UI'),
            'name': claim['behavior'],
            'surface': 'mobile',
            'status': status,
            'observation': describe(entries, status),
            'evidence': paths,
        })

    passed = sum(1 for case in cases if case['status'] == 'pass')
    blocked = sum(1 for case in cases if case['status'] == 'blocked')
    failed = sum(1 for case in cases if case['status'] == 'fail')
    if failed:
        verdict = 'fail'
    elif blocked:
        verdict = 'partial'
    else:
        verdict = 'pass'
    conclusion = args.conclusion or (
        f'{len(cases)} 项视觉/交互对齐：{passed} 通过、{failed} 失败、{blocked} 阻塞。'
        f'验证于 {revision}（{dirty}），语言 {language}，light 与 dark 两个外观。'
    )

    round_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        'cases': cases,
        'createdAt': datetime.now().astimezone().isoformat(timespec='seconds'),
        'entry': command,
        'plan': plan,
        'summary': {'total': len(cases), 'passed': passed, 'failed': failed, 'blocked': blocked,
                    'verdict': verdict, 'conclusion': conclusion},
        'surfaces': ['mobile'],
        'title': args.title,
    }
    if environment.get('baseCommit'):
        payload['commit'] = environment['baseCommit']
    (round_dir / 'result.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')

    (round_dir / 'report.md').write_text('\n\n'.join([
        f'## 范围\n\n本次只对齐 {len(cases)} 项视觉/交互行为：' + '、'.join(case['name'] for case in cases) + '。',
        f'## 环境\n\n- 命令：`{command}`\n- 提交：`{revision}`（{dirty}）\n- 设备：`{environment.get("udid", "unknown")}`'
        f'\n- 运行时：{environment.get("xcode", "unknown")}；AXe {environment.get("axe", "unknown")}'
        '## 证据\n\n每条对齐的证据都在 `assets/` 下，按 case 与外观分组；`assets/run/` 保留原始 '
        '`results.json` 与 `environment.json` 作为审计轨迹。',
        '## 门禁（不是 acceptance check）\n\n仓库自己的程序化门禁（`pnpm check` / `pnpm test` / '
        '`pnpm bundle` / `verify:native`）单独判定，不进入本轮。',
        '## 限制\n\n模拟器 Debug 结果；不声称真机性能、触感或云端持久化。'
        f'本轮只覆盖语言 `{language}`；要主张双语覆盖需分别导出并对照两个语言的运行。',
    ]) + '\n')

    print(f'Round: {round_dir}')
    print(f'Coverage: {len(cases)}/{len(cases)} checks, all required evidence present')
    print(f'Verdict: {verdict}')
    requirement = f" --requirement '{args.requirement}'" if args.requirement else ''
    acceptance = f" --acceptance {args.acceptance}" if args.acceptance else ''
    print(f'Publish: lh acceptance run ingest {round_dir} --source agent-testing{acceptance}{requirement}')


if __name__ == '__main__':
    main()
