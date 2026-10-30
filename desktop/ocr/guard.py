"""External watchdog: terminate only our child process group under pressure.

Use together with a cgroup MemoryMax/MemorySwapMax and a CUDA allocator cap.
MemAvailable includes reclaimable cache; also retain physically free memory for
the integrated GPU's allocations, which cannot always reclaim that cache.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def memory():
    info = {k: int(v.split()[0])*1024 for k, v in
            (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    return {'used_fraction': 1-info['MemAvailable']/info['MemTotal'],
            'free_bytes': info['MemFree'], 'available_bytes': info['MemAvailable'],
            'total_bytes': info['MemTotal'], 'swap_used_bytes': info['SwapTotal']-info['SwapFree']}


def pressure(info, limit=.76, free_gib=12):
    return info['used_fraction'] >= limit or info['free_bytes'] < free_gib*1024**3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=float, default=.76)
    parser.add_argument('--free-gib', type=float, default=12)
    parser.add_argument('--report')
    parser.add_argument('--samples', help='Durable once-per-second telemetry, including before model load')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not 0 < args.limit <= .78: parser.error('RAM stop limit must be <=78%, below the 80% ceiling')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    info = memory()
    if pressure(info, args.limit, args.free_gib):
        print('OCR admission refused: memory pressure', file=sys.stderr); return 75
    samples = open(args.samples, 'a', buffering=1) if args.samples else None
    def sample(info, **extra):
        nonlocal samples
        if samples:
            if samples.tell() >= 4*1024*1024:
                samples.close()
                os.replace(args.samples, args.samples+'.previous')
                samples = open(args.samples, 'w', buffering=1)
            samples.write(json.dumps({'time': time.time(), **info, **extra})+'\n')
            samples.flush(); os.fsync(samples.fileno())
    sample(info, event='admitted')
    child = subprocess.Popen(command, start_new_session=True)
    def stop(*_):
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    peak = info['used_fraction']; minimum = info['free_bytes']; stopped = False; sampled_at = 0
    try:
        while child.poll() is None:
            info = memory(); peak = max(peak, info['used_fraction']); minimum = min(minimum, info['free_bytes'])
            if time.monotonic()-sampled_at >= 1:
                sample(info, pid=child.pid); sampled_at = time.monotonic()
            if pressure(info, args.limit, args.free_gib):
                stopped = True; stop(); print('OCR stopped by external memory watchdog', file=sys.stderr); break
            time.sleep(.2)
        code = child.wait()
    finally:
        stop()
        sample(memory(), event='exited', memory_stopped=stopped)
        if samples: samples.close()
        if args.report:
            Path(args.report).write_text(json.dumps({'peak_system_ram_fraction': peak,
                'minimum_free_bytes': minimum, 'memory_stopped': stopped}, indent=2))
    return 75 if stopped else max(0, code) if code >= 0 else 1


if __name__ == '__main__': sys.exit(main())
