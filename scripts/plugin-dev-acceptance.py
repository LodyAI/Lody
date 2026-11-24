"""Run against the checkout's built local CLI: python3 scripts/plugin-dev-acceptance.py."""
import json
import os
from pathlib import Path
import sys
import shutil
import subprocess
import tempfile
import time

CLI = [shutil.which('node'), str(Path(__file__).resolve().parents[1] / 'apps/cli/dist-dev/index.js')]


def acceptance(root):
    if not sys.stdin.isatty() or 'LODY_AGENT_SESSION_ID' in os.environ:
        raise SystemExit('Run from an interactive machine-owner terminal.')
    data = root / 'data'
    env = dict(HOME=str(root), LODY_DATA_DIR=str(data), PATH=os.environ['PATH'])
    plugin = 'acceptance-plugin'

    def run(*args, owner=False, agent=False):
        result = subprocess.run(CLI + ['plugin', *args], cwd=root,
                                env=env | ({'LODY_AGENT_SESSION_ID': 'synthetic'} if agent else {}),
                                stdin=sys.stdin if owner else subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=75)
        if agent:
            assert result.returncode and 'owner terminal' in (result.stdout + result.stderr), (result.returncode, result.stdout, result.stderr)
            return
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return json.loads(result.stdout)

    run('create', plugin, '--template', 'workflow')
    assert run('doctor', plugin)['ok']
    folder = root / plugin
    machine = folder / 'machine/index.ts'
    def marker(which):
        return f'console.info(`accept-{which}:${{process.pid}}`)'
    machine.write_text(machine.read_text().replace("console.info('Workflow started')", marker('one')))
    run('create', 'client-fixture')
    shutil.copytree(root / 'client-fixture/client', folder / 'client')
    manifest = folder / 'lody.plugin.json'
    manifest.write_text(json.dumps(json.loads(manifest.read_text()) | {'client': 'client/index.ts'}))
    run('link', '--dev', plugin, owner=True, agent=True)
    daemon = subprocess.Popen(CLI + ['start'], cwd=root, env=env, stdin=subprocess.DEVNULL)
    try:
        def until(probe):
            deadline = time.monotonic() + 60
            while daemon.poll() is None and time.monotonic() < deadline:
                value = probe()
                if value:
                    return value
            raise RuntimeError(f'Isolated daemon exited ({daemon.poll()}) or condition timed out')

        def ready():
            # Read-only readiness probe: never retry a mutating link request.
            try:
                run('logs', plugin)
            except RuntimeError as error:
                return 'failed (400)' in str(error)
            return True
        until(ready)
        linked = run('link', '--dev', plugin, owner=True)
        def pid(which):
            import re
            matches = re.findall(r'accept-' + which + r':(\d+)', json.dumps(run('logs', plugin)))
            return int(matches[-1]) if matches else None
        first = until(lambda: pid('one'))
        machine.write_text(machine.read_text().replace(marker('one'), marker('two')))
        second = until(lambda: pid('two'))
        assert first != second
        client = folder / 'client/index.ts'
        client.write_text(client.read_text().replace('Hello from your plugin', 'Edited UI'))
        def changed():
            catalog, = data.glob('plugins/*/catalog.json')
            return json.loads(catalog.read_text())[0]['current']['clientDigest'] != linked['clientDigest']
        until(changed)
        before_reload = until(lambda: pid('two'))
        assert run('reload', plugin, owner=True)['enabled']
        after_reload = until(lambda: pid('two'))
        assert after_reload == before_reload == second
        assert not run('disable', plugin, owner=True)['enabled']
        def worker_stopped():
            try:
                os.kill(after_reload, 0)
            except ProcessLookupError:
                return True
            return False
        until(worker_stopped)
    finally:
        if daemon.poll() is None:
            daemon.terminate()
            daemon.wait(timeout=30)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='pa-', dir='/tmp') as directory:
        acceptance(Path(directory))
