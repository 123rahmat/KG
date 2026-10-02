import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectIndex,
  buildProjectHierarchy,
  hierarchicalProjectScope,
  projectScale
} from '../src/project-index.js';

test('hierarchical index stays deterministic and classifies very-large projects', () => {
  const files = Array.from({ length: 5005 }, (_, index) => ({
    path: index % 2 === 0 ? `services/api/module-${index}.js` : `services/web/module-${index}.js`,
    content: `export const value${index} = ${index};\n`
  }));
  const first = buildProjectIndex(files, { revisionId: 'rev-very-large' });
  const second = buildProjectIndex([...files].reverse(), { revisionId: 'rev-very-large' });
  assert.equal(first.scale, 'very-large');
  assert.equal(projectScale(first), 'very-large');
  assert.equal(first.hierarchy.root.fileCount, 5005);
  assert.equal(first.hierarchy.root.bytes, second.hierarchy.root.bytes);
  assert.equal(first.hierarchy.root.digest, second.hierarchy.root.digest);
  assert.equal(first.hierarchy.scale, 'very-large');
  assert.ok(first.hierarchy.directories.some(node =>
    node.path === 'services/api' && node.fileCount > 2000
  ));
  assert.ok(first.hierarchy.directories.some(node =>
    node.path === 'services/web' && node.fileCount > 2000
  ));
});

test('hierarchical scope points coding context at changed and impacted subtrees', () => {
  const files = [
    { path: 'services/api/orders.py', content: 'from .pricing import total\ndef create_order(): return total([])\n' },
    { path: 'services/api/pricing.py', content: 'def total(items): return sum(items)\n' },
    { path: 'services/api/test_orders.py', content: 'from .orders import create_order\n' },
    { path: 'services/web/home.py', content: 'def home(): return True\n' }
  ];
  const index = buildProjectIndex(files, { revisionId: 'r1' });
  const scope = hierarchicalProjectScope(index, ['services/api/pricing.py'], {
    query: 'orders pricing discount',
    maxSubtrees: 6
  });
  assert.equal(scope.scale, 'small');
  assert.ok(scope.changedSubtrees.includes('services/api'));
  assert.ok(scope.subtrees.some(node => node.path === 'services/api'));
});

test('buildProjectHierarchy aggregates files by directory with stable subtree digests', () => {
  const records = [
    { path: 'a/x.js', bytes: 5, digest: 'x' },
    { path: 'a/b/y.js', bytes: 7, digest: 'y' }
  ];
  const hierarchy = buildProjectHierarchy(records);
  assert.deepEqual(
    hierarchy.directories.find(node => node.path === 'a'),
    hierarchy.directories.find(node => node.path === 'a')
  );
  assert.equal(hierarchy.root.fileCount, 2);
  assert.equal(hierarchy.directories.find(node => node.path === 'a').bytes, 12);
  assert.notEqual(hierarchy.root.digest, hierarchy.directories.find(node => node.path === 'a').digest);
});
