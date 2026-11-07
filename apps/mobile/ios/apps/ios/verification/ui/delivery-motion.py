"""Check a recorded status collapse at a vertical slice through the user bubble.

Usage: python3 delivery-motion.py run.mp4 START_SECONDS X Y HEIGHT
The slice must contain only the bubble's top edge throughout the transition.
Uses the captured video pixels, independently of the native animation state.
"""
import json
import subprocess
import sys

video, start, x, y, height = sys.argv[1:]
height = int(height)
frames = subprocess.check_output([
    'ffmpeg', '-v', 'error', '-ss', start, '-i', video, '-t', '1.3',
    '-vf', f'setpts=PTS-STARTPTS,fps=60,crop=2:{height}:{x}:{y}', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
])
positions = []
for offset in range(0, len(frames), height * 6):
    frame = frames[offset:offset + height * 6]
    blue = [i // 6 for i in range(0, len(frame), 6)
            if frame[i + 1] > frame[i] + 4 and frame[i + 2] > frame[i + 1] + 3]
    assert blue, 'The bubble left the sampled slice'
    positions.append(min(blue))
assert len(positions) >= 30, 'Missing animation frames'
steps = [a - b for a, b in zip(positions, positions[1:])]
travel = positions[0] - positions[-1]
print(json.dumps({'bubbleTopPx': positions, 'travelPx': travel,
                  'maxStepPx': max(steps), 'maxReversePx': -min(steps)}, indent=2))
assert travel >= 15, 'No status height collapse was captured'
assert len(set(positions)) >= 5, 'The status height disappeared in a jump'
assert min(steps) >= -2, 'The bubble jumped backwards at removal'
assert max(steps) <= max(12, travel * .4), 'A single frame dropped too much height'
print('PASS: continuous status collapse without a final position jump')
