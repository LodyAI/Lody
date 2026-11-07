"""The tall iPad layout keeps the session list hidden until it is shown."""
import json
import subprocess
import time
import catalog


def list_visible(items):
    return any(
        item.get('AXUniqueId') == 'ipad-inbox-list' and item['frame']['x'] + item['frame']['width'] > 1
        for item in items
    )


def show_list(ui):
    show = catalog.system('showSidebar')
    items = ui.wait(
        lambda items: items if list_visible(items) or any(item.get('AXLabel') == show for item in items) else None,
        'Neither the session list nor its Show Sidebar button appeared',
    )
    if list_visible(items):
        return
    frame = next(item for item in items if item.get('AXLabel') == show)['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2),
           '--tap-style', 'physical', '--post-delay', '.8')
    ui.wait(lambda items: list_visible(items) or None, 'The session list did not appear')


def panel_chrome(ui):
    panel = ui.element('ipad-panel')['frame']

    def find(match, message):
        return ui.wait(lambda items: next((item for item in items if match(item)), None), message)

    chrome = {
        'panel': panel,
        'workspace': find(lambda i: (i.get('AXLabel') or '').startswith('Switch workspace,'), 'Missing workspace switch'),
        'view': find(lambda i: i.get('AXLabel') == catalog.text('inbox.settings.section.view'), 'Missing view menu'),
        'settings': find(lambda i: i.get('AXLabel') == catalog.text('tabs.settings'), 'Missing settings'),
        'search': find(lambda i: i.get('subrole') == 'AXSearchField' or i.get('AXUniqueId') == 'sidebar-search', 'Missing sidebar search'),
        'create': find(lambda i: i.get('AXLabel') == catalog.text('tabs.newSession'), 'Missing new session'),
    }
    bottom = panel['y'] + panel['height']
    workspace, view, settings = (chrome[name]['frame'] for name in ('workspace', 'view', 'settings'))
    search, create = chrome['search']['frame'], chrome['create']['frame']
    middle = workspace['y'] + workspace['height'] / 2
    assert workspace['x'] < panel['x'] + 40 and workspace['y'] < panel['y'] + 90, (workspace, panel)
    for action in (view, settings):
        assert abs(action['y'] + action['height'] / 2 - middle) < 10, ('Filter and settings share the header row', action, workspace)
    assert workspace['x'] + workspace['width'] <= view['x'] < settings['x'], (workspace, view, settings)
    assert settings['x'] + settings['width'] <= panel['x'] + panel['width'] + .5, (settings, panel)
    for item in (search, create):
        assert item['y'] > bottom - 110, ('Search and New Session sit at the bottom', item, panel)
    assert search['x'] < panel['x'] + 40 and search['width'] > panel['width'] / 2, ('Search fills the bottom row', search, panel)
    assert search['x'] + search['width'] < create['x'] and create['x'] > panel['x'] + panel['width'] - 100, (search, create, panel)
    assert create['x'] - (search['x'] + search['width']) <= 30, ('Search and New Session keep the system toolbar gap', search, create)
    assert create['x'] + create['width'] <= panel['x'] + panel['width'], ('New Session stays inside the sidebar', create, panel)
    assert not any(i.get('AXLabel') == catalog.system('hideSidebar') and settings['x'] - 10 < i['frame']['x'] < panel['x'] + panel['width']
                   and i['frame']['y'] < panel['y'] + 90 for i in ui.state()), 'The sidebar header carries no system toggle beside settings'
    assert workspace['width'] >= 44 and workspace['height'] >= 44
    assert create['width'] >= 36 and create['height'] >= 36
    return chrome



def record_tap(ui, label, name, screen, band, settle=1.2):
    frame = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label), None), f'Missing {label}')['frame']
    ui.screenshot(f'{name}-before')
    started = time.time()
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2),
           '--tap-style', 'physical', '--post-delay', str(settle))
    seconds = time.time() - started
    ui.screenshot(f'{name}-after')
    # The run recording owns the Simulator's only recorder; run.py checks these windows once it stops.
    motion = ui.output / 'motion.json'
    entries = json.loads(motion.read_text()) if motion.exists() else []
    entries.append({'name': name, 'start': started, 'seconds': seconds, 'screen': screen, 'band': band})
    motion.write_text(json.dumps(entries, indent=2))


def bottom_marks(media, screen, band, start=None, seconds=None):
    width, height = screen
    x, y, w, h = (round(value) for value in band)
    probe = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                                     '-of', 'csv=p=0', str(media)], text=True).split(',')
    # Simulator captures keep the portrait framebuffer; the leased landscape rotation is counterclockwise.
    turn = 'transpose=2,' if (int(probe[0]) < int(probe[1])) != (width < height) else ''
    window = ['-ss', f'{max(0, start):.3f}', '-t', f'{seconds:.3f}'] if start is not None else []
    raw = subprocess.check_output(['ffmpeg', '-v', 'fatal', *window, '-i', str(media), '-vf',
                                   f'{turn}scale={width}:{height},crop={w}:{h}:{x}:{y},format=gray',
                                   '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], timeout=120)
    size = w * h
    tracks = []
    for offset in range(0, len(raw) - size + 1, size):
        data = raw[offset:offset + size]
        background = sorted(data)[size // 2]
        inked = [any(abs(data[row * w + column] - background) > 70 for row in range(h)) for column in range(w)]
        marks, run = [], None
        for column, ink in enumerate(inked + [False]):
            if ink and run is None:
                run = column
            elif not ink and run is not None:
                if 6 <= column - run <= 30:
                    marks.append(x + (run + column) / 2)
                run = None
        tracks.append(marks)
    return tracks


def assert_bottom_travels(rest, tracks, name):
    assert len(rest) >= 2, (f'{name}: the resting sidebar shows no search glyph and New Session', rest)
    glyph, plus = min(rest), max(rest)
    seen = [index for index, marks in enumerate(tracks) if marks]
    assert seen, (f'{name}: the recording never showed the bottom row', len(tracks))
    assert all(tracks[index] for index in range(seen[0], seen[-1])), \
        (f'{name}: the bottom row blinked out mid-transition', tracks[seen[0]:seen[-1] + 1])
    moving = [marks for marks in tracks if marks and plus - (glyph - 4) <= max(marks) < plus - 1]
    assert moving, (f'{name}: no frame caught the bottom row moving', tracks)
    for marks in moving:
        assert any(abs(mark - (max(marks) - (plus - glyph))) <= 6 for mark in marks), \
            (f'{name}: New Session moved without the search field beside it', marks, rest)
    return len(moving)


def check_motion(output):
    origin = float((output / 'run-video-started').read_text())
    frames = {}
    for entry in json.loads((output / 'motion.json').read_text()):
        name, screen, band = entry['name'], entry['screen'], entry['band']
        stills = [bottom_marks(output / f'{name}-{side}.png', screen, band)[0] for side in ('before', 'after')]
        rest = max(stills, key=len)
        tracks = bottom_marks(output / 'run.mp4', screen, band, entry['start'] - origin - .2, entry['seconds'] + .4)
        frames[name] = assert_bottom_travels(rest, tracks, name)
    return frames
