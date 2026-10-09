/**
 * A deliberately NON-EXECUTING preview of one HTML source file.
 * Never load object bytes as a same-origin document or loosen the parent CSP.
 * This can show semantic HTML layout, not a running web app.
 */
export const HTML_SOURCE_LIMIT = 24_000;
const denyAll = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ');

export function isHtmlSource(object = {}) {
  const name = String(object?.name ?? '').trim().toLowerCase();
  const type = String(object?.contentType ?? '').split(';')[0].trim().toLowerCase();
  // Extension is definitive for uploaded files even when labelled text/plain.
  return /\.(?:html?|xhtml)$/.test(name) || ['text/html','application/xhtml+xml'].includes(type);
}

export function staticHtmlDocument(source) {
  // The iframe has sandbox="" (no scripts/same-origin/forms/popups) and CSP.
  // No external files, inline CSS, images, fonts or links are fetched.
  // Keep the document's CSP first, before the user's HTML is parsed.
  const value = String(source ?? '').slice(0, HTML_SOURCE_LIMIT);
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + denyAll + '">' +
    '</head><body>' + value + '</body></html>';
}

export function createStaticHtmlFrame(source, title = 'HTML static layout preview') {
  const iframe = document.createElement('iframe');
  iframe.className = 'artifact-preview-html-frame';
  iframe.title = String(title).slice(0, 160);
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('aria-label', 'Non-interactive HTML structure preview');
  // Attribute must exist before srcdoc: never grant allow-scripts or allow-same-origin.
  iframe.srcdoc = staticHtmlDocument(source);
  return iframe;
}
