"""Native packaging preserves the shared resolver and requires public TLS endpoints."""
import importlib.util
from pathlib import Path
import unittest
import json
import os
import plistlib
import shutil
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('policy', Path(__file__).resolve().parents[1] / 'scripts/check-backend-build.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PackagingPolicy(unittest.TestCase):
    def test_http_cannot_be_packaged_even_in_debug(self):
        info = {'LodyBackends': {'CONVEX_URL': 'http://localhost:3210', 'CONVEX_SITE_URL': 'https://site.example', 'CF_WORKER_URL': 'https://worker.example'}}
        for configuration in ['Debug', 'Release', None, 'Distribution']:
            with self.assertRaises(ValueError):
                policy.validate(info, configuration)

    def test_https_can_be_packaged_in_release(self):
        policy.validate({'LodyBackends': {'CONVEX_URL': 'https://convex.lody.ai', 'CONVEX_SITE_URL': 'https://backend.lody.ai', 'CF_WORKER_URL': 'https://api.lody.ai'}}, 'Release')


class GeneratedConfiguration(unittest.TestCase):
    def test_native_and_extensions_receive_the_same_isolated_build_configuration(self):
        scripts = Path(__file__).resolve().parents[1] / 'scripts'
        spec = importlib.util.spec_from_file_location('prebuild', scripts / 'prebuild-native.py')
        prebuild = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(prebuild)
        with tempfile.TemporaryDirectory() as directory:
            mobile = Path(directory).resolve()
            root = mobile / 'ios/apps/ios'
            (root / 'scripts').mkdir(parents=True)
            (root / 'App').mkdir()
            shutil.copy(scripts.parents[3] / 'backend-config.mjs', mobile / 'backend-config.mjs')
            (root / 'App/Info.plist').write_bytes(plistlib.dumps({'CFBundleVersion': '1'}))
            (root / 'package.json').write_text('{' + '"version": "1.0.0"' + '}')
            (mobile / '.env.local').write_text('CONVEX_URL=https://file.example\n')
            environment = {key: value for key, value in os.environ.items()
                           if key not in ['CONVEX_URL', 'CONVEX_SITE_URL', 'CF_WORKER_URL']}
            environment.update(CONFIGURATION='Debug', CONVEX_URL='https://localhost:3230')
            # Only XcodeGen is replaced; the actual Node parser reads the file and environment.
            run = prebuild.subprocess.run
            def execute(command, *args, **kwargs):
                if command[0] == 'xcodegen':
                    return None
                return run(command, *args, **kwargs)
            with patch.object(prebuild.subprocess, 'run', side_effect=execute):
                prebuild.generate(root, environment)
            info = plistlib.loads((root / '.generated/Lody/Info.plist').read_bytes())
            backends = info['LodyBackends']
            self.assertEqual(backends['CONVEX_URL'], 'https://localhost:3230')
            self.assertEqual(backends['CONVEX_SITE_URL'], 'https://backend.lody.ai')
            self.assertTrue(backends['STORAGE_SUFFIX'].startswith('-'))
            self.assertNotIn('NSAppTransportSecurity', info)
            targets = json.loads((root / '.generated/project.json').read_text())['targets']
            for target in ['LodyShare', 'LodyNotificationService']:
                self.assertEqual(targets[target]['info']['properties']['LodyBackends'], backends)
            policy.validate(info, 'Release')


if __name__ == '__main__':
    unittest.main()
