"""Native workers run concurrently and retain evidence when a sibling fails."""
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import call, patch

from driver import UI, launch_covered, restart_accessibility
import catalog
from orchestrator import run_batches


class RunnerTest(unittest.TestCase):
    def test_native_catalog_formats_arguments_and_plural_variants(self):
        self.assertEqual(catalog.text('native.chat.attachment.preview', name='{name} 100%'), 'Preview attachment {name} 100%')
        self.assertEqual(catalog.plural('changes.fileCount', 1), '1 file')
        self.assertEqual(catalog.plural('changes.fileCount', 2), '2 files')
        self.assertEqual(catalog.format_value('%2$@ / %1$@ (100%%)', ['first', 'second']), 'second / first (100%)')
        self.assertEqual(catalog.format_value('%@ / %@', ['first', 'second']), 'first / second')

    def test_case_links_encode_the_action_and_allow_repeated_entry(self):
        with tempfile.TemporaryDirectory() as directory, patch('driver.subprocess.run') as run:
            ui = UI('owned-simulator', directory)
            ui.open_case('case with & query')
            ui.open_case('case with & query')
            urls = [call.args[0][-1] for call in run.call_args_list]
            queries = [parse_qs(urlparse(url).query) for url in urls]
            self.assertEqual([q['verifyCase'] for q in queries], [['case with & query']] * 2)
            self.assertNotEqual(queries[0]['request'], queries[1]['request'])
            self.assertTrue(all(urlparse(url).path == '/debug' for url in urls))
            self.assertTrue(all(call.kwargs['check'] and call.kwargs['timeout'] == 30 for call in run.call_args_list))

    def test_failed_case_link_is_not_silently_replaced_by_menu_navigation(self):
        with tempfile.TemporaryDirectory() as directory, patch('driver.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'openurl')):
            with self.assertRaises(subprocess.CalledProcessError):
                UI('owned-simulator', directory).open_case('send-handoff')

    def test_typing_submits_one_batch_without_losing_quotes_or_newlines(self):
        text = "draft 'quoted' \"double\"\nnext line & $value"
        with tempfile.TemporaryDirectory() as directory, patch('driver.subprocess.check_output', return_value='ok') as run:
            UI('owned-simulator', directory).axe('type', text)
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ['axe', 'batch', '--type-submission', 'composite'])
            self.assertEqual(shlex.split(command[command.index('--step') + 1]), ['type', text])
            self.assertEqual(command[-2:], ['--udid', 'owned-simulator'])
            run.assert_called_once()

    def test_batch_typing_does_not_retry_committed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('owned-simulator', directory)
            with patch.object(ui, 'axe') as axe, patch.object(ui, 'element', return_value={'AXValue': 'DRAFT'}), patch.object(ui, 'restore_software_keyboard') as restore:
                ui.type_into('field', 'draft')
                axe.assert_called_once_with('type', 'draft')
                restore.assert_called_once()

    def test_typing_restores_only_the_owned_simulator_keyboard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / 'software-keyboard'
            helper.touch()
            ui = UI('owned-simulator', root / 'light' / 'send')
            with patch('driver.subprocess.check_output', return_value='/Xcode/Developer\n'), patch('driver.subprocess.run') as run:
                ui.restore_software_keyboard()
                run.assert_called_once_with([str(helper), '/Xcode/Developer', 'owned-simulator'],
                                            check=True, timeout=30, capture_output=True)

    def test_keyboard_height_alone_does_not_prove_visibility(self):
        screen = {'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
        keyboard = {'AXUniqueId': 'inputView', 'frame': {'x': 0, 'y': 874, 'width': 402, 'height': 300}}
        self.assertIsNone(UI.visible_keyboard([screen, keyboard]))
        keyboard['frame']['y'] = 574
        self.assertEqual(UI.visible_keyboard([screen, keyboard]), keyboard['frame'])

    def test_keyboard_tutorial_requires_exact_copy_and_contained_button(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('owned-simulator', directory)
            items = [
                {'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}},
                {'AXUniqueId': 'inputView', 'frame': {'x': 0, 'y': 574, 'width': 402, 'height': 300}},
                {'type': 'Button', 'AXLabel': 'q', 'frame': {'x': 0, 'y': 600}},
                {'type': 'Button', 'AXLabel': 'a', 'frame': {'x': 0, 'y': 640}},
                {'type': 'Button', 'AXLabel': 'Continue', 'frame': {'x': 10, 'y': 100, 'width': 80, 'height': 44}},
            ]
            with patch.object(ui, 'axe') as axe:
                self.assertTrue(ui.keyboard_ready(items))
                axe.assert_not_called()
                items.append({'AXLabel': 'Speed up your typing by sliding your finger across the letters.', 'frame': {'x': 0, 'y': 700}})
                self.assertFalse(ui.keyboard_ready(items))
                axe.assert_not_called()
                items[-2]['frame']['y'] = 780
                self.assertFalse(ui.keyboard_ready(items))
                axe.assert_called_once()

    def test_batch_typing_recovers_uncommitted_input_once(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('owned-simulator', directory)
            with patch.object(ui, 'axe') as axe, patch.object(ui, 'element', side_effect=[{'AXValue': ''}, {'AXValue': 'draft'}]):
                ui.type_into('field', 'draft')
                self.assertEqual(axe.call_args_list, [
                    call('type', 'draft'),
                    call('tap', '--id', 'field', '--post-delay', '.4'),
                    call('type', 'draft'),
                ])

    def test_batch_typing_fails_when_retry_does_not_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('owned-simulator', directory)
            with patch.object(ui, 'axe') as axe, patch.object(ui, 'element', return_value={'AXValue': 'different'}):
                with self.assertRaisesRegex(AssertionError, 'did not commit'):
                    ui.type_into('field', 'draft')
                self.assertEqual(axe.call_args_list, [
                    call('type', 'draft'),
                    call('tap', '--id', 'field', '--post-delay', '.4'),
                    call('type', 'draft'),
                ])

    def test_parallel_workers_keep_sibling_results_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            worker = output / 'worker.py'
            worker.write_text('''import json, pathlib, sys, time
root, name = pathlib.Path(sys.argv[1]), sys.argv[2]
(root / (name + '.ready')).touch()
deadline = time.monotonic() + 10
while len(list(root.glob('*.ready'))) != 3:
    assert time.monotonic() < deadline, 'Workers did not start concurrently'
    time.sleep(.01)
status = 'failed' if name == 'b' else 'passed'
(root / name / 'results.json').write_text(json.dumps([{'case': name, 'status': status}]))
print('completed ' + name)
sys.exit(1 if name == 'b' else 0)
''')
            commands = {name: [sys.executable, str(worker), directory, name] for name in ['a', 'b', 'c']}
            self.assertEqual(run_batches(commands, output), 1)
            results = json.loads((output / 'results.json').read_text())
            self.assertEqual({r['case']: r['status'] for r in results}, {'a': 'passed', 'b': 'failed', 'c': 'passed'})
            for name in commands:
                self.assertIn('completed ' + name, (output / name / 'worker.log').read_text())



class AcceptanceRoundTest(unittest.TestCase):
    """A round keeps both appearances, refuses missing evidence, and separates blocked from fail."""

    SCRIPT = Path(__file__).with_name('acceptance-round.py')
    CLAIM = {
        'id': 'glass-fusion',
        'behavior': '聊天输入框融合后共用玻璃交互',
        'category': '输入框交互',
        'cases': ['composer-glass-chat'],
        'requiredEvidence': ['screenshot', 'video'],
    }

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.output = self.root / 'run'

    def tearDown(self):
        self.directory.cleanup()

    def write_run(self, statuses, errors):
        for appearance, status, error in zip(('light', 'dark'), statuses, errors):
            case = self.output / appearance / 'composer-glass-chat'
            case.mkdir(parents=True, exist_ok=True)
            (case / 'after.png').write_bytes(b'png ' + appearance.encode())
            (case / 'after.json').write_text('{}')
            (case / 'run.mp4').write_bytes(b'mp4')
        (self.output / 'results.json').write_text(json.dumps([
            {'case': 'composer-glass-chat', 'appearance': appearance, 'language': 'en', 'status': status, 'error': error}
            for appearance, status, error in zip(('light', 'dark'), statuses, errors)
        ]))
        (self.output / 'environment.json').write_text(json.dumps({
            'app': '/tmp/Lody.app', 'language': 'en', 'baseCommit': 'deadbeef',
        }))

    def export(self, claims, name, *extra):
        claims_path = self.root / f'{name}-claims.json'
        claims_path.write_text(json.dumps(claims, ensure_ascii=False))
        round_dir = self.root / name
        completed = subprocess.run(
            [sys.executable, str(self.SCRIPT), '--output', str(self.output), '--claims', str(claims_path),
             '--title', '融合 Plus 的玻璃交互', '--dir', str(round_dir), *extra],
            capture_output=True, text=True,
        )
        return completed, round_dir

    def test_round_keeps_each_appearance_apart(self):
        self.write_run(('passed', 'passed'), (None, None))
        completed, round_dir = self.export([self.CLAIM], 'round')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        evidence = json.loads((round_dir / 'result.json').read_text())['cases'][0]['evidence']
        self.assertEqual(len(evidence), len(set(evidence)), 'One appearance must not overwrite the other')
        self.assertTrue(all((round_dir / path).is_file() for path in evidence))
        for appearance in ('light', 'dark'):
            self.assertIn(f'assets/composer-glass-chat/{appearance}/after.png', evidence)

    def test_missing_required_evidence_writes_no_round(self):
        self.write_run(('passed', 'passed'), (None, None))
        claim = {**self.CLAIM, 'requiredEvidence': ['screenshot', 'gif']}
        completed, round_dir = self.export([claim], 'round-missing')
        self.assertEqual(completed.returncode, 1)
        self.assertIn('gif', completed.stderr)
        self.assertFalse(round_dir.exists())

    def test_harness_timeout_is_blocked_and_assertion_failure_is_not(self):
        self.write_run(('passed', 'failed'), (None, "Command 'x' timed out after 180 seconds"))
        completed, blocked_round = self.export([self.CLAIM], 'round-blocked')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        blocked = json.loads((blocked_round / 'result.json').read_text())
        self.assertEqual(blocked['cases'][0]['status'], 'blocked')
        self.assertEqual(blocked['summary']['verdict'], 'partial')

        self.write_run(('failed', 'passed'), ('AssertionError: Fast state did not update', None))
        completed, failed_round = self.export([self.CLAIM], 'round-failed')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        failed = json.loads((failed_round / 'result.json').read_text())
        self.assertEqual(failed['cases'][0]['status'], 'fail')
        self.assertEqual(failed['summary']['verdict'], 'fail')


class CaseSelectionTest(unittest.TestCase):
    def test_default_phone_run_excludes_pad_device_cases(self):
        source = Path(__file__).with_name('run.py').read_text()
        self.assertIn('PHONE_CASES', source)
        self.assertIn('selected = PHONE_CASES', source)
        self.assertNotIn('selected = CASES', source)
        self.assertIn('if args.case in PAD_CASES', source)

    def test_core_suite_is_the_six_product_paths(self):
        source = Path(__file__).with_name('run.py').read_text()
        self.assertIn(
            "'core': ['onboarding', 'home-settings', 'navigation', 'send', 'session-native', 'create-parity']",
            source,
        )
        self.assertIn("'core-home': ['onboarding', 'home-settings', 'navigation']", source)
        self.assertIn("'core-send': ['send', 'session-native', 'create-parity']", source)
        self.assertIn("selection.add_argument('--suite', choices=SUITES", source)
        self.assertIn('core_suite = args.suite in CORE_SUITES', source)
        self.assertIn("appearances = ['light']", source)
        self.assertIn("'--embedded'", source)
        self.assertNotIn('managed_metro', source)
        self.assertIn("ui.screenshot('failure')", source)
        self.assertIn("elif case == 'navigation':", source)
        self.assertIn("elif case == 'send':", source)
        self.assertIn('check_timeout = 480', source)
        self.assertIn('accessibility automation', Path(__file__).with_name('driver.py').read_text())
        self.assertIn("env['LODY_UI_NATIVE'] = '1'", source)
        self.assertIn('except subprocess.TimeoutExpired as error:', source)
        navigation = Path(__file__).with_name('navigation.py').read_text()
        driver = Path(__file__).with_name('driver.py').read_text()
        self.assertIn("for label in ('Open', '打开', '開啟'):", driver)
        self.assertIn('def allow_custom_scheme', driver)
        self.assertIn('allow_custom_scheme(ui)', source)
        self.assertIn('allow_custom_scheme(ui)', navigation)
        self.assertIn('_scheme_allowed', navigation)
        self.assertIn("range(2 if embedded else 3)", navigation)
        self.assertIn("range(1 if embedded else 2)", navigation)
        self.assertIn('recover=False', driver)
        self.assertIn('got.casefold() == text.casefold()', Path(__file__).with_name('driver.py').read_text())
        self.assertIn("if not os.environ.get('LODY_UI_NATIVE'):", Path(__file__).with_name('send-handoff.py').read_text())
        native = Path(__file__).resolve().parents[1].joinpath('native.py').read_text()
        self.assertIn('timeout=240', native)
        self.assertIn("files.insert(0, 'LodyUIVerify.swift')", native)


class CaptureTest(unittest.TestCase):
    def test_screenshot_does_not_need_axe(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)

            def run(command, **_kwargs):
                Path(command[-1]).write_bytes(b'png')
                return subprocess.CompletedProcess(command, 0)

            with patch('subprocess.run', run):
                path = ui.screenshot('failure')
            self.assertEqual(path, Path(directory) / 'failure.png')
            self.assertTrue(path.exists())

    def test_screenshot_retries_one_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = []

            def run(command, **_kwargs):
                calls.append(command)
                if len(calls) == 1:
                    raise subprocess.TimeoutExpired(command, 20)
                Path(command[-1]).write_bytes(b'png')
                return subprocess.CompletedProcess(command, 0)

            with patch('subprocess.run', run):
                self.assertTrue(ui.screenshot('failure').exists())
            self.assertEqual(len(calls), 2)

    def test_capture_keeps_screenshot_when_describe_ui_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)

            def run(command, **_kwargs):
                Path(command[-1]).write_bytes(b'png')
                return subprocess.CompletedProcess(command, 0)

            with (
                patch('subprocess.run', run),
                patch.object(ui, 'axe', side_effect=subprocess.TimeoutExpired('axe', 20)),
                self.assertRaises(subprocess.TimeoutExpired),
            ):
                ui.capture('failure')
            self.assertTrue((Path(directory) / 'failure.png').exists())

    def test_state_retries_until_axe_session_is_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = {'count': 0}

            def axe(*_args, **_kwargs):
                calls['count'] += 1
                if calls['count'] < 3:
                    raise RuntimeError('Error: Timed out creating the simulator remote automation session')
                return '[]'

            with patch.object(ui, 'axe', axe), patch('driver.time.sleep'):
                self.assertEqual(ui.state(), [])
            self.assertEqual(calls['count'], 3)
            self.assertTrue(ui._axe_ready)
            ui.invalidate_axe()
            self.assertFalse(ui._axe_ready)

    def test_wait_survives_a_cold_axe_session(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = {'count': 0}

            def state():
                calls['count'] += 1
                if calls['count'] < 3:
                    raise subprocess.TimeoutExpired('axe', 30)
                return [{'AXUniqueId': 'ui-verify-ready', 'pid': 1}]

            with patch.object(ui, 'state', state), patch('driver.time.sleep'):
                found = ui.wait(
                    lambda items: next((item for item in items if item.get('AXUniqueId') == 'ui-verify-ready'), None),
                    'Missing ui-verify-ready',
                    timeout=30,
                )
            self.assertEqual(found['pid'], 1)
            self.assertEqual(calls['count'], 3)

    def test_launch_covered_detects_springboard(self):
        self.assertFalse(launch_covered([], '15427'))
        self.assertFalse(launch_covered([{'pid': 15427, 'AXUniqueId': 'ui-verify-ready'}], '15427'))
        self.assertTrue(launch_covered([{'pid': 16345, 'AXLabel': 'Maps'}], '15427'))

    def test_axe_retries_when_the_session_dies_mid_command(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            ui._axe_ready = True
            calls = {'count': 0}

            def check_output(*_args, **_kwargs):
                calls['count'] += 1
                if calls['count'] < 3:
                    raise subprocess.TimeoutExpired('axe', 20)
                return 'ok'

            with (
                patch('subprocess.check_output', check_output),
                patch('driver.time.sleep'),
                patch('driver.restart_accessibility') as restart,
            ):
                self.assertEqual(ui.axe('tap', '--id', 'send-fail'), 'ok')
            self.assertEqual(calls['count'], 3)
            self.assertEqual(restart.call_count, 2)
            restart.assert_called_with('UDID')
            self.assertTrue(ui._axe_ready)

    def test_restart_accessibility_kickstarts_testmanagerd(self):
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0)) as run:
            restart_accessibility('UDID')
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ['xcrun', 'simctl', 'spawn', 'UDID'])
        self.assertEqual(command[-2:], ['-k', 'user/foreground/com.apple.testmanagerd'])
        self.assertFalse(run.call_args.kwargs['check'])

    def test_axe_retries_when_restoring_accessibility_times_out(self):
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            ui._axe_ready = True
            calls = {'count': 0}

            def check_output(*_args, **_kwargs):
                calls['count'] += 1
                if calls['count'] < 3:
                    return 'Error: AXe timed out while restoring accessibility automation.\n'
                return 'ok'

            with patch('subprocess.check_output', check_output), patch('driver.time.sleep'):
                self.assertEqual(ui.axe('tap', '--id', 'send-toggle-pending'), 'ok')
            self.assertEqual(calls['count'], 3)
            self.assertTrue(ui._axe_ready)


class CatalogTest(unittest.TestCase):
    def test_workspace_switch_includes_live_device_summary(self):
        self.assertEqual(
            catalog.workspace_switch('我的超长工作区名称不能折行'),
            'Switch workspace, 我的超长工作区名称不能折行, 2 online / 3 devices',
        )
        self.assertEqual(
            catalog.workspace_switch('另一个工作区', count=0, total=0),
            'Switch workspace, 另一个工作区, 0 online / 0 devices',
        )
        self.assertEqual(
            catalog.workspace_switch('2026'),
            'Switch workspace, 2026, 2 online / 3 devices',
        )

    def test_spoken_workspace_label_is_shared_by_home_hosts(self):
        for name in ('navigation.py', 'home.py', 'licenses.py', 'ipad-sidebar.py'):
            source = Path(__file__).with_name(name).read_text()
            self.assertIn('catalog.workspace_switch(', source, name)


class SchemePermissionTest(unittest.TestCase):
    def test_allow_custom_scheme_taps_open_then_falls_back_to_coordinates(self):
        from driver import allow_custom_scheme
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = []

            def axe(*args, **kwargs):
                calls.append(args)
                if args and args[0] == 'tap' and '--label' in args:
                    raise subprocess.TimeoutExpired('axe', 3)
                return 'ok'

            with patch.object(ui, 'axe', axe), patch('driver.time.sleep'):
                allow_custom_scheme(ui)
            self.assertEqual(calls[0][calls[0].index('--label') + 1], 'Open')
            self.assertEqual(calls[-1][:5], ('tap', '-x', '280', '-y', '450'))
            self.assertFalse(ui._axe_ready)

    def test_allow_custom_scheme_skips_coordinates_when_open_is_absent(self):
        from driver import allow_custom_scheme
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = []
            clock = {'t': 0}

            def axe(*args, **kwargs):
                calls.append(args)
                raise RuntimeError("Error: No accessibility element matched --label 'Open'.")

            with (
                patch.object(ui, 'axe', axe),
                patch('driver.time.monotonic', lambda: clock['t']),
                patch('driver.time.sleep', lambda seconds: clock.update(t=clock['t'] + seconds)),
            ):
                allow_custom_scheme(ui)
            labels = [args[args.index('--label') + 1] for args in calls if '--label' in args]
            self.assertGreaterEqual(len(labels), 6)
            self.assertEqual(labels[:3], ['Open', '打开', '開啟'])
            self.assertFalse(any(args[:2] == ('tap', '-x') for args in calls))

    def test_missing_open_from_cli_exit_does_not_tap_underlying_app(self):
        from driver import allow_custom_scheme
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            clock = {'t': 0}
            missing = subprocess.CalledProcessError(
                1, 'axe', output="Error: No accessibility element matched --label 'Open'.")
            with (
                patch('driver.subprocess.check_output', side_effect=missing) as command,
                patch('driver.time.monotonic', lambda: clock['t']),
                patch('driver.time.sleep', lambda seconds: clock.update(t=clock['t'] + seconds)),
            ):
                allow_custom_scheme(ui)
            self.assertTrue(command.call_args_list)
            self.assertFalse(any('-x' in call.args[0] for call in command.call_args_list))
            self.assertEqual(command.call_args.kwargs['stderr'], subprocess.STDOUT)

    def test_allow_custom_scheme_retries_until_open_appears(self):
        from driver import allow_custom_scheme
        with tempfile.TemporaryDirectory() as directory:
            ui = UI('UDID', directory)
            calls = []

            def axe(*args, **kwargs):
                calls.append(args)
                open_tries = sum(
                    1 for previous in calls if '--label' in previous and previous[previous.index('--label') + 1] == 'Open'
                )
                if args and '--label' in args and args[args.index('--label') + 1] == 'Open' and open_tries >= 2:
                    return 'ok'
                raise RuntimeError("Error: No accessibility element matched --label 'Open'.")

            with patch.object(ui, 'axe', axe), patch('driver.time.sleep'), patch('driver.time.monotonic', return_value=0):
                allow_custom_scheme(ui)
            labels = [args[args.index('--label') + 1] for args in calls if '--label' in args]
            self.assertEqual(labels[:4], ['Open', '打开', '開啟', 'Open'])
            self.assertFalse(any(args[:2] == ('tap', '-x') for args in calls))

    def test_runner_does_not_read_ax_before_dismissing_the_scheme_alert(self):
        handshake = Path(__file__).with_name('run.py').read_text().split('if not links_ready:')[1].split('links_ready = True')[0]
        self.assertIn('allow_custom_scheme(ui)', handshake)
        self.assertNotIn("ui.axe('tap', '--label', 'Open'", handshake)




if __name__ == '__main__':
    unittest.main()
