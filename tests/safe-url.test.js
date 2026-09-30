/**
 * Links and sources in the page can come from AI answers and web research,
 * so every href/src goes through one check that refuses anything that could
 * run code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= new EventTarget();
globalThis.document ??= { getElementById: () => null };
const { safeUrl } = await import('../public/ui-core.js');

test('only web, mail, blob and same-site addresses become links', () => {
  for (const good of ['https://example.com/a?b=c', 'http://example.com', '/api/objects/1/content', '#top', '?q=1', 'mailto:a@example.com', 'blob:https://app.example/1']) {
    assert.equal(safeUrl(good), true, good);
  }
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox', '//evil.example', 'file:///etc/passwd', '', null]) {
    assert.equal(safeUrl(bad), false, String(bad));
  }
});

test('rate limits count an IPv6 client by its /64, so rotating addresses does not help', async () => {
  const { clientNetwork } = await import('../src/http/rate-limit.js');
  assert.equal(clientNetwork('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), clientNetwork('2001:db8:1:2::1'));
  assert.equal(clientNetwork('2001:0db8:0001:0002::ffff'), '2001:db8:1:2::/64');
  assert.notEqual(clientNetwork('2001:db8:1:2::1'), clientNetwork('2001:db8:1:3::1'));
  assert.equal(clientNetwork('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(clientNetwork('203.0.113.5'), '203.0.113.5');
});
