"""Bounded fake-Git probe; never reads developer Git configuration."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 probe_git_config_timeout.py /absolute/path/to/node24')
node = str(Path(sys.argv[1]).resolve(strict=True))
source = Path(__file__).resolve().parents[3] / 'src/snapshot/git-command.ts'
with tempfile.TemporaryDirectory(prefix='git-config-timeout-') as temporary:
    root = Path(temporary)
    fake = root / 'git'
    fake.write_text('#!/bin/sh\nif [ "$1" = "config" ]; then /bin/sleep 0.3; exit 1; fi\nexit 0\n')
    fake.chmod(0o700)
    script = root / 'probe.mjs'
    script.write_text(
        'import { runGit } from ' + json.dumps(source.as_uri()) + ';\n'
        'const start = performance.now();\n'
        'await runGit(process.cwd(), ["status", "--short"], [0], 20);\n'
        'console.log(JSON.stringify({commandTimeoutMs:20, elapsedMs:performance.now()-start}));\n'
    )
    result = subprocess.run([node, str(script)], cwd=root,
                            env={'PATH': str(root), 'LANG': 'C'},
                            capture_output=True, text=True, timeout=3, check=True)
    observed = json.loads(result.stdout)
    assert observed['elapsedMs'] >= 300
    print(json.dumps(observed))
