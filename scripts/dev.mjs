// Runs the API (in-memory backend, demo data) and the Vite dashboard together.
//   npm run dev  ->  dashboard http://localhost:3502 · API http://localhost:3501 · docs http://localhost:3501/docs
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  ['api', 'api', ['run', 'dev']],
  ['web', 'web', ['run', 'dev']],
].map(([name, cwd, args]) => {
  const p = spawn(npm, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = name === 'api' ? '\x1b[35m[api]\x1b[0m' : '\x1b[36m[web]\x1b[0m';
  for (const stream of [p.stdout, p.stderr]) {
    stream.on('data', (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) console.log(`${tag} ${line}`);
    });
  }
  p.on('exit', (code) => {
    console.log(`${tag} exited with ${code}`);
    shutdown();
  });
  return p;
});

function shutdown() {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGINT');
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
