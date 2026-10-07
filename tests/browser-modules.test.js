import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('the browser entry point links every local import before startup', () => {
  const probe = `
    import { readFile } from 'node:fs/promises';
    import { SourceTextModule } from 'node:vm';
    const modules = new Map();
    async function load(url) {
      if (!modules.has(url)) {
        modules.set(url, new SourceTextModule(await readFile(new URL(url), 'utf8'), { identifier: url }));
      }
      return modules.get(url);
    }
    const entry = await load(new URL('./public/app.js', 'file://' + process.cwd() + '/').href);
    await entry.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
