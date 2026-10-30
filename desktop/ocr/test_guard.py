import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import guard


class GuardTests(unittest.TestCase):
    def test_external_guard_kills_child_and_preserves_telemetry(self):
        low = {'used_fraction': .30, 'free_bytes': 30*1024**3}
        high = {'used_fraction': .77, 'free_bytes': 25*1024**3}
        children = []
        real_popen = guard.subprocess.Popen
        def start(*args, **kwargs):
            child = real_popen(*args, **kwargs); children.append(child); return child
        with tempfile.TemporaryDirectory() as folder:
            log = str(Path(folder)/'memory.jsonl')
            argv = ['guard.py', '--samples', log, '--', sys.executable, '-c', 'import time; time.sleep(60)']
            with patch.object(sys, 'argv', argv), patch('guard.memory', side_effect=[low, high, high]), \
                 patch('guard.subprocess.Popen', side_effect=start), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(guard.main(), 75)
            self.assertEqual(children[0].poll(), -9)
            samples = [json.loads(line) for line in Path(log).read_text().splitlines()]
            self.assertEqual(samples[0]['event'], 'admitted')
            self.assertTrue(samples[-1]['memory_stopped'])
            self.assertEqual(samples[1]['used_fraction'], .77)


if __name__ == '__main__': unittest.main()
