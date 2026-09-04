import { spawnSync } from 'node:child_process';

const candidates = [
  process.env.NEUROSCAPE_PYTHON,
  'python3.13',
  'python3.12',
  'python3.11',
  'python3',
  'python',
].filter(Boolean);

const python = candidates.find((candidate) => {
  const result = spawnSync(candidate, [
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)',
  ]);
  return result.status === 0;
});

if (!python) {
  console.error(
    'Calibration requires Python 3.11+. Install it or set NEUROSCAPE_PYTHON.',
  );
  process.exit(1);
}

for (const args of [
  ['-m', 'venv', '--clear', 'eeg-calibration/.venv'],
  ['-m', 'pip', 'install', '-e', './eeg-calibration[test]'],
]) {
  const command =
    args[0] === '-m' && args[1] === 'pip'
      ? process.platform === 'win32'
        ? 'eeg-calibration/.venv/Scripts/python.exe'
        : 'eeg-calibration/.venv/bin/python'
      : python;
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
