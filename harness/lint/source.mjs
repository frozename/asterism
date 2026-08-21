const REGEX_PREFIX_KEYWORD = /\b(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/;
const CONTROL_PAREN_KEYWORD = /\b(?:catch|for|if|switch|while|with)$/;

function followsControlParenthesis(masked, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (masked[index] === ')') depth += 1;
    if (masked[index] !== '(') continue;
    depth -= 1;
    if (depth !== 0) continue;
    return CONTROL_PAREN_KEYWORD.test(masked.slice(0, index).trimEnd());
  }
  return false;
}

function canStartRegex(masked) {
  const prefix = masked.trimEnd();
  if (prefix.length === 0) return true;
  if (/(?:\+\+|--)$/.test(prefix)) return false;
  if (/[([{=,:;!&|?+\-*%^~<>]$/.test(prefix)) return true;
  if (REGEX_PREFIX_KEYWORD.test(prefix)) return true;
  return prefix.endsWith(')') && followsControlParenthesis(prefix, prefix.length - 1);
}

function maskedSource(source, { maskStrings }) {
  const contexts = [{ type: 'code', templateExpression: false, braceDepth: 0 }];
  let masked = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const context = contexts.at(-1);

    if (context.type === 'line-comment') {
      if (char === '\n') {
        contexts.pop();
        masked += '\n';
      } else {
        masked += ' ';
      }
      continue;
    }

    if (context.type === 'block-comment') {
      if (char === '*' && next === '/') {
        masked += '  ';
        index += 1;
        contexts.pop();
      } else {
        masked += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (context.type === 'single-quote' || context.type === 'double-quote') {
      masked += char === '\n' ? '\n' : maskStrings ? ' ' : char;
      if (context.escaped) {
        context.escaped = false;
      } else if (char === '\\') {
        context.escaped = true;
      } else if (
        (context.type === 'single-quote' && char === "'") ||
        (context.type === 'double-quote' && char === '"')
      ) {
        contexts.pop();
      }
      continue;
    }

    if (context.type === 'regex') {
      masked += char === '\n' ? '\n' : maskStrings ? ' ' : char;
      if (context.escaped) {
        context.escaped = false;
      } else if (char === '\\') {
        context.escaped = true;
      } else if (char === '[') {
        context.characterClass = true;
      } else if (char === ']') {
        context.characterClass = false;
      } else if (char === '/' && !context.characterClass) {
        contexts.pop();
      }
      continue;
    }

    if (context.type === 'template') {
      if (context.escaped) {
        masked += char === '\n' ? '\n' : maskStrings ? ' ' : char;
        context.escaped = false;
      } else if (char === '\\') {
        masked += maskStrings ? ' ' : char;
        context.escaped = true;
      } else if (char === '`') {
        masked += maskStrings ? ' ' : char;
        contexts.pop();
      } else if (char === '$' && next === '{') {
        masked += maskStrings ? ' {' : '${';
        index += 1;
        contexts.push({ type: 'code', templateExpression: true, braceDepth: 0 });
      } else {
        masked += char === '\n' ? '\n' : maskStrings ? ' ' : char;
      }
      continue;
    }

    if (context.templateExpression && char === '}') {
      masked += char;
      if (context.braceDepth === 0) contexts.pop();
      else context.braceDepth -= 1;
      continue;
    }

    if (char === '/' && next === '/') {
      masked += '  ';
      index += 1;
      contexts.push({ type: 'line-comment' });
    } else if (char === '/' && next === '*') {
      masked += '  ';
      index += 1;
      contexts.push({ type: 'block-comment' });
    } else if (char === '/' && canStartRegex(masked)) {
      masked += maskStrings ? ' ' : char;
      contexts.push({ type: 'regex', escaped: false, characterClass: false });
    } else if (char === "'") {
      masked += maskStrings ? ' ' : char;
      contexts.push({ type: 'single-quote', escaped: false });
    } else if (char === '"') {
      masked += maskStrings ? ' ' : char;
      contexts.push({ type: 'double-quote', escaped: false });
    } else if (char === '`') {
      masked += maskStrings ? ' ' : char;
      contexts.push({ type: 'template', escaped: false });
    } else {
      masked += char;
      if (context.templateExpression && char === '{') context.braceDepth += 1;
    }
  }

  return masked;
}

export function codeOnly(source) {
  return maskedSource(source, { maskStrings: true });
}

export function commentsMasked(source) {
  return maskedSource(source, { maskStrings: false });
}

export function closingBrace(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return masked.length - 1;
}

export function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}
