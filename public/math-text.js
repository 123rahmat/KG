/**
 * LaTeX maths as readable text: ΔU = Q − W instead of $$\Delta U = Q - W$$.
 *
 * Answers about science and engineering often carry LaTeX. The chat shows
 * it as Unicode text (Greek letters, operators, super- and subscripts,
 * fractions as a/b, roots as √x), with no maths library and nothing
 * executed. What cannot be converted is shown as written, never dropped.
 */

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  nabla: '∇', partial: '∂', int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', infty: '∞',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', sim: '∼', equiv: '≡', propto: '∝', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', degree: '°', circ: '∘', ldots: '…', cdots: '⋯', dots: '…',
  in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', perp: '⊥', parallel: '∥', angle: '∠',
  hbar: 'ħ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', prime: '′', lvert: '|', rvert: '|', vert: '|', mid: '|',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_',
  sin: 'sin', cos: 'cos', tan: 'tan', ln: 'ln', log: 'log', exp: 'exp', max: 'max', min: 'min', lim: 'lim', det: 'det'
};
const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '*': '*', '′': '′' };
const SUBSCRIPT = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };

/** The braced group starting at index i ("{…}"), or the single next character. */
function group(text, i) {
  if (text[i] !== '{') {
    if (text[i] === '\\') {
      const name = text.slice(i + 1).match(/^[A-Za-z]+/)?.[0] ?? text[i + 1] ?? '';
      return { body: text.slice(i, i + 1 + name.length), end: i + 1 + name.length };
    }
    return { body: text[i] ?? '', end: i + 1 };
  }
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) return { body: text.slice(i + 1, j), end: j + 1 }; }
  }
  return { body: text.slice(i + 1), end: text.length };
}

// Symbols that bind to what follows (ΔU, δQ, ∂S): the space after them in
// the source is only a separator, as in LaTeX.
const BINDING = new Set(['Delta', 'delta', 'partial', 'nabla', 'Gamma', 'gamma', 'mu', 'lambda', 'rho', 'sigma', 'tau', 'omega', 'Omega', 'phi', 'theta', 'alpha', 'beta', 'eta', 'epsilon', 'varepsilon', 'pi', 'psi', 'chi', 'xi', 'zeta', 'kappa', 'nu', 'hbar', 'ell']);

/** Parts as plain text: Unicode super- and subscripts where every character has one. */
export function flattenMath(parts, scripts = true) {
  return parts.map(part => {
    if (typeof part === 'string') return part;
    const inner = flattenMath(part.sup ?? part.sub, scripts);
    const table = part.sup ? SUPERSCRIPT : SUBSCRIPT;
    if (scripts && [...inner].every(char => table[char])) return [...inner].map(char => table[char]).join('');
    const marker = part.sup ? '^' : '_';
    return [...inner].length === 1 ? `${marker}${inner}` : `${marker}(${inner})`;
  }).join('');
}

// A fraction part needs brackets only when it holds more than one term.
const bracket = parts => (/^[\w.′\p{L}∂∇]+$/u.test(flattenMath(parts, false)) ? parts : ['(', ...parts, ')']);

/**
 * One LaTeX maths expression as parts: strings, and { sup } / { sub }
 * holding parts of their own, so a page can show real super- and
 * subscripts.
 */
export function latexToParts(source) {
  const text = String(source ?? '').trim();
  const out = [];
  const push = value => { if (value) out.push(value); };
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === '\\') {
      const name = text.slice(i + 1).match(/^[A-Za-z]+/)?.[0];
      if (!name) {
        const next = text[i + 1] ?? '';
        push(next === '\\' ? ' ' : SYMBOLS[next] ?? next);
        i += 2;
        continue;
      }
      i += 1 + name.length;
      if (['frac', 'dfrac', 'tfrac'].includes(name)) {
        const top = group(text, i);
        const bottom = group(text, top.end);
        out.push(...bracket(latexToParts(top.body)), '/', ...bracket(latexToParts(bottom.body)));
        i = bottom.end;
      } else if (name === 'sqrt') {
        const inner = group(text, i);
        out.push('√', ...bracket(latexToParts(inner.body)));
        i = inner.end;
      } else if (['text', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'operatorname', 'textrm', 'textit', 'textbf', 'boldsymbol'].includes(name)) {
        const inner = group(text, i);
        if (name.startsWith('text')) push(inner.body);
        else out.push(...latexToParts(inner.body));
        i = inner.end;
      } else if (['vec', 'hat', 'bar', 'dot', 'ddot', 'tilde', 'overline'].includes(name)) {
        const inner = group(text, i);
        const mark = { vec: '⃗', hat: '̂', bar: '̄', overline: '̄', dot: '̇', ddot: '̈', tilde: '̃' }[name];
        push(flattenMath(latexToParts(inner.body)) + mark);
        i = inner.end;
      } else if (['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'limits', 'nolimits'].includes(name)) {
        // Sizing only: nothing to show.
      } else {
        push(SYMBOLS[name] ?? `\\${name}`);
        if (BINDING.has(name)) {
          let next = i;
          while (text[next] === ' ') next += 1;
          if (/[A-Za-z\\]/.test(text[next] ?? '')) i = next;
        }
      }
      continue;
    }
    if (char === '^' || char === '_') {
      const inner = group(text, i + 1);
      out.push(char === '^' ? { sup: latexToParts(inner.body) } : { sub: latexToParts(inner.body) });
      i = inner.end;
      continue;
    }
    if (char === '{' || char === '}') { i += 1; continue; }
    push(char === '-' ? '−' : char === '~' ? ' ' : char);
    i += 1;
  }
  // Join neighbouring text and tidy its spaces.
  const merged = [];
  for (const part of out) {
    if (typeof part === 'string' && typeof merged.at(-1) === 'string') merged[merged.length - 1] += part;
    else merged.push(part);
  }
  const tidy = merged.map(part => (typeof part === 'string' ? part.replace(/[ \t]+/g, ' ') : part));
  if (typeof tidy[0] === 'string') tidy[0] = tidy[0].trimStart();
  if (typeof tidy.at(-1) === 'string') tidy[tidy.length - 1] = tidy.at(-1).trimEnd();
  return tidy.filter(part => part !== '');
}

/** One LaTeX maths expression as plain text. */
export function latexToText(source) {
  return flattenMath(latexToParts(source));
}

/** Whether "$…$" content is maths, not two prices ("$5 and $10"). */
export function looksLikeMath(content) {
  const value = String(content ?? '');
  if (/^\d[\d.,\s]*$/.test(value)) return false;
  return /\\[A-Za-z]|[\^_=<>]|^[A-Za-z]$|[A-Za-z]\s*[+\-*/]\s*[A-Za-z0-9]/.test(value);
}
