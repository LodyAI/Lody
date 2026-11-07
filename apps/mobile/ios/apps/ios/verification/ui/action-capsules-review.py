"""Capture the production iOS action bar with isolated offline session states.
Run after launching Lody with --ui-verify. AXe must be on PATH.
"""
import json
from pathlib import Path
import subprocess
import sys
import time
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])
cases = [
 ('01', 'empty', '无机器、项目与任务'),
 ('02', 'clean', '机器在线 · 分支无改动'),
 ('03', 'offline', '机器离线'),
 ('04', 'unknown', '机器在线状态未知'),
 ('05', 'windows', 'Windows 机器'),
 ('06', 'linux', 'Linux 机器'),
 ('07', 'repo', '只有仓库，无分支'),
 ('08', 'local', '本地项目 · 变更统计'),
 ('09', 'diff-only', '只有变更统计'),
 ('10', 'changes', '分支有改动 · 创建 PR'),
 ('11', 'dirty', '未提交改动 · 创建 PR / 提交并推送'),
 ('12', 'long', '长分支名 · 空间压缩'),
 ('13', 'running', '执行中 · 隐藏仓库操作'),
 ('14', 'draft', '草稿 PR · 可供审核'),
 ('15', 'draft-dirty', '草稿 PR · 未提交改动优先'),
 ('16', 'open', '开放 PR · 合并状态未知'),
 ('17', 'ci-pending', 'CI 运行中'),
 ('18', 'ci-failed', 'CI 失败 · 修复 CI'),
 ('19', 'ci-error', 'CI 错误 · 修复 CI'),
 ('20', 'conflict', '合并冲突 · 解决冲突'),
 ('21', 'conflict-ci', '冲突和 CI 失败同时存在'),
 ('22', 'merge', 'CI 通过 · 可合并'),
 ('23', 'unpushed', '未推送提交 · 提交并推送优先'),
 ('24', 'merged', 'PR 已合并'),
 ('25', 'closed', 'PR 已关闭'),
 ('26', 'ready-pending', '标记可供审核 · 处理中'),
 ('27', 'merge-pending', '合并 PR · 处理中'),
 ('28', 'browser', '浏览器预览可用'),
 ('29', 'browser-busy', '浏览器预览连接中'),
 ('30', 'simulator', 'iOS 模拟器入口'),
 ('31', 'simulator-busy', 'iOS 模拟器连接中'),
 ('32', 'tasks', '三个正在执行的子任务'),
 ('33', 'crowded', '机器 / 浏览器 / 模拟器 / 任务拥挤折叠'),
]

def open_case(name):
    subprocess.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', ui.udid,
                    'ai.lody.mobile', '--ui-verify', '--ui-review-bar=' + name,
                    '-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], check=True, capture_output=True)
    ui.invalidate_axe()
    time.sleep(1)
    ui.element('session-input')
    ui.wait(lambda xs: any('live' in str(i.get('AXValue')) for i in xs if i.get('AXUniqueId') == 'session-preview-probe'), 'Waiting for fixture')

def capture(number, name, title):
    path = number + '-' + name
    ui.capture(path)
    print(path + ': ' + title, flush=True)
    return {'id':number, 'name':name, 'title':title, 'file':path + '.png'}

if __name__ == '__main__':
    result = []
    for number, name, title in cases:
        open_case(name)
        result.append(capture(number, name, title))
    (ui.output / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
