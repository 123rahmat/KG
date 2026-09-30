/**
 * math.evaluate: arithmetic without eval.
 *
 * A small recursive-descent parser over numbers, + - * / % ^, parentheses,
 * the constants pi and e, and a fixed list of functions. Anything else is a
 * parse error; nothing in the expression is ever executed as code.
 */

const FUNCTIONS = Object.freeze({
  abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp,
  ln: Math.log, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, hypot: Math.hypot
});
const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E });
const MAX_LENGTH = 500;
const MAX_DEPTH = 64;

export class MathError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid-expression';
  }
}

function tokenize(source) {
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)|([a-z][a-z0-9]*)|(\*\*|[-+*/%^(),]))/giy;
  let match;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    match = pattern.exec(source);
    if (!match || match[0].length === 0) {
      if (/^\s*$/.test(source.slice(index))) break;
      throw new MathError(`Unexpected character at position ${index + 1}`);
    }
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'name', value: match[2].toLowerCase() });
    else tokens.push({ type: 'op', value: match[3] === '**' ? '^' : match[3] });
  }
  return tokens;
}

export function evaluateExpression(expression) {
  const source = String(expression ?? '');
  if (!source.trim()) throw new MathError('An expression is required');
  if (source.length > MAX_LENGTH) throw new MathError(`Expressions are limited to ${MAX_LENGTH} characters`);
  const tokens = tokenize(source);
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position];
  const take = value => {
    const token = tokens[position];
    if (!token || (value !== undefined && token.value !== value)) {
      throw new MathError(value ? `Expected "${value}"` : 'Unexpected end of expression');
    }
    position += 1;
    return token;
  };
  const nest = parse => {
    if (++depth > MAX_DEPTH) throw new MathError('Expression is nested too deeply');
    try { return parse(); } finally { depth -= 1; }
  };

  // expression := term (('+' | '-') term)*
  const expressionRule = () => nest(() => {
    let value = termRule();
    while (peek()?.type === 'op' && ['+', '-'].includes(peek().value)) {
      value = take().value === '+' ? value + termRule() : value - termRule();
    }
    return value;
  });
  // term := unary (('*' | '/' | '%') unary)*
  const termRule = () => {
    let value = unaryRule();
    while (peek()?.type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = take().value;
      const right = unaryRule();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  };
  // unary := ('-' | '+') unary | power
  const unaryRule = () => {
    if (peek()?.type === 'op' && ['-', '+'].includes(peek().value)) {
      return take().value === '-' ? -nest(unaryRule) : nest(unaryRule);
    }
    return powerRule();
  };
  // power := primary ('^' unary)?   (right associative)
  const powerRule = () => {
    const base = primaryRule();
    if (peek()?.type === 'op' && peek().value === '^') {
      take();
      return base ** nest(unaryRule);
    }
    return base;
  };
  const primaryRule = () => {
    const token = take();
    if (token.type === 'number') return token.value;
    if (token.type === 'op' && token.value === '(') {
      const value = expressionRule();
      take(')');
      return value;
    }
    if (token.type === 'name') {
      if (Object.hasOwn(CONSTANTS, token.value)) return CONSTANTS[token.value];
      if (!Object.hasOwn(FUNCTIONS, token.value)) throw new MathError(`Unknown name "${token.value}"`);
      take('(');
      const args = [expressionRule()];
      while (peek()?.value === ',') { take(','); args.push(expressionRule()); }
      take(')');
      return FUNCTIONS[token.value](...args);
    }
    throw new MathError(`Unexpected "${token.value}"`);
  };

  const value = expressionRule();
  if (position < tokens.length) throw new MathError(`Unexpected "${tokens[position].value}"`);
  if (!Number.isFinite(value)) throw new MathError('The result is not a finite number');
  return value;
}

export function mathEvaluate(input = {}) {
  const expression = String(input.expression ?? '');
  const value = evaluateExpression(expression);
  return { output: { expression, value }, provenance: { method: 'deterministic-parser', evaluatedAt: new Date().toISOString() } };
}
