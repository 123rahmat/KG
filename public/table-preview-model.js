/**
 * Safely shape server-provided table samples for read-only artifact previews.
 * A preview is not a spreadsheet editor and never changes file data.
 */
const clip = value => {
  let result;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') result = value;
  else if (typeof value === 'object') {
    try { result = JSON.stringify(value); } catch { result = '[unavailable value]'; }
  } else result = String(value);
  return result.length > 240 ? result.slice(0, 237) + '…' : result;
};
export function tablePreviewModel(table = {}, { maxRows = 12, maxColumns = 12 } = {}) {
  const rowLimit = Number.isFinite(maxRows) ? Math.max(1, Math.min(30, Math.floor(maxRows))) : 12;
  const columnLimit = Number.isFinite(maxColumns) ? Math.max(1, Math.min(24, Math.floor(maxColumns))) : 12;
  const sample = Array.isArray(table?.sample) ? table.sample.slice(0, rowLimit) : [];
  const firstObject = sample.find(row => row && typeof row === 'object' && !Array.isArray(row));
  const explicit = Array.isArray(table?.columns) ? table.columns
    : Array.isArray(table?.headers) ? table.headers : null;
  const fieldNames = explicit?.length ? explicit.map(value => clip(value?.name ?? value))
    : firstObject ? Object.keys(firstObject) : [];
  const maxArrayLength = sample.reduce((max,row)=>Math.max(max,Array.isArray(row)?row.length:0),0);
  const length = Math.max(fieldNames.length, maxArrayLength, sample.some(row=>!row || typeof row !== 'object')?1:0);
  const count = Math.min(length,columnLimit);
  const header = fieldNames.length ? fieldNames.slice(0,count) : [];
  const keys = firstObject && !explicit?.length ? Object.keys(firstObject) : fieldNames;
  const rows = sample.map(row => Array.from({length:count},(_,i) => {
    if (Array.isArray(row)) return clip(row[i]);
    if (row && typeof row === 'object') return clip(row[keys[i]]);
    return i === 0 ? clip(row) : '';
  }));
  return Object.freeze({
    name: clip(table?.name || 'Table sample'),
    header:Object.freeze(header),
    rows:Object.freeze(rows.map(row=>Object.freeze(row))),
    truncatedRows: Array.isArray(table?.sample) && table.sample.length > rowLimit,
    truncatedColumns: length > columnLimit,
    readOnly:true
  });
}
