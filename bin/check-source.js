/**
 * Cross-platform source integrity check.
 *
 * Replaces shell-specific glob/for syntax so verification behaves the same
 * from PowerShell, cmd.exe, macOS/Linux shells and CI.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const roots = ['bin', 'src', 'public', 'tests', 'test'];
const explicit = ['server.js'];
const ignoredDirs = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
const sourceExts = new Set(['.js', '.mjs', '.cjs']);

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (sourceExts.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const files = [...new Set([
  ...explicit.map(file => path.join(root, file)),
  ...(await Promise.all(roots.map(dir => walk(path.join(root, dir))))).flat()
])].sort();

const failures = [];
for (const file of files) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', file], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: -1, stderr: String(error) }));
    child.on('close', code => resolve({ code, stderr }));
  });
  if (result.code !== 0) failures.push({
    file: path.relative(root, file),
    error: result.stderr.trim() || ('node --check exited with ' + result.code)
  });
}

if (failures.length) {
  console.error('Source check failed: ' + failures.length + '/' + files.length + ' files.');
  for (const failure of failures) console.error('\n' + failure.file + '\n' + failure.error);
  process.exit(1);
}

console.log('Source check passed: ' + files.length + ' JavaScript files.');
