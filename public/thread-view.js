/** Keyed conversation updates. Unchanged messages never leave the DOM. */
const views = new WeakMap();
const preserved = new WeakMap();
const dirty = new WeakSet();

export function keepView(node, key) {
  preserved.set(node, key);
  return node;
}

function carryViews(previous, next) {
  const old = [...previous.querySelectorAll('*')].filter(node => preserved.has(node));
  for (const node of [...next.querySelectorAll('*')]) {
    if (!preserved.has(node)) continue;
    const index = old.findIndex(item => preserved.get(item) === preserved.get(node));
    if (index < 0) continue;
    node.replaceWith(old.splice(index, 1)[0]);
  }
}

function controlKey(node, index) {
  return [node.tagName, node.id, node.name, node.type, node.getAttribute('aria-label'), node.getAttribute('placeholder'), index].join(':');
}

function carryControls(previous, next) {
  const beforeCard = previous.querySelector('[data-input-context]');
  const afterCard = next.querySelector('[data-input-context]');
  // A new step gets new controls; a poll of the same step keeps the draft.
  if (!beforeCard || beforeCard.dataset.inputContext !== afterCard?.dataset.inputContext) return;
  const before = [...beforeCard.querySelectorAll('input, textarea, select')];
  const after = [...afterCard.querySelectorAll('input, textarea, select')];
  before.forEach((control, index) => {
    if (control.type === 'file' || (!dirty.has(control) && document.activeElement !== control)) return;
    const replacement = after[index];
    if (!replacement || controlKey(control, index) !== controlKey(replacement, index)) return;
    replacement.value = control.value;
    if (['checkbox', 'radio'].includes(control.type)) replacement.checked = control.checked;
    // Recompute dependent buttons against the restored control state.
    if (['checkbox', 'radio'].includes(control.type) || control.tagName === 'SELECT') replacement.dispatchEvent(new Event('change', { bubbles: true }));
    dirty.add(replacement);
    if (document.activeElement === control) {
      replacement.dataset.restoreFocus = 'true';
      replacement._selection = [control.selectionStart, control.selectionEnd];
    }
  });
}

export function syncThread(host, entries, scope) {
  let view = views.get(host);
  const switching = view?.scope !== scope;
  if (!view) {
    view = { scope, entries: new Map() };
    views.set(host, view);
    for (const type of ['input', 'change']) host.addEventListener(type, event => dirty.add(event.target));
  }
  if (switching) { host.replaceChildren(); view.entries.clear(); view.scope = scope; }
  const viewport = document.scrollingElement;
  const focused = document.activeElement;
  const selection = window.getSelection();
  const selected = selection?.rangeCount && !selection.isCollapsed && host.contains(selection.anchorNode)
    ? { start: selection.getRangeAt(0).startContainer, startOffset: selection.getRangeAt(0).startOffset,
        end: selection.getRangeAt(0).endContainer, endOffset: selection.getRangeAt(0).endOffset } : null;
  const follow = switching || viewport.scrollHeight - window.scrollY - window.innerHeight < 140;
  const anchor = !follow ? [...host.children].find(node => node.getBoundingClientRect().bottom > 100) : null;
  const anchorKey = anchor?.dataset.renderKey;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const wanted = new Set(entries.map(entry => entry.key));
  for (const [key, cached] of view.entries) {
    if (!wanted.has(key)) { cached.node.remove(); view.entries.delete(key); }
  }
  let cursor = host.firstElementChild;
  for (const entry of entries) {
    const previous = view.entries.get(entry.key);
    let node = previous?.node;
    if (!previous || previous.signature !== entry.signature) {
      node = entry.render();
      node.dataset.renderKey = entry.key;
      if (previous) {
        carryViews(previous.node, node);
        carryControls(previous.node, node);
        previous.node.replaceWith(node);
        if (cursor === previous.node) cursor = node;
      }
      view.entries.set(entry.key, { signature: entry.signature, node });
    }
    if (node !== cursor) host.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
  const focus = host.querySelector('[data-restore-focus]');
  if (focus) {
    focus.removeAttribute('data-restore-focus');
    focus.focus({ preventScroll: true });
    if (focus._selection?.[0] != null && typeof focus.setSelectionRange === 'function') {
      try { focus.setSelectionRange(...focus._selection); } catch {}
    }
    delete focus._selection;
  }
  if (!focus && focused?.isConnected && host.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  if (selected?.start.isConnected && selected?.end.isConnected) {
    const range = document.createRange();
    range.setStart(selected.start, selected.startOffset);
    range.setEnd(selected.end, selected.endOffset);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (follow && !focus && !selected && !host.contains(focused)) window.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
  else if (anchorKey) {
    const replacement = view.entries.get(anchorKey)?.node;
    if (replacement) window.scrollBy({ top: replacement.getBoundingClientRect().top - anchorTop, behavior: 'instant' });
  }
}
