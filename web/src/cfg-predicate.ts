/**
 * Rust `#[cfg(...)]` predicates, as probe-rust emits them in an atom's `cfg`
 * field: the function's own gate joined with every enclosing `impl`/`mod`
 * gate and the `mod` declarations that mount its file.
 *
 * The viewer only asks one question: is the function compiled only in test
 * builds? It evaluates the predicate with `test` set to false and every other
 * flag (features, target_arch, ...) unknown, using three-valued logic. Only a
 * definite false means "test-only". Mirrors probe-aeneas `cfg_eval.rs`.
 */

type CfgExpr =
  | { op: 'flag'; name: string }
  | { op: 'pair'; key: string; value: string }
  | { op: 'all' | 'any'; items: CfgExpr[] }
  | { op: 'not'; item: CfgExpr };

type Token = { t: 'ident'; v: string } | { t: 'str'; v: string } | { t: '(' | ')' | ',' | '=' };

function tokenize(s: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',' || c === '=') { tokens.push({ t: c }); i++; continue; }
    if (c === '"') {
      let v = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        v += s[i++];
      }
      if (i >= s.length) return null;
      i++;
      tokens.push({ t: 'str', v });
      continue;
    }
    // Raw string: r"..." or r#"..."#, closed by a quote and the same number
    // of hashes, with no escapes
    const raw = /^r(#*)"/.exec(s.slice(i));
    if (raw) {
      const close = '"' + raw[1];
      const start = i + raw[0].length;
      const end = s.indexOf(close, start);
      if (end < 0) return null;
      tokens.push({ t: 'str', v: s.slice(start, end) });
      i = end + close.length;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) return null;
    tokens.push({ t: 'ident', v: m[0] });
    i += m[0].length;
  }
  return tokens;
}

/** Parse a predicate; null when malformed (callers then decide nothing). */
function parseCfg(s: string): CfgExpr | null {
  const parsed = tokenize(s);
  if (!parsed) return null;
  const tokens: Token[] = parsed;
  let pos = 0;
  const peek = () => tokens[pos];

  function expr(): CfgExpr | null {
    const tok = tokens[pos++];
    if (!tok || tok.t !== 'ident') return null;
    const name = tok.v;
    if (peek()?.t === '=') {
      pos++;
      const value = tokens[pos++];
      return value?.t === 'str' ? { op: 'pair', key: name, value: value.v } : null;
    }
    if (peek()?.t !== '(') return { op: 'flag', name };
    if (name !== 'all' && name !== 'any' && name !== 'not') return null;
    pos++;
    const items: CfgExpr[] = [];
    while (peek() && peek().t !== ')') {
      const item = expr();
      if (!item) return null;
      items.push(item);
      if (peek()?.t === ',') pos++;
      else if (peek()?.t !== ')') return null;
    }
    if (peek()?.t !== ')') return null;
    pos++;
    if (name === 'not') return items.length === 1 ? { op: 'not', item: items[0] } : null;
    return { op: name, items };
  }

  const result = expr();
  // `#[cfg(test,)]` is valid Rust: allow one trailing comma at the top level
  if (peek()?.t === ',') pos++;
  return result && pos === tokens.length ? result : null;
}

/** true / false when decided, undefined when it depends on an unknown flag. */
function evalWithoutTest(e: CfgExpr): boolean | undefined {
  switch (e.op) {
    case 'flag': return e.name === 'test' ? false : undefined;
    case 'pair': return undefined;
    case 'not': {
      const v = evalWithoutTest(e.item);
      return v === undefined ? undefined : !v;
    }
    case 'all': {
      let decided = true;
      for (const item of e.items) {
        const v = evalWithoutTest(item);
        if (v === false) return false;
        if (v === undefined) decided = false;
      }
      return decided ? true : undefined;
    }
    case 'any': {
      let decided = true;
      for (const item of e.items) {
        const v = evalWithoutTest(item);
        if (v === true) return true;
        if (v === undefined) decided = false;
      }
      return decided ? false : undefined;
    }
  }
}

/**
 * Whether a `cfg` predicate compiles the item only in test builds: it is
 * definitely false when `test` is off, whatever the features and target.
 * `not(test)`, `feature = "test-utils"` and `any(test, feature = "x")` are
 * not test-only. A missing or malformed predicate is not test-only.
 */
export function isTestOnlyCfg(predicate: string | undefined): boolean {
  if (!predicate) return false;
  const expr = parseCfg(predicate);
  return expr !== null && evalWithoutTest(expr) === false;
}
