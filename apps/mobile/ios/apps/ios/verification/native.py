"""Compile and run existing production Swift behavior checks without credentials."""
import argparse
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from simulator import run_with_simulator, SimulatorPool

root = Path(__file__).resolve().parents[3]
kit = root / 'packages/LodyKit'
checks_root = root / 'apps/ios/verification/kit'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--case', help='Run one named native check, such as attachments or chat')
parser.add_argument(
    '--udid',
    default=os.environ.get('LODY_VERIFY_UDID') or None,
    help='Existing Simulator; omit to lease a clean Lody Verify Simulator',
)
args = parser.parse_args()
if args.udid is None:
    command = [sys.executable, __file__, *sys.argv[1:]]
    raise SystemExit(run_with_simulator(SimulatorPool(), 'Native', command))
sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
checks = {
    'session-subscriptions': ['Cloud/SessionSubscriptions.swift'],
    'home-layout': ['Chrome/LodyHomeLayout.swift'],
    'fold-host': ['Chrome/LodyFoldHost.swift'],
    'session-feed': ['Sessions/SessionFeed.swift', 'Sessions/SessionEnvelope.swift', 'Sessions/SessionPermission.swift'],
    'session-simulator': ['Sessions/SessionSimulator.swift'],
    'preview-feedback': ['Outbox/OutboxRecord.swift', 'Outbox/OutboxStore.swift', 'HTMLPreview/PreviewFeedback.swift'],
    'pull-request': ['PullRequests/PullRequestStore.swift'],
    'item-details': ['ItemDetails/ItemDetailStore.swift'],
    'message-details': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/LodyListState.swift', 'Chat/ChatTurnMetadata.swift', 'Chat/ChatSessionUsage.swift', 'Chat/ChatUsagePanel.swift', 'Messages/MessageDetailsSections.swift'],
    'html-preview': ['LodyLocalization.swift', 'HTMLPreview/HTMLPreviewResource.swift', 'HTMLPreview/HTMLPreviewText.swift'],
    'simulator-transport': ['LodyLocalization.swift', 'SimulatorStream/SimulatorDeviceView.swift', 'SimulatorStream/SimulatorRemote.swift', 'SimulatorStream/SimulatorRTCFrame.swift', 'SimulatorStream/SimulatorRTC.swift', 'SimulatorStream/SimulatorTransport.swift'],
    'chat-kit': [],
    'lexical-swift': [],
    'scroll-edges': ['Chrome/LodyScrollEdges.swift', 'LodyTint.swift', 'Chrome/LodyEdgeFade.swift'],
    'glass-transition': [],
    'github-mentions': ['Cloud/GitHubMentions.swift'],
    'github-pr': ['Cloud/GitHubPullRequests.swift'],
    'session-sharing': ['Cloud/SessionSharing.swift'],
    'settings': ['Cloud/WorkspaceSettingsCloud.swift', 'Cloud/WorkspaceUsage.swift'],
    'workspace-settings-pages': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/SettingsWorkspace.swift', 'Settings/ProjectVisibilitySections.swift', 'Settings/GitHubSettingsSections.swift'],
    'settings-runtime-pages': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/LodyListState.swift', 'Settings/MemorySettingsSections.swift', 'Settings/PublishedSharesSections.swift'],
    'remote-settings': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/LodyListState.swift', 'Settings/SettingsWorkspace.swift', 'Settings/RemoteSettingsSections.swift', 'Sessions/SessionUsageSelection.swift', 'Chat/LodyAgentIcon.swift'],
    'session-rows': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/LodyListState.swift', 'Sessions/SessionCatalog.swift', 'Sessions/SessionRows.swift', 'Sessions/SessionTabSelection.swift', 'Sessions/HomeGrouping.swift', 'Sessions/InboxSections.swift', 'Sessions/SessionEnvelope.swift', 'Sessions/SessionPermission.swift'],
    'ai-usage': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/LodyListState.swift', 'Settings/AIUsageModels.swift', 'Settings/AIUsageSections.swift'],
    'settings-roles': ['LodyLocalization.swift', 'List/LodyListModels.swift', 'Settings/PromptShortcutSections.swift', 'Settings/AgentRoleSections.swift'],
    'notifications': ['Notifications/PushRegistration.swift', 'Notifications/PushPermissionLaunchRequest.swift', 'Notifications/PushClickBuffer.swift'],
    'diagnostics': ['Diagnostics/DiagnosticsStore.swift'],
    'photo-cache': ['List/PhotoDiskCache.swift'],
    'file-link': ['Chat/ChatFileLink.swift', 'Sessions/SessionController+Files.swift', 'Shell/LodyPageController.swift', 'LodyLocalization.swift'],
    'strings': ['LodyLocalization.swift'],
    'auth': ['LodyLocalization.swift', 'Auth/AuthAPI.swift', 'Auth/NativeAuthHandoff.swift'],
    'auth-session': ['LodyLocalization.swift', 'Auth/AuthAPI.swift', 'Auth/AuthSession.swift', 'Auth/NativeLoginMethod.swift', 'Onboarding/OnboardingService.swift', 'Onboarding/LoginAppearance.swift', 'Onboarding/LoginDitherView.swift', 'Onboarding/OnboardingController.swift', 'Onboarding/PasswordResetController.swift'],
    'session-permission': ['Sessions/PermissionProjection.swift', 'Sessions/SessionPermission.swift', 'Sessions/SessionEnvelope.swift'],
    'session-decisions': ['LodyLocalization.swift', 'Sessions/SessionEnvelope.swift', 'Sessions/SessionPermission.swift', 'Sessions/SessionDecisions.swift'],
    'outbox': ['LodyLocalization.swift', 'Sessions/SessionCatalog.swift', 'Sessions/SessionSender.swift', 'Outbox/OutboxRecord.swift', 'Outbox/OutboxStore.swift', 'Outbox/OutboxDispatcher.swift', 'Outbox/OutboxForeground.swift', 'Sessions/SessionEnvelope.swift', 'Sessions/SessionPermission.swift'],
    'chat-execution': ['LodyLocalization.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatMessageShare.swift', 'Chat/ChatStream.swift', 'Chat/ChatHaptics.swift', 'Chat/ChatImagePreviewGeometry.swift', 'Chat/ChatImageGallery.swift'],
    'chat': ['LodyLocalization.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatMessageShare.swift', 'Chat/ChatStream.swift', 'Chat/ChatHaptics.swift', 'Chat/ChatImagePreviewGeometry.swift', 'Chat/ChatImageGallery.swift'],
    'chat-opening': ['LodyLocalization.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatMessageShare.swift', 'Chat/ChatStream.swift', 'Chat/ChatHaptics.swift', 'Chat/ChatImagePreviewGeometry.swift', 'Chat/ChatImageGallery.swift'],
    'chat-delivery': ['LodyLocalization.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatMessageShare.swift', 'Chat/ChatStream.swift', 'Chat/ChatHaptics.swift', 'Chat/ChatImagePreviewGeometry.swift', 'Chat/ChatImageGallery.swift'],
    'chat-tools': ['LodyLocalization.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatMessageShare.swift', 'Chat/ChatStream.swift', 'Chat/ChatHaptics.swift', 'Chat/ChatImagePreviewGeometry.swift', 'Chat/ChatImageGallery.swift'],
    'markdown-repair': ['Chat/ChatMarkdownRepair.swift'],
    'watchdog': [],
    'local-store': ['Cloud/LocalStore.swift', 'Cloud/SessionProse.swift', 'Text/MarkdownPlainText.swift', 'Text/MarkdownRuby.swift', 'Text/TextSearch.swift', 'LodyLocalization.swift'],
    'content-store': ['Cloud/ContentStore.swift'],
    'chat-render': ['List/LodyListPhoto.swift', 'List/PhotoDiskCache.swift', 'LodyLocalization.swift', 'LodyTint.swift', 'UIFont+Dynamic.swift', 'Appearance/LodyDesign.swift', 'List/LodyStatusGlyph.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatThrowCurve.swift', 'Chat/ChatAttachments.swift', 'Chat/ChatSendHandoff.swift', 'Chat/ChatNumericText.swift', 'Chat/ChatCell.swift', 'Chat/ChatAuthorHeader.swift', 'Chat/ChatUserMentions.swift'],
    'chat-subagent': ['LodyLocalization.swift', 'LodyTint.swift', 'UIFont+Dynamic.swift', 'Appearance/LodyDesign.swift', 'List/LodyStatusGlyph.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatThrowCurve.swift', 'Chat/ChatAttachments.swift', 'Chat/ChatSendHandoff.swift', 'Chat/ChatNumericText.swift', 'Chat/ChatCell.swift', 'Chat/ChatUserMentions.swift', 'Chat/ChatSubagentCell.swift'],
    'chat-files': ['LodyLocalization.swift', 'LodyTint.swift', 'UIFont+Dynamic.swift', 'Appearance/LodyDesign.swift', 'List/LodyStatusGlyph.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatThrowCurve.swift', 'Chat/ChatAttachments.swift', 'Chat/ChatSendHandoff.swift', 'Chat/ChatNumericText.swift', 'Chat/ChatCell.swift', 'Chat/ChatUserMentions.swift', 'Chat/ChatFileCell.swift', 'List/LodyListPhoto.swift', 'List/PhotoDiskCache.swift'],
    'chat-chrome': ['LodyLocalization.swift', 'Chat/ChatOverlay.swift'],
    'model-panel': ['LodyLocalization.swift', 'LodyTint.swift', 'UIFont+Dynamic.swift', 'Chat/ChatComposerModelPanel.swift'],
    'composer': ['Chrome/LodyScrollEdges.swift', 'Chrome/LodyEdgeFade.swift', 'LodyLocalization.swift', 'UIFont+Dynamic.swift', 'Chat/ChatAttachments.swift', 'Chat/ChatRecentPhotosView.swift', 'Chat/ChatAttachmentMenu.swift', 'Chat/ChatCameraCapture.swift', 'Chat/ChatAttachmentOverlayCameraView.swift', 'Chat/ChatCameraPage.swift', 'Chat/ChatComposerSurfaceLayout.swift', 'Chat/ChatComposerLiquidGlassSurfaceLayout.swift', 'Chat/ChatComposerAttachmentStack.swift', 'Chat/ChatComposerGrabber.swift', 'Chat/ChatMentionPanel.swift', 'Chat/ChatComposerModelPanel.swift', 'Chat/ChatComposerView.swift', 'Chat/ChatSessionUsage.swift', 'Chat/ChatUsagePanel.swift', 'Chat/ChatReferenceNode.swift', 'Chat/LodyAgentIcon.swift', 'Chat/ChatTranscript.swift', 'Chat/ChatSendHandoff.swift', 'Chat/ChatNumericText.swift', 'Chat/ChatThrowCurve.swift', 'LodyTint.swift', 'Toast/LodyToastOverlay.swift', 'Toast/LodyToastPillView.swift', 'Toast/LodySessionBannerView.swift'],
    'attachments': ['LodyLocalization.swift', 'Diagnostics/DiagnosticsStore.swift', 'Cloud/SessionAttachments.swift'],
    'inline-diff': ['UIFont+Dynamic.swift', 'Diff/InlineDiffModel.swift', 'Diff/InlineDiffRenderer.swift', 'Diff/DiffDocumentModel.swift', 'Diff/DiffDocumentLayout.swift'],
    'list': [
        'Chrome/LodyMenuButtonStyle.swift',
        'Chrome/LodyMenuButton.swift',
        'LodyTint.swift',
        'List/LodyRowDensity.swift',
        'List/LodyListCellBackground.swift',
        'List/LodyListPhoto.swift', 'List/PhotoDiskCache.swift',
        'List/LodyListSectionAnimation.swift',
        'List/LodyUnreadNavigationHold.swift',
        'List/LodySessionRowView.swift',
        'List/LodyProjectRowView.swift',
        'Appearance/LodyDesign.swift',
        'List/LodyStatusGlyph.swift',
        'List/LodyFlatRows.swift',
        'Text/TextSearch.swift',
    ],
    'list-snapshots': ['List/LodyListModels.swift'],
    'chat-list-scroll': ['Sessions/ChatListCollectionView.swift'],
    'banner': [
        'LodyLocalization.swift',
        'Toast/LodySessionBannerView.swift',
    ],
    'chat-title': ['LodyLocalization.swift', 'LodyUIVerify.swift', 'LodyTint.swift', 'Chrome/LodyNavigationHeader.swift', 'Chrome/LodyNavigationSearch.swift', 'Chat/ChatNavigationTitle.swift'],
    'page-progress': ['List/LodyPageProgress.swift'],
    'create-session': ['LodyLocalization.swift', 'CreateSession/CreateSessionForm.swift'],
    'session-info-bar': ['LodyLocalization.swift', 'Sessions/SessionCatalog.swift', 'Sessions/SessionInfoBar.swift'],
    'session-roles': ['LodyLocalization.swift', 'CreateSession/CreateSessionForm.swift', 'Sessions/SessionRoles.swift'],
    'unified-patch': ['Diff/UnifiedPatch.swift'],
    'create-draft': ['LodyLocalization.swift', 'CreateSession/CreateSessionForm.swift', 'Outbox/OutboxRecord.swift', 'CreateSession/CreateDraftRecord.swift'],
    'share-ingest': ['LodyLocalization.swift', 'Chat/ChatAttachments.swift', 'CreateSession/CreateSessionForm.swift', 'CreateSession/ShareStore.swift', str(root / 'apps/ios/Extensions/Share/ShareIngest.swift')],
    'share': ['LodyLocalization.swift', 'CreateSession/CreateSessionForm.swift', 'CreateSession/ShareStore.swift'],
    'design': ['LodyTint.swift'],
    'form': ['LodyTint.swift', 'UIFont+Dynamic.swift', 'Chrome/LodyScrollEdges.swift', 'Chrome/LodyEdgeFade.swift', 'Settings/LodyForm.swift'],
}
if args.case:
    if args.case not in checks:
        parser.error(f'Unknown check {args.case}; choose from {", ".join(checks)}')
    checks = {args.case: checks[args.case]}
for files in checks.values():
    if files and 'LodyLocalization.swift' not in files:
        files.append('LodyLocalization.swift')
    if 'LodyTint.swift' in files and 'Appearance/LodyDesign.swift' not in files:
        files.append('Appearance/LodyDesign.swift')
    if 'Chat/ChatComposerView.swift' in files:
        files.append('Chat/ChatActionBar.swift')
        files.extend(['Projects/RepositoryIcon.swift', 'List/LodyListPhoto.swift', 'List/PhotoDiskCache.swift'])
        files.append('Chat/ChatComposerFormatBar.swift')
        files.append('Chat/ChatShortcutInsertion.swift')
    if 'Chat/ChatTranscript.swift' in files:
        files.append('Chat/ChatPendingSend.swift')
        files.append('Chat/ChatTurnMetadata.swift')
    if 'Chat/ChatSendHandoff.swift' in files or 'Chat/ChatMentionPanel.swift' in files:
        files.insert(0, 'LodyUIVerify.swift')
    if 'Cloud/BackendEnvironment.swift' not in files:
        files.append('Cloud/BackendEnvironment.swift')
if 'markdown-repair' in checks:
    subprocess.run(['node', str(root / 'apps/ios/scripts/build-decoder.mjs')], cwd=root, check=True, timeout=120)
with tempfile.TemporaryDirectory(prefix='lody-native-verify-') as output:
    shader_bundle = Path(output) / 'LodyKitShaders.bundle'
    shader_bundle.mkdir()
    air = str(Path(output) / 'ChatEffortHeat.air')
    subprocess.run(['xcrun', '--sdk', 'iphonesimulator', 'metal', '-c', '-target', 'air64-apple-ios26.0-simulator', '-isysroot', sdk, str(kit / 'Sources/LodyKit/Chat/Shaders/ChatEffortHeat.metal'), '-o', air], check=True, timeout=120)
    subprocess.run(['xcrun', '--sdk', 'iphonesimulator', 'metallib', air, '-o', str(shader_bundle / 'default.metallib')], check=True, timeout=120)
    # Build the extracted modules from their production sources. Core remains
    # host-testable; UIKit checks link the same package module as the app.
    module_dirs = {}
    def chat_modules(simulator):
        if simulator in module_dirs:
            return module_dirs[simulator]
        directory = Path(output) / ('chat-package-ios' if simulator else 'chat-package-host')
        directory.mkdir()
        module_dirs[simulator] = directory
        command = ['xcrun', 'swiftc', '-swift-version', '6']
        if simulator:
            arch = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
            command += ['-sdk', sdk, '-target', f'{arch}-apple-ios26.0-simulator']
        modules = ['ChatKitCore', 'ChatKit'] if simulator else ['ChatKitCore']
        for module in modules:
            sources = sorted((root / 'packages/chat-kit/Sources' / module).glob('*.swift'))
            subprocess.run(command + ['-I', str(directory), '-emit-module', '-emit-library', '-static',
                '-module-name', module, '-emit-module-path', str(directory / f'{module}.swiftmodule'),
                *map(str, sources), '-o', str(directory / f'lib{module}.a')], check=True, timeout=240)
        return directory

    lexical_dir = Path(output) / 'lexical-package'
    lexical_modules = [('Lexical', '5'), ('LexicalListPlugin', '5'), ('LexicalLinkPlugin', '5'), ('LexicalMarkdown', '6'), ('EditorHistoryPlugin', '5'), ('LexicalHTML', '6')]

    def lexical_package():
        if lexical_dir.exists():
            return lexical_dir
        lexical_dir.mkdir()
        arch = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
        for module, version in lexical_modules:
            sources = sorted((root / 'packages/lexical-swift/Sources' / module).rglob('*.swift'))
            subprocess.run(['xcrun', 'swiftc', '-swift-version', version, '-sdk', sdk, '-target', f'{arch}-apple-ios26.0-simulator',
                '-I', str(lexical_dir), '-emit-module', '-emit-library', '-static', '-module-name', module,
                '-emit-module-path', str(lexical_dir / f'{module}.swiftmodule'), *map(str, sources),
                '-o', str(lexical_dir / f'lib{module}.a')], check=True, timeout=600)
        return lexical_dir

    for name, files in checks.items():
        if name == 'lexical-swift':
            subprocess.run(['xcodebuild', 'test', '-scheme', 'Lexical-Package', '-destination', f'id={args.udid}',
                '-derivedDataPath', str(root / '.artifacts/native-lexical-swift'), '-collect-test-diagnostics', 'never'],
                cwd=root / 'packages/lexical-swift', check=True, timeout=1800)
            continue
        if name == 'local-store':
            # Compile the production parser, not a regex or a test-only stand-in.
            package = Path(output) / name
            sources = package / 'Sources'
            sources.mkdir(parents=True)
            for file in files:
                (sources / Path(file).name).symlink_to(kit / 'Sources/LodyKit' / file)
            (sources / 'Resources').symlink_to(kit / 'Sources/LodyKit/Resources', target_is_directory=True)
            (sources / 'main.swift').symlink_to(checks_root / name / 'main.swift')
            (package / 'Package.swift').symlink_to(checks_root / name / 'Package.swift')
            subprocess.run(['swift', 'run', '--package-path', str(package), '--scratch-path', str(root / '.artifacts/native-local-store')], check=True, timeout=600)
            continue
        binary = str(Path(output) / name)
        simulator = name in ['auth-session', 'fold-host', 'message-details', 'simulator-transport', 'share-ingest', 'chat-kit', 'scroll-edges', 'glass-transition', 'model-panel', 'chat-render', 'composer', 'attachments', 'inline-diff', 'list', 'list-snapshots', 'chat-list-scroll', 'ai-usage', 'workspace-settings-pages', 'settings-roles', 'settings-runtime-pages', 'remote-settings', 'session-rows', 'banner', 'chat-title', 'chat-chrome', 'design', 'form', 'chat-subagent', 'chat-files', 'file-link']
        command = ['xcrun', '--sdk', 'iphonesimulator', 'swiftc'] if simulator else ['xcrun', 'swiftc']
        command += ['-swift-version', '6']
        if name in ['message-details', 'list-snapshots', 'ai-usage', 'workspace-settings-pages', 'settings-roles', 'settings-runtime-pages', 'remote-settings', 'session-rows']:
            command += ['-D', 'LODY_SHARE_EXTENSION']
        if name == 'simulator-transport':
            subprocess.run(['/bin/bash', str(kit / 'DataChannel/build.sh')], check=True)
            command += ['-F', str(kit / 'Vendor/LodyDataChannel.xcframework/ios-arm64_x86_64-simulator'),
                        '-framework', 'LodyDataChannel']
        if simulator:
            arch = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
            ios = '26.0'
            command += ['-sdk', sdk, '-target', f'{arch}-apple-ios{ios}-simulator']
        if name == 'composer':
            manifest = subprocess.check_output([
                'node', '-p', 'require.resolve("@rien7/anchored-overlay-kit/package.json")',
            ], cwd=root / 'apps/ios', text=True).strip()
            sources = sorted((Path(manifest).parent / 'Sources/AnchoredOverlayKit').glob('*.swift'))
            subprocess.run([
                *command, '-emit-library', '-static', '-emit-module',
                '-module-name', 'AnchoredOverlayKit',
                '-emit-module-path', str(Path(output) / 'AnchoredOverlayKit.swiftmodule'),
                *map(str, sources), '-o', str(Path(output) / 'libAnchoredOverlayKit.a'),
            ], check=True, timeout=120)
            command += ['-I', output, '-L', output, '-lAnchoredOverlayKit']
        if name in ['auth-session', 'session-feed', 'session-simulator', 'preview-feedback', 'pull-request', 'item-details', 'attachments', 'auth', 'outbox', 'github-mentions', 'github-pr', 'session-sharing', 'settings', 'file-link']:
            command += ['-parse-as-library']
        if name == 'inline-diff':
            command += ['-framework', 'UIKit']
        if name in ['chat-render', 'composer', 'chat-title', 'chat-subagent', 'chat-files']:
            command += ['-framework', 'SwiftUI']
        main = checks_root / name / 'main.swift'
        package_sources = [kit / 'Sources/LodyKit' / file for file in files] + [main]
        if any('import LodyDesignSystem' in source.read_text() for source in package_sources):
            directory = Path(output) / 'design-system-ios'
            if not directory.exists():
                directory.mkdir(exist_ok=True)
                design = root / 'packages/LodyAppearance/Sources/LodyDesignSystem'
                resources = directory / 'LodyAppearance_LodyDesignSystem.bundle'
                resources.mkdir()
                subprocess.run(['xcrun', 'actool', str(design / 'Resources/LodyIcons.xcassets'),
                    '--compile', str(resources), '--platform', 'iphonesimulator',
                    '--minimum-deployment-target', '26.0', '--target-device', 'iphone',
                    '--target-device', 'ipad'], check=True, timeout=120)
                # SwiftPM normally generates this accessor; these checks compile directly.
                accessor = directory / 'resource_bundle_accessor.swift'
                accessor.write_text('import Foundation\nextension Bundle { static let module = Bundle(path: '
                                    + '"' + str(resources) + '")! }\n')
                subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-sdk', sdk,
                    '-target', f'{arch}-apple-ios26.0-simulator', '-emit-module', '-emit-library', '-static',
                    '-module-name', 'LodyDesignSystem', '-emit-module-path', str(directory / 'LodyDesignSystem.swiftmodule'),
                    *map(str, sorted(design.glob('*.swift'))), str(accessor),
                    '-o', str(directory / 'libLodyDesignSystem.a')], check=True, timeout=240)
            command += ['-I', str(directory), '-L', str(directory), '-lLodyDesignSystem']
        if any('import LodyCore' in source.read_text() for source in package_sources):
            directory = Path(output) / ('lody-core-ios' if simulator else 'lody-core-host')
            if not directory.exists():
                directory.mkdir()
                sources = sorted((root / 'packages/lody-core/Sources/LodyCore').rglob('*.swift'))
                compile_core = ['xcrun', 'swiftc', '-swift-version', '6']
                if simulator:
                    compile_core += ['-sdk', sdk, '-target', f'{arch}-apple-ios26.0-simulator']
                subprocess.run(compile_core + ['-emit-module', '-emit-library', '-static', '-module-name', 'LodyCore',
                    '-emit-module-path', str(directory / 'LodyCore.swiftmodule'), *map(str, sources),
                    '-o', str(directory / 'libLodyCore.a')], check=True, timeout=120)
            command += ['-I', str(directory), '-L', str(directory), '-lLodyCore']
        if any('import ChatKit' in source.read_text() for source in package_sources):
            modules = chat_modules(simulator)
            command += ['-I', str(modules), '-L', str(modules), '-lChatKitCore']
            if simulator:
                command += ['-lChatKit']
        if any('import Lexical' in source.read_text() for source in package_sources):
            modules = lexical_package()
            command += ['-I', str(modules), '-L', str(modules)] + [f'-l{module}' for module, _ in lexical_modules]
        command += [str(kit / 'Sources/LodyKit' / file) for file in files]
        command += [str(main), '-o', binary]
        # Xcode 27 CI compiles the larger chat/composer graphs much slower than a local Mac.
        subprocess.run(command, check=True, timeout=240)
        # A cold CI Simulator draws its first text far slower than a warm local one.
        command = ['xcrun', 'simctl', 'spawn', args.udid, binary] if simulator else [binary]
        if name == 'simulator-transport':
            subprocess.run(['codesign', '--force', '--sign', '-', binary], check=True)
            with subprocess.Popen(['node', str(checks_root / 'simulator-transport/server.mjs')], stdout=subprocess.PIPE, text=True) as server:
                try:
                    endpoint = server.stdout.readline().strip()
                    if not endpoint.startswith('http://127.0.0.1:'):
                        raise RuntimeError('Simulator transport fixture server did not start')
                    subprocess.run(command, check=True, timeout=90, env={**os.environ, 'SIMCTL_CHILD_LODY_SIMULATOR_TEST_URL': endpoint,
                                                                       'SIMCTL_CHILD_OS_ACTIVITY_DT_MODE': 'enable'})
                finally:
                    server.terminate()
        elif name == 'auth':
            subprocess.run(command, check=True, timeout=60)
            # Exercise the real build-owned Bundle configuration, not a policy stub.
            import plistlib
            import shutil
            contents = Path(output) / 'LocalReset.app/Contents'
            (contents / 'MacOS').mkdir(parents=True)
            executable = contents / 'MacOS/auth'
            shutil.copy2(binary, executable)
            (contents / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleExecutable': 'auth', 'CFBundleIdentifier': 'ai.lody.verify.local-reset',
                'LodyBackends': {'CONVEX_SITE_URL': 'https://local.example.test'},
            }))
            subprocess.run([str(executable)], check=True, timeout=60)
        elif name == 'strings':
            resources = Path(output) / 'Localization.bundle'
            resources.mkdir()
            subprocess.run(['xcrun', 'xcstringstool', 'compile', str(kit / 'Sources/LodyKit/Resources/Localizable.xcstrings'),
                            '--output-directory', str(resources)], check=True)
            subprocess.run([*command, str(resources)], check=True, timeout=60)
        elif name == 'attachments':
            command += ['--ui-verify']
            with subprocess.Popen([sys.executable, str(checks_root / 'attachments/progress-server.py')], stdout=subprocess.PIPE, text=True) as server:
                try:
                    endpoint = server.stdout.readline().strip()
                    subprocess.run(command, check=True, timeout=300, env={**os.environ, 'SIMCTL_CHILD_LODY_UPLOAD_TEST_URL': endpoint})
                finally:
                    server.terminate()
        else:
            subprocess.run(command, check=True, timeout=300)
