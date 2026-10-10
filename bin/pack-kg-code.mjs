#!/usr/bin/env node
/**
 * Export a clean, tracked KG Code source snapshot to a ZIP.
 * No dependency installation or network calls. Archive only committed HEAD,
 * so local .env, untracked keys, node_modules and build output stay outside.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function git(args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error('Git archive failed: ' + (result.stderr || result.error?.message || result.status));
  }
  return result.stdout.trim();
}
const root = git(['rev-parse', '--show-toplevel']);
if (resolve(root) !== projectRoot) throw new Error('Not running inside the KG Code checkout');
const revision = git(['rev-parse', 'HEAD']);
const paths = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
if (!paths.includes('package.json') || !paths.includes('server.js') || !paths.includes('src/config.js')) {
  throw new Error('Refusing to archive: necessary source files are missing');
}
const blocked = paths.filter(path => {
  const parts = path.toLowerCase().split('/');
  const basename = parts.at(-1);
  return basename === '.env'
    || (basename.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(basename))
    || ['.npmrc', '.netrc', '.pypirc', 'id_rsa'].includes(basename)
    || /\.(?:pem|p12|pfx|key|secret)$/.test(basename);
});
if (blocked.length) throw new Error('Refusing to package tracked secrets: ' + blocked.join(', '));
const outDir = resolve(projectRoot, 'dist');
mkdirSync(outDir, { recursive: true });
const zip = resolve(outDir, 'KG-Code-clean-source.zip');
git(['archive', '--format=zip', '--prefix=KG-Code/', '--output=' + zip, 'HEAD']);
const bytes = statSync(zip).size;
if (!bytes) throw new Error('ZIP archive was unexpectedly empty');
console.log('KG Code clean source ZIP: ' + zip);
console.log('Revision: ' + revision + ' | tracked files: ' + paths.length + ' | archive bytes: ' + bytes);
console.log('This ZIP is committed source, not a database or deployment backup.');
