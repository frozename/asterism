const ID = 'writer-chokepoint';

export const EXEMPT = Object.freeze(['src/capture/run.js', 'src/io/cfgedit.js', 'src/io/store.js']);

const WRITE_NAME =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|ftruncate|ftruncateSync|chmod|chmodSync|fchmod|fchmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|utimes|utimesSync|futimes|futimesSync|createWriteStream)\b/;
const OPEN_CALL = /\bopen(?:Sync)?\s*\(/;
const WRITE_FLAG_TOKEN = /['"`][rsx]*[wa+][rwaxs+]*['"`]/;

function check(files) {
  const violations = [];
  for (const file of files) {
    if (EXEMPT.includes(file.file)) continue;

    const lines = file.source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const hasWriteName = WRITE_NAME.test(line);
      const hasOpenWithWriteFlag = OPEN_CALL.test(line) && WRITE_FLAG_TOKEN.test(line);
      if (hasWriteName || hasOpenWithWriteFlag) {
        violations.push({
          ruleId: ID,
          file: file.file,
          line: index + 1,
          message: `unguarded fs write outside the writer chokepoint: ${line.trim()}`,
        });
      }
    });
  }
  return violations;
}

export const writerChokepoint = Object.freeze({
  id: ID,
  description: 'Ban fs write calls under bin/ and src/ outside the three exempt writer chokepoint files.',
  paths: Object.freeze(['bin', 'src']),
  check,
});
