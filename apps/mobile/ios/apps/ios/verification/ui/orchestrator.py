"""Independent native Simulator workers; failures retain sibling evidence."""
import json
import os
import signal
import subprocess
import time


def stop_process(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGINT)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()



def run_batches(commands, output):
    """Launch all workers before waiting; one failure never cancels a sibling."""
    workers = []
    started = time.monotonic()
    results = []
    try:
        for batch, command in commands.items():
            directory = output / batch
            directory.mkdir(parents=True, exist_ok=True)
            log = (directory / 'worker.log').open('w')
            try:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            except BaseException:
                log.close()
                raise
            workers.append((batch, process, log))
        pending = list(workers)
        while pending:
            for worker in pending[:]:
                batch, process, _ = worker
                code = process.poll()
                if code is not None:
                    result = {'batch': batch, 'exitCode': code, 'seconds': round(time.monotonic() - started, 2)}
                    results.append(result)
                    (output / 'batches.json').write_text(json.dumps(results, indent=2))
                    print(json.dumps(result), flush=True)
                    pending.remove(worker)
            if pending:
                time.sleep(.5)
        cases = []
        for batch in commands:
            path = output / batch / 'results.json'
            if path.exists():
                cases.extend({**case, 'batch': batch} for case in json.loads(path.read_text()))
            else:
                cases.append({'batch': batch, 'status': 'failed', 'error': 'Worker did not produce results.json'})
        (output / 'results.json').write_text(json.dumps(cases, indent=2))
        return int(any(result['exitCode'] != 0 for result in results) or any(case['status'] != 'passed' for case in cases))
    finally:
        for _, process, log in workers:
            try:
                stop_process(process)
            finally:
                log.close()
