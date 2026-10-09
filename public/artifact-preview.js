/**
 * On-demand artifact preview for the shared Files system.
 *
 * Preview is deliberately separate from download. The server keeps the object
 * scoped and authenticated; this module only chooses a safe presentation for
 * an already-authorized object.
 */
import { $, element, button, downloadUrl, api } from './ui-core.js';
import { tablePreviewModel } from './table-preview-model.js';
import { isHtmlSource, createStaticHtmlFrame } from './static-html-preview.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DIRECT_MEDIA = new Set([...IMAGE_TYPES, 'application/pdf']);
const TEXT_TYPES = new Set([
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
  'application/javascript', 'text/javascript', 'text/html', 'text/css',
  'application/xml', 'text/xml'
]);
const DOCUMENT_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'csv', 'text', 'pdf', 'image', 'json', 'project', 'bundle']);

const text = value => String(value ?? '').trim();
// Ignore late extraction responses after another file is selected or the
// preview is closed. A slow DOCX/PDF must never replace the newer file.
let activePreviewTicket = 0;

function contentTypeOf(object = {}) {
  return text(object.contentType).split(';')[0].toLowerCase();
}

function extensionOf(object = {}) {
  const name = text(object.name).toLowerCase();
  return name.includes('.') ? name.split('.').pop() : '';
}

export function previewKind(object = {}) {
  const type = contentTypeOf(object);
  const ext = extensionOf(object);
  if (IMAGE_TYPES.has(type)) return 'image';
  if (isHtmlSource(object)) return 'html';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (TEXT_TYPES.has(type) || ['txt', 'md', 'json', 'csv', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'css', 'xml', 'sql', 'sh', 'yaml', 'yml', 'svg', 'scss', 'less', 'vue', 'svelte', 'astro', 'cjs', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'rb', 'toml', 'log'].includes(ext)) return 'text';
  if (DOCUMENT_FORMATS.has(text(object.format).toLowerCase()) || ['docx', 'xlsx', 'pptx'].includes(ext)) return 'document';
  if (['zip', 'tar', 'gz'].includes(ext) || /zip|archive/i.test(type)) return 'document';
  return null;
}

function titleFor(object) {
  return text(object.name) || 'Artifact preview';
}

function previewDialog() {
  return $('artifactPreviewDialog');
}

function clearDialog(dialog) {
  const body = $('artifactPreviewBody');
  const title = $('artifactPreviewTitle');
  const meta = $('artifactPreviewMeta');
  if (body) body.replaceChildren();
  if (title) title.textContent = '';
  if (meta) meta.textContent = '';
  dialog?.removeAttribute('data-kind');
}

function formatPreviewMeta(object) {
  return [object.type, object.contentType, object.size != null ? Number(object.size).toLocaleString() + ' bytes' : '']
    .filter(Boolean).join(' · ');
}

function textPreview(payload) {
  const wrapper = element('div', { class: 'artifact-text-preview' });
  if (payload.format) wrapper.append(element('div', { class: 'artifact-preview-kicker small muted', text: payload.format.toUpperCase() + ' preview' }));
  if (['docx','pptx','xlsx'].includes(text(payload.format).toLowerCase())) {
    wrapper.append(element('p', { class: 'small muted',
      text: 'Readable text and table sample, not a pixel-perfect Office rendering. Open the original to confirm exact layout, charts and typography.' }));
  }
  if (payload.pages) wrapper.append(element('div', { class: 'small muted', text: payload.pages + ' page' + (payload.pages === 1 ? '' : 's') }));
  if (payload.slides) wrapper.append(element('div', { class: 'small muted', text: payload.slides + ' slide' + (payload.slides === 1 ? '' : 's') }));
  const value = text(payload.text);
  wrapper.append(element('pre', { class: 'artifact-preview-pre', text: value || 'No readable text was extracted from this artifact.' }));
  if (payload.truncated) wrapper.append(element('p', { class: 'small muted', text: 'Preview truncated for display. Download the original for the complete file.' }));
  if (Array.isArray(payload.tables) && payload.tables.length) {
    const tableSummary = element('div', { class: 'artifact-preview-tables stack' });
    for (const table of payload.tables.slice(0, 4)) {
      const sample = tablePreviewModel(table);
      if (!sample.rows.length || !sample.rows[0].length) continue;
      const tableHead = sample.header.length ? element('thead', {},
        element('tr', {}, sample.header.map(cell => element('th', { scope: 'col', text: cell })))) : null;
      const tableBody = element('tbody', {}, sample.rows.map(row =>
        element('tr', {}, row.map(cell => element('td', { text: cell })))));
      tableSummary.append(element('section', { class: 'artifact-preview-table' }, [
        element('strong', { class: 'small', text: sample.name }),
        element('div', {
          class: 'artifact-preview-table-scroll', role: 'region', tabindex: '0',
          'aria-label': sample.name + ' · read-only table sample'
        }, element('table', { class: 'artifact-preview-sample-table' },
          [element('caption', { class: 'sr-only', text: sample.name + ' read-only preview' }),
            tableHead, tableBody].filter(Boolean))),
        sample.truncatedRows || sample.truncatedColumns
          ? element('span', { class: 'small muted',
            text: 'Preview limited to a sample of rows and columns. Download the file for complete data.' })
          : null
      ].filter(Boolean)));
    }
    if (tableSummary.childElementCount) wrapper.append(tableSummary);
  }
  return wrapper;
}

async function populate(object, ticket) {
  const dialog = previewDialog();
  const body = $('artifactPreviewBody');
  const title = $('artifactPreviewTitle');
  const meta = $('artifactPreviewMeta');
  if (!dialog || !body) return;

  clearDialog(dialog);
  if (title) title.textContent = titleFor(object);
  if (meta) meta.textContent = formatPreviewMeta(object);

  const kind = previewKind(object);
  dialog.dataset.kind = kind || 'unsupported';
  if (!kind) {
    body.append(element('div', { class: 'artifact-preview-empty' }, [
      element('strong', { text: 'Preview is not available for this format.' }),
      element('p', { class: 'muted small', text: 'The original file remains available to download. You can also attach it to Normal Chat so the adaptive workflow can determine whether it is readable here.' })
    ]));
    return;
  }

  if (DIRECT_MEDIA.has(contentTypeOf(object))) {
    const src = downloadUrl('/api/objects/' + encodeURIComponent(object.id) + '/content?preview=1');
    if (kind === 'image') {
      const image = element('img', { class: 'artifact-preview-image', src, alt: 'Preview of ' + titleFor(object), decoding: 'async' });
      image.addEventListener('error', () => {
        body.replaceChildren(element('p', { class: 'artifact-preview-empty muted', text: 'The image could not be displayed. Download the original file instead.' }));
      });
      body.append(image);
    } else {
      body.append(element('iframe', { class: 'artifact-preview-frame', src, title: 'Preview of ' + titleFor(object), loading: 'lazy' }));
    }
    return;
  }

  try {
    body.append(element('p', {
      class: 'small muted artifact-preview-loading', role: 'status',
      text: 'Preparing a safe read-only preview…'
    }));
    const payload = await api('GET', '/api/objects/' + encodeURIComponent(object.id) + '/preview');
    if (ticket !== activePreviewTicket) return;
    body.replaceChildren();
    if (kind === 'html') {
      const frame = createStaticHtmlFrame(payload.text, 'Static structure of ' + titleFor(object));
      const preview = element('section', { class: 'artifact-preview-html' }, [
        element('p', { class: 'small muted', text:
          'Static HTML structure only. Scripts, stylesheets, images, forms and network access are blocked. An interactive UI needs a separately isolated build preview.' }),
        frame,
        element('details', { class: 'artifact-preview-html-source' }, [
          element('summary', { text: 'View HTML source' }),
          element('pre', { class: 'artifact-preview-pre', text: String(payload.text ?? '') })
        ]),
        payload.truncated ? element('p', { class: 'small muted', text: 'File preview was truncated. Download the original for all content.' }) : null
      ].filter(Boolean));
      body.append(preview);
    } else {
      body.append(textPreview(payload));
    }
  } catch (error) {
    if (ticket !== activePreviewTicket) return;
    body.replaceChildren();
    body.append(element('div', { class: 'artifact-preview-empty' }, [
      element('strong', { text: 'Preview could not be generated.' }),
      element('p', { class: 'muted small', text: error.message || 'Download the original file or attach it to chat.' })
    ]));
  }
}

export async function openArtifactPreview(object) {
  const dialog = previewDialog();
  if (!dialog || !object?.id) return;
  const ticket = ++activePreviewTicket;
  // Open before awaiting potentially expensive document extraction, so the
  // user sees an immediate response rather than an unresponsive Preview chip.
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else dialog.hidden = false;
  await populate(object,ticket);
}

export function previewButton(object, label = 'Preview') {
  return button(label, () => openArtifactPreview(object), 'small');
}

export function artifactChip(object, { preview = true } = {}) {
  const name = typeof object === 'string' ? object : titleFor(object);
  const node = element('span', { class: 'file-chip artifact-chip' }, [
    element('span', { class: 'artifact-chip-icon', text: object?.contentType && IMAGE_TYPES.has(contentTypeOf(object)) ? 'image' : 'file' }),
    element('span', { class: 'truncate', text: name })
  ]);
  if (preview && object?.id) {
    node.classList.add('artifact-chip-action');
    node.tabIndex = 0;
    node.role = 'button';
    const open = () => openArtifactPreview(object);
    node.addEventListener('click', open);
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    node.title = 'Preview ' + name;
    node.setAttribute('aria-label', 'Preview ' + name);
  }
  return node;
}

export function initArtifactPreview() {
  const dialog = previewDialog();
  const close = $('artifactPreviewClose');
  close?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('close', () => { activePreviewTicket++; clearDialog(dialog); });
  dialog?.addEventListener('cancel', () => clearDialog(dialog));
}