"""Check that a system list draws flat rail rows: full-width cells, no card, hairlines under the text column."""
import subprocess


def _pixels(path):
    probe = subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(path),
    ], text=True, timeout=20).strip().split(',')
    width, height = int(probe[0]), int(probe[1])
    data = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], timeout=20)
    return width, height, data


def assert_flat(ui, name, upper_id, lower_id, text_leading=46):
    ui.capture(name)
    items = ui.state()
    window = items[0]['frame']
    upper, lower = ui.element(upper_id)['frame'], ui.element(lower_id)['frame']
    for frame in (upper, lower):
        assert abs(frame['x'] - window['x']) < 1 and abs(frame['width'] - window['width']) < 1, \
            f'{name}: flat rows span the full width, got {frame}'
    width, _, data = _pixels(ui.output / f'{name}.png')
    scale = width / window['width']

    def gray(x, y):
        return data[round(y * scale) * width + round(x * scale)]

    def seam_pixel(x, y, reference):
        column = [data[(round(y * scale) + dy) * width + round(x * scale)] for dy in range(-3, 4)]
        return max(column, key=lambda value: abs(value - reference))

    middle = upper['y'] + upper['height'] / 2
    ground = gray(window['x'] + window['width'] - 4, upper['y'] - 2) if upper['y'] > window['y'] + 4 else gray(4, middle)
    card = gray(8, middle)
    assert abs(card - ground) < 4, f'{name}: rows sit on the ground without a card ({card} vs {ground})'
    seam = upper['y'] + upper['height']
    line = seam_pixel(text_leading + 60, seam, card)
    rail = seam_pixel(text_leading - 20, seam, card)
    print(f'{name}: ground={ground} card={card} hairline={line} rail={rail}', flush=True)
    assert abs(line - rail) >= 3, f'{name}: missing hairline under the text column'
    assert abs(rail - card) < 3, f'{name}: the hairline must not cross the icon rail'
    icon, text = ink_runs(data, width, scale, upper, card)[:2]
    center = (icon[0] + icon[1]) / 2
    print(f'{name}: icon={icon} text={text[0]:.1f}', flush=True)
    assert abs(center - 24) <= 2, f'{name}: the icon must center on the rail at 24 pt, got {center:.1f}'
    assert text_leading - 1 <= text[0] <= text_leading + 3, \
        f'{name}: the title must start at the {text_leading} pt text column, got {text[0]:.1f}'


def ink_runs(data, width, scale, frame, card):
    rows = range(round((frame['y'] + 6) * scale), round((frame['y'] + frame['height'] - 6) * scale))
    columns = [x / scale for x in range(round(140 * scale))
               if any(abs(data[y * width + x] - card) > 60 for y in rows)]
    runs = []
    for x in columns:
        if runs and x - runs[-1][1] <= 2:
            runs[-1][1] = x
        else:
            runs.append([x, x])
    return [(round(a, 1), round(b, 1)) for a, b in runs]


def assert_section_gap(ui, last_id, next_id, limit=56):
    gap = section_gap(ui.element(last_id)['frame'], ui.element(next_id)['frame'])
    print(f'section-gap: {last_id}->{next_id} {gap:.1f}', flush=True)
    assert gap <= limit, f'Flat sections leave {gap:.1f} pt between {last_id} and {next_id}; the group gap allows {limit}'


def section_gap(last, following):
    return following['y'] - (last['y'] + last['height'])
