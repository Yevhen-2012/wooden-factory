export function readCsv(text, required = []) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && [',', '\r', '\n'].includes(char)) {
      row.push(field); field = '';
      if (char !== ',') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  for (const name of required) if (!headers?.includes(name)) throw new Error(`Missing CSV column: ${name}`);
  return {
    headers,
    records: rows.map((values, i) => {
      if (values.length !== headers.length) throw new Error(`Invalid field count on CSV record ${i + 2}`);
      return Object.fromEntries(headers.map((key, j) => [key, values[j]]));
    })
  };
}
export const writeCsv = (headers, rows) => [headers, ...rows.map(row => headers.map(key => row[key]))]
  .map(values => values.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
