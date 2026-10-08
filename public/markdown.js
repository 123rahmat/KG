/**
 * A small, safe Markdown reader for answers: headings, paragraphs, lists,
 * quotes, tables, rules and fenced code, with bold, italic, inline code and
 * links inside. It never produces HTML strings: `parseMarkdown` returns plain
 * data and `renderMarkdown` builds DOM nodes from it, so text from the model
 * can never become markup. Links are kept only for http(s) and mailto.
 */

import { latexToParts, looksLikeMath, flattenMath } from './math-text.js';
import { parseFlowDiagram } from './flow-diagram.js';

/** The direction of a text: that of its first letter (rtl for Arabic, Urdu, Hebrew…). */
export function textDirection(text) {
  const first = String(text ?? '').match(/[\p{L}]/u)?.[0];
  if (!first) return 'auto';
  return /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(first) ? 'rtl' : 'ltr';
}

const DIRECTIONAL = new Set(['p', 'ul', 'ol', 'li', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'blockquote', 'td', 'th']);
const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

/** Inline text into spans: text, strong, em, code, link, math. */
export function parseInline(text) {
  const out = [];
  const source = String(text ?? '');
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w])_(?=\S)([\s\S]*?\S)_(?![\w])|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\w$\\])\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?![\w$])/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) out.push({ type: 'text', text: source.slice(last, match.index) });
    if (match[2] !== undefined) out.push({ type: 'code', text: match[2].replace(/^ (.*) $/, '$1') });
    else if (match[3] !== undefined || match[4] !== undefined) out.push({ type: 'strong', children: parseInline(match[3] ?? match[4]) });
    else if (match[5] !== undefined || match[6] !== undefined) out.push({ type: 'em', children: parseInline(match[5] ?? match[6]) });
    else if (match[7] !== undefined) {
      const href = safeHref(match[8]);
      out.push(href ? { type: 'link', href, children: parseInline(match[7]) } : { type: 'text', text: match[7] });
    } else if (match[9] !== undefined) {
      const href = safeHref(match[9]);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: match[9] }] } : { type: 'text', text: match[9] });
    } else if (match[10] !== undefined || match[11] !== undefined) {
      // Display maths: $$…$$ or \[…\], on a line of its own.
      out.push({ type: 'math', display: true, parts: latexToParts(match[10] ?? match[11]) });
    } else if (match[12] !== undefined) {
      out.push({ type: 'math', display: false, parts: latexToParts(match[12]) });
    } else if (match[13] !== undefined) {
      // $…$ is maths only when it reads as maths: "$5 and $10" stays text.
      out.push(looksLikeMath(match[13]) ? { type: 'math', display: false, parts: latexToParts(match[13]) } : { type: 'text', text: match[0] });
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}

export function safeHref(value) {
  const href = String(value ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

/** Block structure of a Markdown answer. */
export function parseMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s{0,3}${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`);
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !close.test(lines[j]); j += 1) body.push(lines[j]);
      blocks.push({ type: 'code', language: fence[3].toLowerCase(), text: body.join('\n') });
      i = j;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) }); continue; }
    if (RULE.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const header = cells(line);
      const align = cells(lines[i + 1]).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : null));
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j += 1) rows.push(cells(lines[j]));
      blocks.push({
        type: 'table',
        align: header.map((_, index) => align[index] ?? null),
        header: header.map(cell => parseInline(cell)),
        rows: rows.map(row => header.map((_, index) => parseInline(row[index] ?? '')))
      });
      i = j - 1;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body = [];
      let j = i;
      for (; j < lines.length && QUOTE.test(lines[j]); j += 1) body.push(lines[j].match(QUOTE)[1]);
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      i = j - 1;
      continue;
    }
    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered && !bullet);
      const items = [];
      const base = (bullet ?? ordered)[1].length;
      let j = i;
      for (; j < lines.length; j += 1) {
        const item = isOrdered ? lines[j].match(ORDERED) : lines[j].match(BULLET);
        if (item && item[1].length <= base + 1) {
          items.push({ lines: [isOrdered ? item[3] : item[2]] });
        } else if (items.length && lines[j].trim() && lines[j].match(/^\s*/)[0].length >= base + 2) {
          items.at(-1).lines.push(lines[j].slice(Math.min(lines[j].match(/^\s*/)[0].length, base + 2)));
        } else break;
      }
      const task = /^\[( |x|X)\]\s+/;
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: isOrdered ? Number(ordered[2]) : 1,
        items: items.map(item => {
          const nested = item.lines.slice(1).some(entry => BULLET.test(entry) || ORDERED.test(entry));
          const first = item.lines[0];
          const checked = task.test(first) ? /\[[xX]\]/.test(first) : null;
          const head = parseInline(first.replace(task, ''));
          return {
            checked,
            children: nested
              ? [{ type: 'paragraph', children: head }, ...parseMarkdown(item.lines.slice(1).join('\n'))]
              : [{ type: 'paragraph', children: parseInline(item.lines.map((entry, index) => (index ? entry : entry.replace(task, ''))).join('\n')) }]
          };
        })
      });
      i = j - 1;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Plain text of inline spans (for titles and copying). */
export function inlineText(spans) {
  return spans.map(span => (span.type === 'math' ? flattenMath(span.parts) : span.text ?? inlineText(span.children ?? []))).join('');
}

/** Mark explicit summary, example and caution callouts in user-visible answers only. */
export function quotePresentation(item) {
  const first = item?.children?.find(child => child.type === 'paragraph');
  const value = first ? inlineText(first.children).trim() : '';
  const match = value.match(/^(?:key point|reasoning summary|explanation|example|note|tip|important|caution|result)\s*:/i);
  if (!match) return null;
  const name = match[0].slice(0, -1).toLowerCase();
  return name === 'caution' || name === 'important' ? 'caution'
    : name === 'example' ? 'example'
      : name === 'reasoning summary' || name === 'explanation' ? 'reasoning'
        : 'insight';
}

/**
 * Build DOM nodes. `codeActions(block)` may return extra buttons for a code
 * block (copy, download, run).
 */
export function renderMarkdown(markdown, { codeActions = () => [] } = {}) {
  const make = (tag, className, children = []) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const child of children) if (child) node.append(child);
    // Each paragraph, list, item and cell takes its direction from its own
    // text (set once the text is in, so it is known), so Urdu or Arabic
    // reads right to left beside English.
    if (DIRECTIONAL.has(tag)) node.dir = textDirection(node.textContent);
    return node;
  };
  const inline = spans => spans.map(span => {
    if (span.type === 'text') return document.createTextNode(span.text);
    if (span.type === 'code') { const node = make('code'); node.textContent = span.text; return node; }
    if (span.type === 'strong') return make('strong', '', inline(span.children));
    if (span.type === 'em') return make('em', '', inline(span.children));
    if (span.type === 'math') {
      const parts = list => list.map(part => (typeof part === 'string' ? document.createTextNode(part) : make(part.sup ? 'sup' : 'sub', '', parts(part.sup ?? part.sub))));
      return make('span', span.display ? 'md-math md-math-display' : 'md-math', parts(span.parts));
    }
    if (span.type === 'link') {
      const link = make('a', '', inline(span.children));
      link.href = span.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }
    return null;
  });
  const block = item => {
    switch (item.type) {
      case 'heading': return make(`h${Math.min(6, item.level + 2)}`, 'md-heading', inline(item.children));
      case 'paragraph': return make('p', '', inline(item.children));
      case 'rule': return make('hr');
      case 'quote': {
        const presentation = quotePresentation(item);
        return make(presentation ? 'aside' : 'blockquote',
          presentation ? 'md-callout md-callout-' + presentation : '',
          item.children.map(block));
      }
      case 'code': {
        // Structured visualizations are opt-in and conservative. Unsupported
        // syntax remains a readable code block, never an invented diagram.
        const steps = item.language === 'flow' ? parseFlowDiagram(item.text) : null;
        if (steps) {
          const list = make('ol', 'md-flow-steps', steps.map((label, index) =>
            make('li', 'md-flow-step', [
              make('span', 'md-flow-number', [document.createTextNode(String(index + 1))]),
              make('span', 'md-flow-label', [document.createTextNode(label)])
            ])));
          const figure = make('figure', 'md-flow', [
            make('figcaption', 'md-flow-caption', [document.createTextNode('Process diagram')]),
            list
          ]);
          figure.setAttribute('aria-label', 'Linear process diagram with ' + steps.length + ' steps');
          return figure;
        }
        const code = make('code', item.language ? `language-${item.language}` : '');
        code.textContent = item.text;
        const label = make('span', 'md-code-lang');
        label.textContent = item.language || 'text';
        return make('div', 'md-code', [make('div', 'md-code-bar', [label, make('span', 'md-code-actions', codeActions(item))]), make('pre', '', [code])]);
      }
      case 'list': {
        const list = make(item.ordered ? 'ol' : 'ul', item.items.some(entry => entry.checked !== null) ? 'md-tasks' : '');
        if (item.ordered && item.start !== 1) list.start = item.start;
        for (const entry of item.items) {
          const li = make('li', '', entry.children.map(block));
          if (entry.checked !== null) {
            const box = make('input');
            box.type = 'checkbox';
            box.checked = entry.checked;
            box.disabled = true;
            li.prepend(box);
          }
          list.append(li);
        }
        // The list's own direction (where its indent and bullets go) follows its items.
        list.dir = textDirection(list.textContent);
        return list;
      }
      case 'table': {
        const head = make('tr', '', item.header.map((cell, index) => {
          const th = make('th', '', inline(cell));
          th.scope = 'col';
          if (item.align[index]) th.dataset.align = item.align[index];
          return th;
        }));
        const body = item.rows.map(row => make('tr', '', row.map((cell, index) => { const td = make('td', '', inline(cell)); if (item.align[index]) td.dataset.align = item.align[index]; return td; })));
        const wrapper = make('div', 'md-table', [make('table', '', [
          make('thead', '', [head]), make('tbody', '', body)
        ])]);
        wrapper.tabIndex = 0;
        wrapper.setAttribute('role', 'region');
        wrapper.setAttribute('aria-label', 'Answer table: ' +
          item.header.slice(0, 3).map(inlineText).join(', ').slice(0, 100));
        return wrapper;
      }
      default: return null;
    }
  };
  return make('div', 'md', parseMarkdown(markdown).map(block));
}
