"""Generate all application, extension and verification targets with XcodeGen."""
from pathlib import Path
import json
import os
import plistlib
import subprocess


def generate(root, environment):
    generated = root / '.generated'
    (generated / 'Lody').mkdir(parents=True, exist_ok=True)
    info = plistlib.loads((root / 'App/Info.plist').read_bytes())
    version = json.loads((root / 'package.json').read_text())['version']
    build = environment.get('BUILD_NUMBER', info['CFBundleVersion'])
    info['CFBundleShortVersionString'] = version
    info['CFBundleVersion'] = build
    if 'LODY_ONESIGNAL_APP_ID' in environment:
        info['LodyOneSignalAppId'] = environment['LODY_ONESIGNAL_APP_ID']
    (generated / 'Lody/Info.plist').write_bytes(plistlib.dumps(info))
    spec = {
        'include': ['project.yml'],
        'settings': {'base': {'MARKETING_VERSION': version, 'CURRENT_PROJECT_VERSION': build}},
    }
    profiles = json.loads(environment.get('IOS_PROFILE_MAP', '{}'))
    if profiles:
        # Release signing is another XcodeGen input, never a post-generation project edit.
        targets = {'ai.lody.mobile': 'Lody', 'ai.lody.mobile.share': 'LodyShare',
                   'ai.lody.mobile.notification-service': 'LodyNotificationService'}
        if set(profiles) != set(targets):
            raise ValueError('Provisioning profiles must cover exactly the app and its two extensions')
        spec['targets'] = {targets[bundle]: {'settings': {'configs': {'Release': {
            'CODE_SIGN_STYLE': 'Manual', 'CODE_SIGN_IDENTITY': 'Apple Distribution',
            'DEVELOPMENT_TEAM': environment['APPLE_TEAM_ID'], 'PROVISIONING_PROFILE_SPECIFIER': profile,
        }}}} for bundle, profile in profiles.items()}
    generated_spec = generated / 'project.json'
    generated_spec.write_text(json.dumps(spec, indent=2) + '\n')
    subprocess.run(['xcodegen', 'generate', '--spec', str(generated_spec), '--project-root', str(root), '--project', str(root)], check=True)


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    subprocess.run(['/bin/bash', str(root.parents[1] / 'packages/LodyKit/DataChannel/build.sh')], check=True)
    generate(root, os.environ)
