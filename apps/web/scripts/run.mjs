import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Next.js's CLI does NOT read PORT/-p from .env / .env.local — those files
// are only loaded once the framework itself boots, which is too late to
// affect which port the dev/start server binds to. That's why setting
// PORT in .env.local alone had no effect and Next always fell back to the
// default port. This script loads .env.local ourselves first, then passes
// the port explicitly on the command line so it's actually honored.
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, '..');

config({ path: path.join(webRoot, '.env.local') });

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const port = process.env.PORT || 3000;

console.log(`[web] starting Next.js (${mode}) on port ${port}`);

// BIND_HOST=127.0.0.1 — слушать только локально (за nginx/Caddy; так
// ставит установщик deploy/install). Пусто — все интерфейсы, как раньше.
const bindHost = (process.env.BIND_HOST || '').trim();
const args = ['next', mode, '-p', String(port), ...(bindHost ? ['-H', bindHost] : [])];

const child = spawn('npx', args, {
  stdio: 'inherit',
  shell: true,
  cwd: webRoot,
});

child.on('exit', (code) => process.exit(code ?? 0));
