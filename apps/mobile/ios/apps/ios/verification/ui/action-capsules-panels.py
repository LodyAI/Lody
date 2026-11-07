"""Capture native menus and panels opened from action-capsules-review fixtures."""
import json
import runpy
import sys
import time
from pathlib import Path

helpers = runpy.run_path(str(Path(__file__).with_name('action-capsules-review.py')), run_name='review')
ui, open_case, capture = [helpers[k] for k in ('ui', 'open_case', 'capture')]
result = []

def tap(identifier):
    ui.axe('tap', '--id', identifier, '--post-delay', '.7')

def hold(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width']/2), '-y', str(frame['y'] + frame['height']/2), '--down', '--up', '--delay', '.9')
    time.sleep(.5)

def take(number, case, title, action):
    open_case(case)
    action()
    time.sleep(.7)
    result.append(capture(number, case + '-panel', title))
    (ui.output / 'panels.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))

def changes():
    tap('session-bar:context')
    items = ui.state()
    entry = next(i for i in items if i.get('type') == 'Button' and (i.get('AXLabel') or '').startswith('变更'))
    f = entry['frame']
    ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--post-delay', '1.2')

def open_pr():
    tap('session-bar:context')
    entry = next(i for i in ui.state() if 'loro-dev/lody #128' in (i.get('AXLabel') or '') and i.get('type') == 'Button')
    f = entry['frame']
    ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--post-delay', '.7')

take('P01','clean','点击机器 · 在线',lambda: tap('session-bar:machine'))
take('P02','offline','点击机器 · 离线',lambda: tap('session-bar:machine'))
take('P03','unknown','点击机器 · 未知',lambda: tap('session-bar:machine'))
take('P04','clean','点击分支 · 复制分支',lambda: tap('session-bar:context'))
take('P05','changes','点击分支和变更 · 上下文菜单',lambda: tap('session-bar:context'))
take('P06','dirty','创建 PR 的更多操作',lambda: tap('session-bar:more'))
take('P07','draft-dirty','未提交的草稿 PR · 更多操作',lambda: tap('session-bar:more'))
take('P08','conflict-ci','冲突和 CI 失败 · 更多操作',lambda: tap('session-bar:more'))
take('P09','unpushed','未推送提交 · 更多操作',lambda: tap('session-bar:more'))
take('P10','merge','点击合并 · 合并方式确认面板',lambda: tap('session-bar:act'))
take('P11','open','长按 PR · 上下文菜单',lambda: hold('session-bar:context'))
take('P12','open','点击 PR · 原生 PR 详情',open_pr)
take('P13','local','点击变更 · 工作区文件列表',changes)
take('P14','browser','长按浏览器 · 复制链接 / 停止预览',lambda: hold('session-preview'))
take('P15','browser','浏览器预览 · 当前模拟器打开后空白',lambda: tap('session-preview'))
take('P16','simulator','长按模拟器 · 停止预览',lambda: hold('session-preview'))
take('P17','simulator','点击模拟器 · 原生预览',lambda: tap('session-preview'))
take('P18','tasks','子任务仅在对话中显示',lambda: None)
take('P19','crowded','点击折叠的资源胶囊',lambda: tap('session-bar:environment'))
take('P20','draft','点击草稿 PR · 详情',open_pr)
take('P21','merged','点击已合并 PR · 详情',open_pr)
take('P22','closed','点击已关闭 PR · 详情',open_pr)

open_case('open')
open_pr()
ui.element('pr-checks')
ui.axe('drag', '--start-x', '201', '--start-y', '394', '--end-x', '201', '--end-y', '100', '--duration', '.7', '--post-delay', '.7')
result.append(capture('P23', 'pr-expanded', 'PR 详情展开'))
tap('pr-checks')
ui.element('pr-check-1')
result.append(capture('P24', 'pr-ci-list', 'PR 检查列表'))
tap('pr-check-1')
ui.element('pr-check-detail')
result.append(capture('P25', 'pr-ci-detail', '单项 CI 详情'))
open_case('clean')
tap('session-input')
result.append(capture('P26', 'editing', '编辑输入框时 · 胶囊隐藏'))
(ui.output / 'panels.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
