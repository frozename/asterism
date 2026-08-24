import { codeOnly, commentsMasked, lineAt } from '../source.mjs';

const ID = 'cli-subprocess-uses-node';
const SUBPROCESS_LAUNCH = /\b(?:execFile(?:Async|Sync)?|spawn(?:Sync)?)\s*\(/g;
const CONST_INITIALIZER = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DIRECT_CURRENT_RUNTIME = /^(?:process\.execPath|process\.argv\[0\])$/;
const ROOTED_REPOSITORY_PATH =
  /^path\.(?:join|resolve)\s*\(\s*ROOT\s*,\s*(['"])bin\1\s*,\s*(['"])(?:ast|ast-hook)\2\s*\)$/;
const ROOTED_REPOSITORY_TEMPLATE = /^`\$\{\s*ROOT\s*\}\/bin\/(?:ast|ast-hook)`$/;

/** @param {string} source */
function compactCode(source) {
  return codeOnly(source).replace(/\s/g, '');
}

/**
 * @param {string} masked
 * @param {number} index
 */
function skipWhitespace(masked, index) {
  while (/\s/.test(masked[index] ?? '')) index += 1;
  return index;
}

/**
 * @param {string} masked
 * @param {number} start
 * @param {string} terminators
 */
function expressionEnd(masked, start, terminators) {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = start; index < masked.length; index += 1) {
    const char = masked[index];
    if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0 && terminators.includes(char)) {
      return index;
    }
    if (char === '(') roundDepth += 1;
    if (char === ')') roundDepth -= 1;
    if (char === '[') squareDepth += 1;
    if (char === ']') squareDepth -= 1;
    if (char === '{') curlyDepth += 1;
    if (char === '}') curlyDepth -= 1;
  }
  return masked.length;
}

/**
 * @param {string} expression
 * @param {Set<string>} aliases
 */
function isCurrentRuntime(expression, aliases) {
  const compact = compactCode(expression);
  return DIRECT_CURRENT_RUNTIME.test(compact) || (IDENTIFIER.test(compact) && aliases.has(compact));
}

/**
 * @param {string} expression
 * @param {Set<string>} aliases
 */
function isRepositoryExecutable(expression, aliases) {
  const compact = compactCode(expression);
  if (IDENTIFIER.test(compact) && aliases.has(compact)) return true;

  const withStrings = commentsMasked(expression).trim();
  return ROOTED_REPOSITORY_PATH.test(withStrings) || ROOTED_REPOSITORY_TEMPLATE.test(withStrings);
}

/**
 * @param {string} source
 * @param {string} masked
 * @param {string} uncommented
 */
function aliasesIn(source, masked, uncommented) {
  /** @type {{ name: string, initializer: string }[]} */
  const declarations = [];
  const declarationCounts = new Map();
  for (const match of masked.matchAll(CONST_INITIALIZER)) {
    const name = match[1];
    const start = skipWhitespace(uncommented, match.index + match[0].length);
    const end = expressionEnd(masked, start, ';\n');
    declarations.push({ name, initializer: source.slice(start, end) });
    declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
  }

  const runtimeAliases = new Set();
  const executableAliases = new Set(['AST_BIN', 'HOOK_BIN']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (declarationCounts.get(declaration.name) !== 1) continue;
      if (!runtimeAliases.has(declaration.name) && isCurrentRuntime(declaration.initializer, runtimeAliases)) {
        runtimeAliases.add(declaration.name);
        changed = true;
      }
      if (
        !executableAliases.has(declaration.name) &&
        isRepositoryExecutable(declaration.initializer, executableAliases)
      ) {
        executableAliases.add(declaration.name);
        changed = true;
      }
    }
  }
  return { runtimeAliases, executableAliases };
}

/**
 * @param {string} command
 * @param {string} executable
 * @param {Set<string>} runtimeAliases
 * @param {Set<string>} executableAliases
 */
function isCurrentRuntimeRepositoryLaunch(command, executable, runtimeAliases, executableAliases) {
  return isCurrentRuntime(command, runtimeAliases) && isRepositoryExecutable(executable, executableAliases);
}

function check(files) {
  const violations = [];
  for (const file of files) {
    if (!file.file.startsWith('test/')) continue;

    const masked = codeOnly(file.source);
    const uncommented = commentsMasked(file.source);
    const { runtimeAliases, executableAliases } = aliasesIn(file.source, masked, uncommented);
    for (const match of masked.matchAll(SUBPROCESS_LAUNCH)) {
      const commandStart = skipWhitespace(uncommented, match.index + match[0].length);
      const commandEnd = expressionEnd(masked, commandStart, ',');
      if (masked[commandEnd] !== ',') continue;

      const arrayStart = skipWhitespace(uncommented, commandEnd + 1);
      if (masked[arrayStart] !== '[') continue;
      const executableStart = skipWhitespace(uncommented, arrayStart + 1);
      const executableEnd = expressionEnd(masked, executableStart, ',]');
      const command = file.source.slice(commandStart, commandEnd);
      const executable = file.source.slice(executableStart, executableEnd);
      if (!isCurrentRuntimeRepositoryLaunch(command, executable, runtimeAliases, executableAliases)) continue;

      violations.push({
        ruleId: ID,
        file: file.file,
        line: lineAt(file.source, match.index),
        message: 'launch repository executables with the node-resolving NODE constant',
      });
    }
  }
  return violations;
}

// Deliberate limits: only bare child-process callees and statically provable
// ROOT/bin paths are governed. Opaque helper returns, computed filenames, and
// reassigned bindings cannot be classified without risking false positives.
// harness/ remains out of scope while its subprocesses launch Git, tmux, or
// test files rather than repository executables.

export const cliSubprocessUsesNode = Object.freeze({
  id: ID,
  description: 'Require repository executable subprocesses in tests to use resolved Node.',
  paths: Object.freeze(['test']),
  check,
});
