import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, inlineText } from '../public/markdown.js';

test('answers are read as Markdown: headings, lists, tables, quotes, code', () => {
  const blocks = parseMarkdown([
    '## Plan', 'Some **bold**, *italic* and `code`.', '',
    '- one', '- two', '  - nested', '', '3. third', '4. fourth', '',
    '| Month | Revenue |', '|---|--:|', '| Jan | 1,200 |', '',
    '> a quote', '', '```python', 'print("hi")', '```', '---', '- [x] done', '- [ ] to do'
  ].join('\n'));
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'list', 'list', 'table', 'quote', 'code', 'rule', 'list']);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].children.map(span => span.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text']);
  assert.equal(blocks[2].items[1].children[1].type, 'list', 'nested list');
  assert.equal(blocks[3].start, 3);
  assert.deepEqual(blocks[4].align, [null, 'right']);
  assert.equal(inlineText(blocks[4].rows[0][1]), '1,200');
  assert.deepEqual([blocks[6].language, blocks[6].text], ['python', 'print("hi")']);
  assert.deepEqual(blocks[8].items.map(item => item.checked), [true, false]);
});

test('model text never becomes markup or a script link', () => {
  const spans = parseInline('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.org) see https://example.com/a.');
  assert.ok(!spans.some(span => span.type === 'link' && !/^https:/.test(span.href)));
  assert.deepEqual(spans.filter(span => span.type === 'link').map(span => span.href), ['https://example.org', 'https://example.com/a']);
  assert.match(inlineText(spans), /<img src=x onerror=alert\(1\)>/, 'kept as plain text');
  // The renderer builds nodes only; no HTML string is ever assigned.
  return import('node:fs').then(fs => {
    const source = fs.readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

test('maths is shown as readable symbols, with real super- and subscripts', async () => {
  const { parseInline } = await import('../public/markdown.js');
  const { latexToText, latexToParts } = await import('../public/math-text.js');
  const [display] = parseInline('$$\\Delta U = Q - W$$');
  assert.equal(display.type, 'math');
  assert.equal(display.display, true);
  assert.deepEqual(display.parts, ['ΔU = Q − W']);
  const spans = parseInline('Efficiency is $\\eta = 1 - \\frac{T_c}{T_h}$ at best.');
  assert.deepEqual(spans.map(span => span.type), ['text', 'math', 'text']);
  assert.deepEqual(spans[1].parts, ['η = 1 − T', { sub: ['c'] }, '/T', { sub: ['h'] }]);
  // Prices are not maths.
  assert.deepEqual(parseInline('It costs $5 and $10 later.').map(span => span.type).filter(type => type === 'math'), []);
  // \( … \) and \[ … \] work too; what cannot be converted is shown as written.
  assert.equal(parseInline('\\(E = mc^2\\)')[0].type, 'math');
  assert.equal(latexToText('E = mc^2'), 'E = mc²');
  assert.equal(latexToText('\\oint \\frac{\\delta Q}{T} \\le 0'), '∮ δQ/T ≤ 0');
  assert.equal(latexToText('\\sqrt{a^2+b^2}'), '√(a²+b²)');
  assert.equal(latexToText('\\unknowncommand x'), '\\unknowncommand x');
  assert.deepEqual(latexToParts('x^{n+1}'), ['x', { sup: ['n+1'] }]);
  // As plain text (headings, copying) maths keeps its symbols.
  assert.equal(inlineText(parseInline('Then $\\Delta U = Q - W$.')), 'Then ΔU = Q − W.');
});
