"""Check committed animation samples, including the window-to-cell handoff."""
import json
import math
from pathlib import Path
import shutil
import subprocess


def center(frame):
    return (frame[0] + frame[2] / 2, frame[1] + frame[3] / 2)


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def project(point, path, cumulative):
    best = (math.inf, 0)
    for i, (a, b) in enumerate(zip(path, path[1:])):
        ab = (b[0] - a[0], b[1] - a[1])
        span = ab[0] ** 2 + ab[1] ** 2
        u = 0 if span == 0 else min(1, max(0, ((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1]) / span))
        off = distance(point, (a[0] + ab[0] * u, a[1] + ab[1] * u))
        if off < best[0]:
            best = (off, cumulative[i] + u * math.sqrt(span))
    return best


class ThrowTrace:
    def __init__(self, ui):
        self.ui = ui
        container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
        self.folder = Path(container) / 'tmp'
        self.existing = set(self.folder.glob('lody-throw-*.json'))

    def reserved_space(self):
        paths = set(self.folder.glob('lody-throw-*.json')) - self.existing
        if not paths:
            return None
        trace = json.loads(max(paths, key=lambda path: path.stat().st_mtime).read_text())
        return trace['samples'][-1].get('reservedSpace')

    def verify(self, minimum):
        paths = sorted(set(self.folder.glob('lody-throw-*.json')) - self.existing)
        assert len(paths) >= minimum, 'Missing native throw traces; rebuild Debug with the opt-in probe'
        reports, failures = [], []
        for path in paths:
            shutil.copy2(path, self.ui.output / path.name)
            trace = json.loads(path.read_text())
            samples = trace['samples']
            # The first display interval can precede the animation transaction's
            # commit; model/stale presentation values there are not a rendered flight.
            frames = [s for s in samples if s['event'] == 'frame' and s['t'] >= s['budget']]
            if trace.get('transition') == 'reveal':
                opacity = [s['opacity'] for s in frames]
                drift = max([distance(s['frame'][:2], trace['destination'][:2]) for s in frames], default=math.inf)
                report = dict(file=path.name, transition='reveal', samples=len(frames), maxDriftPt=drift,
                              firstOpacity=opacity[0] if opacity else None, lastOpacity=opacity[-1] if opacity else None)
                reports.append(report)
                if trace['cancelled'] or len(frames) < 4 or drift > 1.5 or any(s.get('targetHidden') for s in frames):
                    failures.append((path.name, 'late destination did not remain visible and stationary'))
                if not opacity or opacity[0] > .75 or opacity[-1] < .99 or any(b < a for a, b in zip(opacity, opacity[1:])):
                    failures.append((path.name, 'late destination must fade in without resurrecting the source'))
                continue
            flight = [s for s in frames if not s['adopted']]
            adopted = [s for s in samples if s['adopted']]
            end = center(trace['destination'])
            route, route_times, flight_time = trace['path'], trace['pathTimes'], trace['flight']
            cumulative = [0]
            for a, b in zip(route, route[1:]):
                cumulative.append(cumulative[-1] + distance(a, b))
            length = max(c for c, t in zip(cumulative, route_times) if t <= flight_time)
            along, deviation = [], []
            for sample in flight:
                off, position = project(center(sample['frame']), route, cumulative)
                along.append(position)
                deviation.append(off)
            gaps = [b['t'] - a['t'] for a, b in zip(frames, frames[1:])]
            # Keep the first landed frame in the animation budget; later samples
            # still check geometry while alerts and draft edits may run.
            motion_gaps = [b['t'] - a['t'] for a, b in zip(frames, frames[1:]) if not a['adopted']]
            steps = [b - a for a, b in zip(along, along[1:])]
            # The center follows the designed path; the settle tail is part of it,
            # so only the flight segment must keep moving forward along it.
            # Presentation state is read at sampleTime, after CADisplayLink's
            # previous-frame timestamp. Both endpoints must precede the settle.
            backward = max([0] + [-step for step, sample in zip(steps, flight[1:]) if sample['sampleTime'] <= flight_time])
            # Measure the handoff itself. Subsequent reply growth or user scrolling
            # can legitimately move the adopted cell within the 350 ms tail.
            landing = distance(adopted[0]['modelFrame'][:2], trace['destination'][:2]) if adopted else math.inf
            presentation_error = max([0] + [distance(s['frame'][:2], s['modelFrame'][:2]) for s in adopted])
            stalls = sum(abs(step) < .1 and .15 * length < along[i] < .85 * length
                         for i, step in enumerate(steps))
            fps = (len(frames) - 1) / max(frames[-1]['t'] - frames[0]['t'], .001) if len(frames) > 1 else 0
            report = dict(file=path.name, duration=trace['duration'], samples=len(frames), flightSamples=len(flight),
                          measuredFPS=fps, maximumFPS=trace['maximumFPS'], maxFrameGapMs=max(gaps, default=0) * 1000,
                          maxMotionFrameGapMs=max(motion_gaps, default=0) * 1000,
                          distancePt=length, maxPathDeviationPt=max(deviation, default=0), maxBackwardStepPt=backward,
                          maxLandingErrorPt=landing, maxAdoptedPresentationErrorPt=presentation_error,
                          interiorStallFrames=stalls, minScale=min([s['scale'] for s in flight], default=1))
            text_frames = [s for s in flight if s['t'] > flight_time * .35]
            invisible = [s for s in text_frames if s.get('textOpacity', 0) < .9 or min(s.get('textBounds', [0])) <= 0]
            report['invisibleTextFrames'] = len(invisible)
            if invisible or not text_frames:
                failures.append((path.name, 'destination text disappeared after the source crossfade'))
            colors = [s['background'] for s in flight]
            source_color, target_color = trace['sourceBackground'], trace['destinationBackground']
            color_delta = [b - a for a, b in zip(source_color, target_color)]
            color_length = sum(v * v for v in color_delta)
            if color_length > .0001:
                color_progress = [sum((v - a) * d for v, a, d in zip(color, source_color, color_delta)) / color_length for color in colors]
                report['firstColorProgress'] = color_progress[0]
                report['lastColorProgress'] = color_progress[-1]
                report['intermediateColorFrames'] = sum(.05 < p < .95 for p in color_progress)
                if color_progress[0] > .35 or color_progress[-1] < .95 or report['intermediateColorFrames'] < 3 or any(b < a - .02 for a, b in zip(color_progress, color_progress[1:])):
                    failures.append((path.name, 'background snapped or reversed instead of blending from input to bubble'))
            else:
                failures.append((path.name, 'fixture input and bubble colors do not exercise the transition'))
            reports.append(report)
            if trace['cancelled'] or len(flight) < 12 or not adopted:
                failures.append((path.name, 'incomplete flight/adoption sampling'))
            if max(motion_gaps, default=1) > .05:
                failures.append((path.name, 'flight/landing callback gap exceeds 50ms'))
            if max(deviation, default=0) > 1.5 or backward > 1.5:
                failures.append((path.name, 'flight center left the designed path or moved backwards'))
            if landing > 1.5 or presentation_error > 1.5:
                failures.append((path.name, 'window-to-cell handoff changed position'))
            if stalls:
                failures.append((path.name, 'stationary interior frame'))
        (self.ui.output / 'throw-summary.json').write_text(json.dumps({'traces': reports, 'failures': failures}, indent=2))
        print(json.dumps(reports, indent=2))
        assert not failures, failures
