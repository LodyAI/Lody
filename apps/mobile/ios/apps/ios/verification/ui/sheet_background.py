"""Check rendered grouped cards against the sheet material beside them."""
import statistics
import subprocess


def capture_card(ui, name, row_id, inset='leading'):
    ui.capture(name)
    row = ui.element(row_id)['frame']
    width = round(ui.state()[0]['frame']['width'])
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / f'{name}.png'),
        '-vf', f'scale={width}:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], timeout=20)

    def sample(x, y):
        return tuple(statistics.median(
            pixels[((round(y) + dy) * width + round(x) + dx) * 3 + channel]
            for dy in range(-2, 3) for dx in range(-2, 3)
        ) for channel in range(3))

    y = row['y'] + row['height'] / 2
    # The leading inset avoids text, provider icons, and trailing accessories.
    x = row['x'] + 8
    if inset == 'trailing':
        # A select-all field puts its leading handle and shadow inside the leading inset.
        x = row['x'] + row['width'] - 8
    card = sample(x, y)
    ground = sample(row['x'] - 6, y)
    difference = max(abs(a - b) for a, b in zip(card, ground))
    print(f'{name}: card={card}, sheet={ground}, difference={difference}', flush=True)
    assert difference >= 8, f'{name}: grouped cell blends into the sheet background'
