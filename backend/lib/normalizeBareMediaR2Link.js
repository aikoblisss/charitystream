/**
 * Strip accidental "URL [https://...]" / "URL https://..." prefixes so only a bare URL is stored or displayed.
 */
function normalizeBareMediaR2Link(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  const bracket = s.match(/\[(\s*)(https?:\/\/[^\]]+)(\s*)\]/);
  if (bracket) return bracket[2].trim();
  s = s.replace(/^URL\s*[:.]?\s*/i, '');
  const m = s.match(/(https?:\/\/[^\s\]]+)/);
  if (m) return m[1].replace(/[)\],;.]+$/, '');
  return s;
}

module.exports = { normalizeBareMediaR2Link };
