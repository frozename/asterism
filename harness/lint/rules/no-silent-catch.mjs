import { closingBrace, codeOnly, commentsMasked, lineAt } from '../source.mjs';

const ID = 'no-silent-catch';

function isAccountedFor(sourceBody, maskedBody) {
  if (commentsMasked(sourceBody) !== sourceBody) return true;
  if (/\b(?:addCanary|append\w*Error|notes?\.push)\s*\(/.test(maskedBody)) return true;

  const statement = maskedBody.trim();
  return /^(?:return\b[^\r\n;]*;?|throw\b[^\r\n;]*;?|continue\s*;?|break\s*;?)$/.test(statement);
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!(file.file.startsWith('src/') || file.file.startsWith('bin/'))) continue;

    const masked = codeOnly(file.source);
    const pattern = /\bcatch\s*\{/g;
    for (const match of masked.matchAll(pattern)) {
      const openIndex = match.index + match[0].lastIndexOf('{');
      const closeIndex = closingBrace(masked, openIndex);
      const sourceBody = file.source.slice(openIndex + 1, closeIndex);
      const maskedBody = masked.slice(openIndex + 1, closeIndex);
      if (isAccountedFor(sourceBody, maskedBody)) continue;

      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineAt(file.source, match.index),
        message: 'bare catch must rethrow, explain the fallback, or return a sentinel',
      });
    }
  }
  return violations;
}

export const noSilentCatch = Object.freeze({
  id: ID,
  description: 'Require every bare catch swallow to account for its fallback.',
  paths: Object.freeze(['bin', 'src']),
  check,
});
