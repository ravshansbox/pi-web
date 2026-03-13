import assert from 'node:assert/strict';

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (match, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case '#39':
        return "'";
      default:
        return match;
    }
  });
}

function escapeHtmlAttribute(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitiseHref(rawHref) {
  const href = decodeHtmlEntities(rawHref.trim());
  if (!href) return null;
  if (href.startsWith('#') || href.startsWith('/')) return href;
  try {
    const url = new URL(href, 'http://localhost');
    const protocol = url.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return href;
  } catch {}
  return null;
}

function inlineFormat(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safeHref = sanitiseHref(href);
    if (!safeHref) return label;
    return `<a href="${escapeHtmlAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

function cwdToSessionDir(cwd, agent, homeDir) {
  const normalisedCwd = cwd;

  if (agent === 'omp') {
    if (
      normalisedCwd === homeDir ||
      normalisedCwd.startsWith(`${homeDir}/`) ||
      normalisedCwd.startsWith(`${homeDir}\\`)
    ) {
      const relative = normalisedCwd.slice(homeDir.length).replace(/^[/\\]/, '');
      return `-${relative.replace(/[/\\:]/g, '-')}`;
    }
  }

  const encoded = normalisedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return `--${encoded}--`;
}

assert.equal(sanitiseHref('https://example.com'), 'https://example.com');
assert.equal(sanitiseHref('mailto:test@example.com'), 'mailto:test@example.com');
assert.equal(sanitiseHref('/docs'), '/docs');
assert.equal(sanitiseHref('#intro'), '#intro');
assert.equal(sanitiseHref('javascript:alert(1)'), null);
assert.equal(sanitiseHref('data:text/html,boom'), null);

assert.match(inlineFormat('[safe](https://example.com)'), /href="https:\/\/example\.com"/);
assert.doesNotMatch(inlineFormat('[bad](javascript:alert(1))'), /href=/);
assert.match(
  inlineFormat('[quoted](https://example.com?q=&quot;x&quot;)'),
  /href="https:\/\/example\.com\?q=&amp;quot;x&amp;quot;"/,
);

assert.equal(cwdToSessionDir('/Users/test/project', 'pi', '/Users/test'), '--Users-test-project--');
assert.equal(cwdToSessionDir('/Users/test/project', 'omp', '/Users/test'), '-project');
assert.equal(cwdToSessionDir('/tmp/project', 'omp', '/Users/test'), '--tmp-project--');

console.log('smoke checks passed');
