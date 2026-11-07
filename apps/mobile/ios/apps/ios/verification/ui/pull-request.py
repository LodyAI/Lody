"""Offline PR layout and native navigation; never posts to GitHub."""
import json
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])

def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.6')

def back():
    ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '365', '--end-y', '450', '--duration', '.5', '--post-delay', '1')

ui.capture('session-entry')
ui.axe('tap', '--label', 'PR #31，1 项检查失败', '--post-delay', '1')
ui.element('pr-title')
summary = ui.element('pr-checks')
assert catalog.text('pr.failedCount', count=1) in str(summary)
def button(key):
    return ui.wait(lambda items: next((item for item in items if item.get('type') == 'Button' and item.get('AXLabel') == catalog.text(key)), None), f'Missing {key}')

left = button('pr.github')['frame']
right = button('pr.comment')['frame']
assert left['x'] + left['width'] <= right['x'], 'Bottom actions overlap'
assert left['y'] > summary['frame']['y'], 'GitHub action must be in bottom toolbar'
assert abs(left['y'] - right['y']) < 12, 'Bottom actions must share a baseline'
assert 43.99 <= left['width'] <= 64 and left['height'] >= 43.99, 'GitHub must be an accessible icon-only button'
files = ui.element('pr-files')
assert '4 · +229 −16' in str(files), 'Changed-file totals must remain available to VoiceOver'
ui.capture('pull-request')
ui.axe('tap', '--label', catalog.text('pr.github'), '--element-type', 'Button', '--post-delay', '.4')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('pr.previewAction') for item in items), 'GitHub icon must invoke the existing open action')
ui.capture('github-action')
ui.axe('tap', '--label', catalog.text('common.ok'), '--post-delay', '.4')
tap('pr-checks')
failed = ui.element('pr-check-1')
running = ui.element('pr-check-4')
assert failed['frame']['y'] < running['frame']['y'], 'Failed checks should precede running checks'
assert catalog.text('pr.check.failure') in str(failed)
assert catalog.text('pr.check.in_progress') in str(running)
ui.element('pr-check-5')
ui.capture('checks')
tap('pr-check-1')
ui.element('pr-check-detail')
ui.element('pr-check-limit')
ui.capture('failed-check')
back()
ui.element('pr-check-1')
back()
ui.element('pr-title')
button('pr.comment')
ui.axe('tap', '--label', catalog.text('pr.comment'), '--post-delay', '.5')
ui.element('pr-comment-input')
ui.capture('comment-editor')
ui.axe('type', '12345')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'pr-comment-input' and item.get('AXValue') == '12345' for item in items), 'Comment input did not retain typed text')
ui.axe('tap', '--label', catalog.text('pr.send'), '--post-delay', '.5')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('pr.previewAction') for item in items), 'Preview must disclose that posting is not connected')
ui.axe('tap', '--label', catalog.text('common.ok'), '--post-delay', '.5')
assert ui.element('pr-comment-input').get('AXValue') == '12345'
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
ui.axe('tap', '--label', catalog.text('pr.discard'), '--element-type', 'Button', '--post-delay', '.6')
ui.element('pr-title')
back()
ui.element('session-input')
ui.capture('returned-session')

def scenario(label):
    ui.axe('tap', '--label', '更多', '--post-delay', '.4')
    ui.axe('tap', '--label', label, '--post-delay', '.6')

for state in ('merged', 'closed', 'draft'):
    scenario(catalog.text('pr.state.' + state))
    assert catalog.text('pr.state.' + state) in str(ui.element('pr-title'))
    ui.capture('pull-request-' + state)
    back()
    ui.element('session-input')

scenario('授权失败预览')
retry = ui.element('pr-retry')
assert catalog.text('pr.error.authorization') in str(retry)
ui.capture('authorization-error')
tap('pr-retry')
ui.element('pr-title')
back()
ui.element('session-input')
scenario('空检查预览')
assert catalog.text('pr.summary.empty') in str(ui.element('pr-checks'))
tap('pr-checks')
assert catalog.text('pr.summary.empty') in str(ui.element('pr-checks-notice'))
ui.capture('empty-checks')
back()
ui.element('pr-title')
back()
ui.element('session-input')
scenario('评论发送预览')
ui.element('pr-title')
button('pr.comment')
ui.axe('tap', '--label', catalog.text('pr.comment'), '--post-delay', '.5')
ui.element('pr-comment-input')
ui.axe('type', '67890')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'pr-comment-input' and item.get('AXValue') == '67890' for item in items), 'Comment was not entered')
ui.axe('tap', '--label', catalog.text('pr.send'), '--post-delay', '.5')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('pr.error.forbidden') for item in items), 'Failed comment must remain actionable')
ui.capture('comment-failed')
ui.axe('tap', '--label', catalog.text('common.ok'), '--post-delay', '.4')
assert ui.element('pr-comment-input').get('AXValue') == '67890'
ui.axe('tap', '--label', catalog.text('pr.send'), '--post-delay', '.5')
ui.element('pr-title')
# The refreshed comment may be below the fold, so scroll the native list.
ui.axe('drag', '--start-x', '210', '--start-y', '650', '--end-x', '210', '--end-y', '280', '--duration', '.4', '--post-delay', '.5')
assert '67890' in str(ui.element('pr-comment-1'))
ui.capture('comment-posted')
back()
ui.element('session-input')
ui.axe('tap', '--id', 'session-input', '--post-delay', '.4')
ui.axe('type', '2468')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'session-input' and item.get('AXValue') == '2468' for item in items), 'Session draft was not entered')
ui.axe('tap', '--label', 'PR #31，1 项检查失败', '--post-delay', '.6')
ui.element('pr-title')
tap('pr-checks')
ui.element('pr-check-1')
ui.axe('tap', '--label', catalog.text('pr.investigate'), '--post-delay', '.4')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('pr.draftAdded') for item in items), 'Investigation must explain draft handoff')
ui.axe('tap', '--label', catalog.text('common.ok'), '--post-delay', '.4')
back()
ui.element('pr-title')
back()
assert ui.element('session-input').get('AXValue') == '2468\n\nInvestigate PR #31', 'Investigation must preserve existing draft'
ui.capture('investigation-draft')
print(json.dumps({'nativeReturn': True, 'offlineActionsDisclosed': True, 'authorizationRetry': True, 'emptyChecks': True, 'commentFailureRetainsDraft': True, 'commentSuccessRefreshes': True, 'investigationPreservesDraft': True}))
