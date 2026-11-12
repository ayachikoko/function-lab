/* 函数实验室 — app logic */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const PALETTE = ['#ff7ab8', '#5eead4', '#fbbf24', '#a78bfa', '#60a5fa', '#fb7185', '#4ade80', '#f97316'];
  const CONSTS = new Set(['e', 'pi', 'tau', 'i', 'Infinity', 'NaN', 'true', 'false', 'null', 'undefined']);
  const FN_NAMES = new Set([
    'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'asin', 'acos', 'atan', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'sqrt', 'cbrt', 'nthRoot', 'abs', 'exp',
    'log', 'log10', 'log2', 'ln', 'floor', 'ceil', 'round', 'sign', 'min', 'max', 'mod', 'gcd', 'lcm',
    'factorial', 'gamma', 'erf',
  ]);

  const state = {
    funcs: [],
    params: {},
    activeId: null,
    nextId: 1,
    plot: null,
    ocrImage: null,
    ocrWorkerPromise: null,
    paramSig: '',
    recomputeTimer: 0,
    limitTimer: 0,
    lastLimit: null,
  };

  /* ------------------------------------------------------------------ *
   * Math engine
   * ------------------------------------------------------------------ */

  const MathEngine = (() => {
    let bigMath = null;
    const bigCache = new Map();
    try {
      if (math.create) {
        bigMath = math.all ? math.create(math.all) : math.create();
        bigMath.config({ number: 'BigNumber', precision: 64 });
      }
    } catch (err) {
      bigMath = null;
    }

    function friendlyError(err) {
      const msg = String(err && err.message ? err.message : err);
      if (/Undefined symbol/i.test(msg)) {
        const m = msg.match(/Undefined symbol\s+(\S+)/i);
        return `未定义的符号${m ? '：' + m[1] : ''}`;
      }
      if (/Unexpected end/i.test(msg)) return '表达式不完整，检查括号';
      if (/Value expected/i.test(msg)) return '表达式格式有误';
      if (/Parenthesis\) expected/i.test(msg) || /Parenthesis.*expected/i.test(msg)) return '括号不匹配';
      if (/Unknown function/i.test(msg)) return msg.replace(/Unknown function/i, '未知函数');
      return msg;
    }

    function normalize(raw) {
      let s = String(raw == null ? '' : raw).trim();
      if (!s) return '';
      s = s.replace(/[×·⋅✕]/g, '*')
        .replace(/[÷]/g, '/')
        .replace(/[−–—]/g, '-')
        .replace(/π/g, 'pi')
        .replace(/∞/g, 'Infinity')
        .replace(/√/g, 'sqrt')
        .replace(/[（]/g, '(')
        .replace(/[）]/g, ')')
        .replace(/[［\[]/g, '(')
        .replace(/[］\]]/g, ')')
        .replace(/[｛{]/g, '(')
        .replace(/[｝}]/g, ')')
        .replace(/，/g, ',')
        .replace(/²/g, '^2')
        .replace(/³/g, '^3')
        .replace(/⁴/g, '^4')
        .replace(/⁵/g, '^5')
        .replace(/[“”"'`]/g, '');

      s = s.replace(/^\s*(?:y|f\s*\(\s*x\s*\)|g\s*\(\s*x\s*\))\s*=/i, '');
      s = s.replace(/^\s*=\s*/, '');

      // |x| -> abs(x)
      s = s.replace(/\|([^|]{1,80})\|/g, 'abs($1)');

      // natural log spelled ln
      s = s.replace(/\bln\s*\(/gi, 'log(');
      s = s.replace(/\bln\b/gi, 'log');

      // inverse trig aliases
      s = s.replace(/\barcsin\b/gi, 'asin').replace(/\barccos\b/gi, 'acos').replace(/\barctan\b/gi, 'atan');

      // sin x -> sin(x)
      const fnAlt = [...FN_NAMES].sort((a, b) => b.length - a.length).join('|');
      const reFnSpace = new RegExp(`\\b(${fnAlt})\\s+([A-Za-z0-9.]+)`, 'gi');
      s = s.replace(reFnSpace, (m, fn, atom) => `${fn}(${atom})`);

      return implicitMul(s);
    }

    function implicitMul(s) {
      const re = /(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[+\-*/^(),%!]|\S/g;
      const rawToks = s.match(re) || [];
      if (!rawToks.length) return s;

      const toks = rawToks.map((v) => {
        if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return { t: 'num', v };
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return { t: 'id', v };
        if (v === '(') return { t: 'open', v };
        if (v === ')') return { t: 'close', v };
        if (v === ',') return { t: 'comma', v };
        return { t: 'op', v };
      });

      const out = [];
      for (let i = 0; i < toks.length; i++) {
        const prev = toks[i - 1];
        const cur = toks[i];
        if (prev) {
          const prevOperand = prev.t === 'num' || prev.t === 'id' || prev.t === 'close';
          const curOperand = cur.t === 'num' || cur.t === 'id' || cur.t === 'open';
          // Known functions are calls. Multi-letter identifiers followed by "(" are
          // treated as calls too, so an unknown function is reported instead of
          // silently becoming a multiplication. Single letters (x, a, …) still
          // support GeoGebra-style x(y + 1).
          const fnCall = prev.t === 'id' && cur.t === 'open' &&
            (FN_NAMES.has(prev.v.toLowerCase()) || prev.v.length > 1);
          if (prevOperand && curOperand && !fnCall) out.push('*');
        }
        out.push(cur.v);
      }
      return out.join('');
    }

    function analyze(raw) {
      const input = String(raw == null ? '' : raw).trim();
      if (!input) return { ok: false, empty: true, error: '' };
      const expr = normalize(input);
      let node;
      try {
        node = math.parse(expr);
      } catch (err) {
        return { ok: false, error: friendlyError(err), expr, raw: input };
      }

      const params = new Set();
      let badFn = '';
      node.traverse((n, path, parent) => {
        if (!n.isSymbolNode) return;
        if (parent && parent.isFunctionNode && parent.fn === n) {
          if (typeof math[n.name] !== 'function') badFn = n.name;
          return;
        }
        if (n.name !== 'x' && !CONSTS.has(n.name)) params.add(n.name);
      });
      if (badFn) return { ok: false, error: `未知函数：${badFn}`, expr, raw: input };

      let compiled;
      try {
        compiled = node.compile();
      } catch (err) {
        return { ok: false, error: friendlyError(err), expr, raw: input };
      }

      return { ok: true, node, compiled, expr, params: [...params].sort(), raw: input };
    }

    function derivative(raw, order = 1) {
      const a = analyze(raw);
      if (!a.ok) return { ok: false, error: a.error };
      let node = a.node;
      try {
        for (let i = 0; i < order; i++) node = math.derivative(node, 'x');
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
      let out = node;
      try {
        out = math.simplify(node);
      } catch (err) {
        out = node;
      }
      let str;
      try {
        str = out.toString();
      } catch (err) {
        str = node.toString();
      }
      return { ok: true, expr: str };
    }

    function bignum(v) {
      if (bigMath) return bigMath.bignumber(String(v));
      return math.bignumber(String(v));
    }

    function getBigCompiled(expr) {
      if (!bigMath) return null;
      if (bigCache.has(expr)) return bigCache.get(expr);
      let c = null;
      try {
        c = bigMath.parse(expr).compile();
      } catch (err) {
        c = null;
      }
      bigCache.set(expr, c);
      return c;
    }

    function evalBig(compiled, xBig, params) {
      const scope = { x: xBig };
      for (const k of Object.keys(params)) {
        scope[k] = bignum(params[k]);
      }
      try {
        const r = compiled.evaluate(scope);
        if (r && r.isBigNumber) return r.toNumber();
        if (r && r.isComplex) return NaN;
        return Number(r);
      } catch (err) {
        return NaN;
      }
    }

    function analyseSide(vals) {
      const lastSample = vals[vals.length - 1];
      if (lastSample === Infinity || lastSample === -Infinity) {
        return { type: lastSample > 0 ? 'inf' : '-inf', value: lastSample };
      }
      const finite = vals.filter((v) => Number.isFinite(v));
      if (!finite.length) return { type: 'undefined' };
      if (finite.length < 3) return { type: 'unstable', value: finite[finite.length - 1] };

      const tail = finite.slice(-5);
      const last = tail[tail.length - 1];
      const absLast = Math.abs(last);
      const diffs = [];
      for (let i = 1; i < tail.length; i++) diffs.push(tail[i] - tail[i - 1]);

      const bigValues = tail.filter((v) => Math.abs(v) > 1e7).length;
      if (bigValues >= 3) {
        let signChanges = 0;
        for (let i = 1; i < tail.length; i++) {
          if ((tail[i] > 0) !== (tail[i - 1] > 0)) signChanges++;
        }
        if (signChanges >= 2) return { type: 'oscillate' };
        const growing = Math.abs(tail[tail.length - 1]) > Math.abs(tail[0]) * 5;
        if (growing) return { type: last > 0 ? 'inf' : '-inf', value: last };
      }

      // slow divergence: ln x -> -inf, sqrt x -> +inf
      if (absLast > 20 && diffs.length >= 4) {
        const sameSign = diffs.every((d) => d > 0) || diffs.every((d) => d < 0);
        const total = Math.abs(tail[tail.length - 1] - tail[0]);
        if (sameSign && total > 1) {
          return { type: last > 0 ? 'inf' : '-inf', value: last };
        }
      }

      const d = Math.abs(diffs[diffs.length - 1]);
      const tol = Math.max(1e-7, absLast * 1e-7);
      if (d <= tol) return { type: 'finite', value: last, diff: d };
      return { type: 'unstable', value: last };
    }

    function finiteSamples(x0, dir, bigCompiled, params) {
      const out = [];
      const base = bignum(x0.toPrecision(17));
      for (let k = 3; k <= 15; k++) {
        const hs = `1e-${k}`;
        const signed = dir < 0 ? `-${hs}` : hs;
        const xb = bigMath ? bigMath.add(base, bignum(signed)) : math.add(base, bignum(signed));
        out.push({ x: Number(xb), y: evalBig(bigCompiled, xb, params), h: hs });
      }
      return out;
    }

    function infiniteSamples(dir, bigCompiled, params) {
      const out = [];
      for (let k = 2; k <= 15; k++) {
        const xb = bignum(`${dir < 0 ? '-' : ''}1e${k}`);
        out.push({ x: Number(xb), y: evalBig(bigCompiled, xb, params), h: `1e${k}` });
      }
      return out;
    }

    function limit(raw, pointStr, dir, params) {
      const a = analyze(raw);
      if (!a.ok) return { ok: false, error: a.error || '函数无效' };
      const bigCompiled = getBigCompiled(a.expr) || a.compiled;

      let x0 = 0;
      let pointValue = null;
      if (dir !== 'pinf' && dir !== 'ninf') {
        try {
          const pExpr = normalize(pointStr.trim() || '0');
          pointValue = math.evaluate(pExpr);
          x0 = Number(pointValue);
        } catch (err) {
          return { ok: false, error: '趋近点无效，试试 0、1、pi/2' };
        }
        if (!Number.isFinite(x0)) return { ok: false, error: '趋近点必须是有限数' };
      }

      const sides = {};
      const sideSamples = {};

      if (dir === 'both' || dir === 'left') {
        const s = finiteSamples(x0, -1, bigCompiled, params);
        sideSamples.left = s;
        sides.left = analyseSide(s.map((v) => v.y));
      }
      if (dir === 'both' || dir === 'right') {
        const s = finiteSamples(x0, 1, bigCompiled, params);
        sideSamples.right = s;
        sides.right = analyseSide(s.map((v) => v.y));
      }
      if (dir === 'pinf' || dir === 'ninf') {
        const s = infiniteSamples(dir === 'ninf' ? -1 : 1, bigCompiled, params);
        sideSamples.inf = s;
        sides.inf = analyseSide(s.map((v) => v.y));
      }

      let status = 'undefined';
      let value = NaN;
      let note = '';

      if (dir === 'both') {
        const L = sides.left;
        const R = sides.right;
        if (L.type === 'undefined' && R.type === 'undefined') {
          status = 'undefined';
          note = '左右两侧都没有定义，检查函数定义域。';
        } else if (L.type === 'undefined' || R.type === 'undefined') {
          const S = L.type === 'undefined' ? R : L;
          const which = L.type === 'undefined' ? '左' : '右';
          if (S.type === 'finite') {
            status = 'finite'; value = S.value;
            note = `${which}侧无定义，仅${which === '左' ? '右' : '左'}极限存在：${fmtNum(S.value)}。`;
          } else if (S.type === 'inf' || S.type === '-inf') {
            status = S.type; note = `${which}侧无定义，单侧发散。`;
          } else {
            status = 'unstable'; note = `${which}侧无定义，另一侧未收敛。`;
          }
        } else if (L.type === 'finite' && R.type === 'finite') {
          const diff = Math.abs(L.value - R.value);
          const tol = Math.max(1e-5, Math.max(Math.abs(L.value), Math.abs(R.value)) * 1e-5);
          if (diff <= tol) {
            status = 'finite';
            value = (L.value + R.value) / 2;
          } else {
            status = 'dne';
            note = `左右极限不相等：左 = ${fmtNum(L.value)}，右 = ${fmtNum(R.value)}。`;
          }
        } else if ((L.type === 'inf' && R.type === 'inf') || (L.type === '-inf' && R.type === '-inf')) {
          status = L.type;
          value = L.type === 'inf' ? Infinity : -Infinity;
        } else if (L.type === 'inf' || L.type === '-inf' || R.type === 'inf' || R.type === '-inf') {
          status = 'dne';
          note = `一侧发散：左 = ${sideText(L)}，右 = ${sideText(R)}。`;
        } else {
          status = 'unstable';
          note = '采样未收敛，极限可能不存在或函数在该点剧烈振荡。';
        }
      } else if (dir === 'left' || dir === 'right') {
        const S = dir === 'left' ? sides.left : sides.right;
        const name = dir === 'left' ? '左极限' : '右极限';
        if (S.type === 'finite') { status = 'finite'; value = S.value; }
        else if (S.type === 'inf' || S.type === '-inf') { status = S.type; value = S.type === 'inf' ? Infinity : -Infinity; }
        else if (S.type === 'undefined') { status = 'undefined'; note = `${name}处函数无定义。`; }
        else { status = 'unstable'; note = '该侧采样未收敛，极限可能不存在。'; }
      } else {
        const S = sides.inf;
        if (S.type === 'finite') { status = 'finite'; value = S.value; }
        else if (S.type === 'inf' || S.type === '-inf') { status = S.type; value = S.type === 'inf' ? Infinity : -Infinity; }
        else { status = 'unstable'; note = '趋于无穷远时未检测到稳定极限。'; }
      }

      return {
        ok: true,
        status, value, note,
        sides, sideSamples,
        expr: a.expr,
        dir, pointStr, x0,
        params: { ...params },
      };
    }

    return { analyze, derivative, limit, normalize, friendlyError };
  })();

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  function fmtNum(v) {
    if (v === Infinity) return '+∞';
    if (v === -Infinity) return '−∞';
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) < 1e-12) return '0';
    if (Math.abs(v) >= 1e9 || Math.abs(v) < 1e-6) return v.toExponential(4).replace('e+', 'e');
    return String(Number(v.toPrecision(8)));
  }

  function sideText(s) {
    if (!s) return '—';
    if (s.type === 'finite') return fmtNum(s.value);
    if (s.type === 'inf') return '+∞';
    if (s.type === '-inf') return '−∞';
    if (s.type === 'undefined') return '无定义';
    return '未收敛';
  }

  function fmtCoord(v) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) < 1e-6 || Math.abs(v) >= 1e6) return v.toExponential(3).replace('e+', 'e');
    return String(Number(v.toPrecision(5)));
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const escAttr = escapeHtml;

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function nextColor() {
    const used = new Set(state.funcs.map((f) => f.color));
    for (const c of PALETTE) if (!used.has(c)) return c;
    return PALETTE[state.funcs.length % PALETTE.length];
  }

  function findFn(id) { return state.funcs.find((f) => f.id === id) || null; }

  function activeFn() {
    return findFn(state.activeId) || state.funcs.find((f) => f.analysis && f.analysis.ok) || state.funcs[0] || null;
  }

  function currentParams() {
    const out = {};
    for (const k of Object.keys(state.params)) out[k] = state.params[k].value;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * function rows
   * ------------------------------------------------------------------ */

  const fnList = $('#fnList');

  function renderFnList(focusId) {
    fnList.innerHTML = state.funcs.map((f) => {
      const badge = f.kind === 'nderiv' ? '<span class="fn-badge">f′ 数值</span>'
        : f.kind === 'deriv' ? '<span class="fn-badge">f′</span>' : '';
      return `
        <div class="fn-row ${f.visible ? '' : 'hidden-fn'} ${f.id === state.activeId ? 'active' : ''}" data-id="${f.id}">
          <button class="color-dot" data-act="color" style="--c:${f.color}" title="切换颜色" aria-label="切换颜色"></button>
          <div class="fn-main">
            <input class="fn-input" value="${escAttr(f.input)}" placeholder="例如 sin(x)/x 或 a*x^2" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="函数表达式">
            ${badge}
            <div class="fn-err" hidden></div>
          </div>
          <div class="fn-tools">
            <button data-act="eye" title="显示 / 隐藏">${f.visible ? '◉' : '○'}</button>
            <button data-act="deriv" title="对这个函数求导">ƒ′</button>
            <button data-act="del" title="删除">✕</button>
          </div>
        </div>`;
    }).join('');

    for (const f of state.funcs) updateRowStatus(f);
    if (focusId) {
      const input = fnList.querySelector(`.fn-row[data-id="${focusId}"] .fn-input`);
      if (input) { input.focus(); input.select(); }
    }
  }

  function updateRowStatus(f) {
    const row = fnList.querySelector(`.fn-row[data-id="${f.id}"]`);
    if (!row) return;
    const errEl = row.querySelector('.fn-err');
    if (f.error) {
      errEl.textContent = f.error;
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }
    row.classList.toggle('hidden-fn', !f.visible);
    row.classList.toggle('active', f.id === state.activeId);
    const eye = row.querySelector('[data-act="eye"]');
    if (eye) eye.textContent = f.visible ? '◉' : '○';
  }

  function setActive(id) {
    state.activeId = id;
    for (const f of state.funcs) updateRowStatus(f);
  }

  function addFunc(input, opts = {}) {
    const f = {
      id: state.nextId++,
      input: String(input || ''),
      visible: opts.visible !== false,
      color: opts.color || nextColor(),
      kind: opts.kind || 'fn',
      order: opts.order || 1,
      analysis: null,
      error: '',
    };
    state.funcs.push(f);
    state.activeId = f.id;
    renderFnList(opts.focus ? f.id : null);
    if (!opts.silent) recompute();
    return f;
  }

  function removeFunc(id) {
    const i = state.funcs.findIndex((f) => f.id === id);
    if (i < 0) return;
    state.funcs.splice(i, 1);
    if (!state.funcs.length) {
      state.funcs.push({ id: state.nextId++, input: '', visible: true, color: PALETTE[0], kind: 'fn', order: 1, analysis: null, error: '' });
    }
    if (state.activeId === id) state.activeId = state.funcs[Math.min(i, state.funcs.length - 1)].id;
    renderFnList();
    recompute();
  }

  fnList.addEventListener('input', (e) => {
    const input = e.target.closest('.fn-input');
    if (!input) return;
    const row = input.closest('.fn-row');
    const f = findFn(Number(row.dataset.id));
    if (!f) return;
    f.input = input.value;
    if (f.kind === 'nderiv') {
      f.kind = 'fn';
      const badge = row.querySelector('.fn-badge');
      if (badge) badge.remove();
    }
    setActive(f.id);
    scheduleRecompute();
  });

  fnList.addEventListener('focusin', (e) => {
    const row = e.target.closest('.fn-row');
    if (row) setActive(Number(row.dataset.id));
  });

  fnList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('fn-input')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  fnList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.fn-row');
    const f = findFn(Number(row.dataset.id));
    if (!f) return;
    const act = btn.dataset.act;
    if (act === 'del') {
      removeFunc(f.id);
    } else if (act === 'eye') {
      f.visible = !f.visible;
      updateRowStatus(f);
      refreshPlots();
    } else if (act === 'color') {
      const idx = PALETTE.indexOf(f.color);
      f.color = PALETTE[(idx + 1) % PALETTE.length];
      row.querySelector('.color-dot').style.setProperty('--c', f.color);
      refreshPlots();
    } else if (act === 'deriv') {
      setActive(f.id);
      addDerivativeFor(f, 1);
    }
  });

  /* ------------------------------------------------------------------ *
   * parameters
   * ------------------------------------------------------------------ */

  const paramList = $('#paramList');

  function renderParams(used) {
    const names = [...used].sort();
    for (const name of names) {
      if (!state.params[name]) state.params[name] = { value: 1, min: -5, max: 5 };
      const p = state.params[name];
      if (Number.isFinite(p.value) && (p.value < p.min || p.value > p.max)) {
        const pad = Math.max(1, Math.abs(p.value) * 0.2);
        p.min = Math.min(p.min, p.value - pad);
        p.max = Math.max(p.max, p.value + pad);
      }
    }
    const sig = names.join('|');
    if (sig !== state.paramSig) {
      state.paramSig = sig;
      paramList.innerHTML = names.map((name) => {
        const p = state.params[name];
        return `
          <div class="param-row" data-param="${escAttr(name)}">
            <div class="param-top">
              <span class="param-name">${escapeHtml(name)}</span>
              <input class="param-val" type="number" step="0.01" value="${p.value}" aria-label="参数 ${escAttr(name)} 的值">
            </div>
            <input type="range" min="${p.min}" max="${p.max}" step="0.01" value="${p.value}" aria-label="拖动参数 ${escAttr(name)}">
          </div>`;
      }).join('');
    } else {
      for (const name of names) {
        const p = state.params[name];
        const row = paramList.querySelector(`.param-row[data-param="${CSS.escape(name)}"]`);
        if (!row) continue;
        const num = row.querySelector('.param-val');
        const range = row.querySelector('input[type="range"]');
        if (num && document.activeElement !== num) num.value = String(Number(p.value.toFixed(6)));
        if (range) range.value = String(p.value);
      }
    }
    $('#paramEmpty').hidden = names.length > 0;
    $('#paramHint').textContent = names.length ? `${names.length} 个` : '自动识别';
  }

  paramList.addEventListener('input', (e) => {
    const row = e.target.closest('.param-row');
    if (!row) return;
    const name = row.dataset.param;
    const p = state.params[name];
    if (!p) return;
    const num = row.querySelector('.param-val');
    const range = row.querySelector('input[type="range"]');
    let v;
    if (e.target === range) {
      v = Number(range.value);
      if (num) num.value = String(Number(v.toFixed(4)));
    } else {
      v = Number(num.value);
      if (!Number.isFinite(v)) return;
      if (v < p.min || v > p.max) {
        const pad = Math.max(1, Math.abs(v) * 0.2);
        p.min = Math.min(p.min, v - pad);
        p.max = Math.max(p.max, v + pad);
        range.min = String(p.min);
        range.max = String(p.max);
      }
      range.value = String(v);
    }
    p.value = v;
    refreshPlots();
    scheduleLimit(260);
  });

  /* ------------------------------------------------------------------ *
   * recompute / plot
   * ------------------------------------------------------------------ */

  function scheduleRecompute() {
    clearTimeout(state.recomputeTimer);
    state.recomputeTimer = setTimeout(recompute, 240);
  }

  function recompute() {
    if (!state.plot) return;
    const used = new Set();
    for (const f of state.funcs) {
      if (!f.input.trim()) {
        f.analysis = { ok: false, empty: true, error: '' };
        f.error = '';
        continue;
      }
      const a = MathEngine.analyze(f.input);
      f.analysis = a;
      f.error = a.ok ? '' : (a.error || '表达式有误');
      if (a.ok) {
        for (const p of a.params) used.add(p);
      }
    }
    renderParams(used);
    refreshPlots();
    for (const f of state.funcs) updateRowStatus(f);
  }

  function makeEvalX(f, params) {
    const a = f.analysis;
    const scope = { ...params };
    if (f.kind === 'nderiv') {
      const order = f.order === 2 ? 2 : 1;
      return (x) => {
        const h = (order === 2 ? 1e-3 : 1e-5) * Math.max(1, Math.abs(x));
        const ev = (xx) => {
          scope.x = xx;
          try {
            const r = a.compiled.evaluate(scope);
            if (r && r.isBigNumber) return r.toNumber();
            if (r && r.isComplex) return NaN;
            return Number(r);
          } catch (err) {
            return NaN;
          }
        };
        if (order === 1) return (ev(x + h) - ev(x - h)) / (2 * h);
        return (-ev(x + 2 * h) + 16 * ev(x + h) - 30 * ev(x) + 16 * ev(x - h) - ev(x - 2 * h)) / (12 * h * h);
      };
    }
    return (x) => {
      scope.x = x;
      try {
        const r = a.compiled.evaluate(scope);
        if (r && r.isBigNumber) return r.toNumber();
        if (r && r.isComplex) return NaN;
        return Number(r);
      } catch (err) {
        return NaN;
      }
    };
  }

  function refreshPlots() {
    if (!state.plot) return;
    const pv = currentParams();
    const plotted = [];
    for (const f of state.funcs) {
      if (!f.analysis || !f.analysis.ok) continue;
      plotted.push({
        id: f.id,
        evalX: makeEvalX(f, pv),
        color: f.color,
        visible: f.visible,
        kind: f.kind,
        dash: f.kind === 'nderiv' ? 1 : undefined,
      });
    }
    state.plot.setFunctions(plotted);
  }

  /* ------------------------------------------------------------------ *
   * derivative
   * ------------------------------------------------------------------ */

  function addDerivativeFor(f, order) {
    if (!f) { toast('先选中一个函数'); return; }
    if (!f.analysis || !f.analysis.ok) { toast('这个函数还不能求导，先修正表达式'); return; }
    const res = MathEngine.derivative(f.input, order);
    if (res.ok) {
      addFunc(res.expr, { kind: 'deriv', color: nextColor(), focus: false });
      toast(order === 2 ? '已加入二阶导函数' : '已加入导函数 f′(x)');
    } else {
      addFunc(f.input, { kind: 'nderiv', order, color: nextColor() });
      toast('符号求导失败，已改用数值导数');
    }
  }

  $('#btnDeriv').addEventListener('click', () => addDerivativeFor(activeFn(), 1));
  $('#btnDeriv2').addEventListener('click', () => addDerivativeFor(activeFn(), 2));

  /* ------------------------------------------------------------------ *
   * limit
   * ------------------------------------------------------------------ */

  const limitResult = $('#limitResult');

  function scheduleLimit(ms) {
    clearTimeout(state.limitTimer);
    state.limitTimer = setTimeout(() => {
      if (!limitResult.classList.contains('hidden')) runLimit();
    }, ms);
  }

  function runLimit() {
    const f = activeFn();
    if (!f) { toast('先选中一个函数'); return; }
    if (!f.analysis || !f.analysis.ok) { toast('函数表达式无效'); return; }
    const dir = $('#limitDir').value;
    const point = $('#limitPoint').value || '0';
    const activeParams = {};
    for (const name of (f.analysis.params || [])) {
      activeParams[name] = state.params[name] ? state.params[name].value : 1;
    }
    const res = MathEngine.limit(f.input, point, dir, activeParams);
    state.lastLimit = res;

    if (!res.ok) {
      limitResult.classList.remove('hidden');
      limitResult.innerHTML = `<div class="result-head"><span class="result-label">极限</span><span class="result-value bad">${escapeHtml(res.error || '无法计算')}</span></div>`;
      return;
    }

    let valueText;
    let bad = false;
    if (res.status === 'finite') valueText = fmtNum(res.value);
    else if (res.status === 'inf') valueText = '+∞';
    else if (res.status === '-inf') valueText = '−∞';
    else if (res.status === 'dne') { valueText = '不存在'; bad = true; }
    else if (res.status === 'undefined') { valueText = '无定义'; bad = true; }
    else { valueText = '未检测到极限'; bad = true; }

    const dirLabel = dir === 'pinf' ? 'x → +∞'
      : dir === 'ninf' ? 'x → −∞'
      : dir === 'left' ? `x → ${escapeHtml(point)}⁻`
      : dir === 'right' ? `x → ${escapeHtml(point)}⁺`
      : `x → ${escapeHtml(point)}`;

    const paramNames = Object.keys(res.params);
    let paramNote = '';
    if (paramNames.length) {
      paramNote = '当前参数：' + paramNames.map((k) => `${k} = ${fmtNum(res.params[k])}`).join('，') + '。拖动滑块可看极限如何随参数变化。';
    }

    let note = res.note || '';
    const method = '数值估算（高精度采样），用于快速判断，不等同于符号证明。';

    const rows = [];
    const addSide = (samples, tag) => {
      if (!samples) return;
      const tail = samples.slice(-2);
      for (const s of tail) {
        rows.push(`<tr><td>${tag} ${escapeHtml(fmtCoord(s.x))}</td><td>${escapeHtml(fmtNum(s.y))}</td></tr>`);
      }
    };
    addSide(res.sideSamples.left, '左');
    addSide(res.sideSamples.right, '右');
    addSide(res.sideSamples.inf, res.dir === 'ninf' ? '−∞' : '+∞');

    const table = rows.length ? `
      <details class="samples">
        <summary>采样值（单击展开）</summary>
      <table>
        <thead><tr><th>采样 x</th><th>f(x)</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      </details>` : '';

    limitResult.classList.remove('hidden');
    limitResult.innerHTML = `
      <div class="result-head">
        <span class="result-label">lim ${dirLabel} f(x)</span>
        <span class="result-value ${bad ? 'bad' : ''}">${escapeHtml(valueText)}</span>
      </div>
      ${note || paramNote ? `<div class="result-note">${escapeHtml(note)}${note && paramNote ? '<br>' : ''}${escapeHtml(paramNote)}</div>` : ''}
      ${table}
      <div class="result-note">${escapeHtml(method)}</div>
    `;
  }

  $('#btnLimit').addEventListener('click', runLimit);
  $('#limitDir').addEventListener('change', () => {
    const dir = $('#limitDir').value;
    $('#limitPoint').disabled = dir === 'pinf' || dir === 'ninf';
    if (!limitResult.classList.contains('hidden')) runLimit();
  });
  $('#limitPoint').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runLimit();
  });

  /* ------------------------------------------------------------------ *
   * toolbar / view
   * ------------------------------------------------------------------ */

  $$('.plot-toolbar [data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const z = btn.dataset.zoom;
      const f = 1.4;
      if (z === 'xin') state.plot.zoomCenter(f, 1);
      else if (z === 'xout') state.plot.zoomCenter(1 / f, 1);
      else if (z === 'yin') state.plot.zoomCenter(1, f);
      else if (z === 'yout') state.plot.zoomCenter(1, 1 / f);
      else if (z === 'in') state.plot.zoomCenter(f, f);
      else if (z === 'out') state.plot.zoomCenter(1 / f, 1 / f);
    });
  });

  $('#btnReset').addEventListener('click', () => state.plot.resetView());

  $('#btnPng').addEventListener('click', () => {
    const d = new Date();
    const name = `function-plot-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.png`;
    state.plot.exportPNG(name);
    toast('图像已导出');
  });

  const canvas = $('#plot');
  const readout = $('#readout');

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = state.plot.pxToX(e.clientX - rect.left);
    const y = state.plot.pxToY(e.clientY - rect.top);
    readout.textContent = `x = ${fmtCoord(x)}　y = ${fmtCoord(y)}`;
  });

  canvas.addEventListener('pointerleave', () => {
    readout.textContent = 'x = 0　y = 0';
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen?.();
      if (p && p.catch) p.catch(() => toast('浏览器不允许全屏'));
    } else {
      document.exitFullscreen?.();
    }
  }
  $('#btnFull').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    updateFullscreenIcon();
    setTimeout(() => state.plot.resize(), 120);
  });

  /* ------------------------------------------------------------------ *
   * add / preset / clear / share
   * ------------------------------------------------------------------ */

  $('#btnAdd').addEventListener('click', () => addFunc('', { focus: true, silent: true }));

  $('#presetSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    addFunc(v, { focus: false });
  });

  $('#btnClear').addEventListener('click', () => {
    if (!confirm('清空所有函数和参数？')) return;
    state.funcs = [];
    state.params = {};
    state.paramSig = '';
    state.activeId = null;
    state.nextId = 1;
    addFunc('', { silent: true });
    recompute();
    limitResult.classList.add('hidden');
    state.plot.resetView();
  });

  function encodePayload() {
    const payload = {
      v: 1,
      f: state.funcs.filter((f) => f.input.trim()).map((f) => ({
        e: f.input, k: f.kind, o: f.order, c: f.color, h: f.visible ? 1 : 0,
      })),
      p: Object.fromEntries(Object.entries(state.params).map(([k, v]) => [k, v.value])),
      w: state.plot.view,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodePayload(str) {
    try {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      return null;
    }
  }

  $('#btnShare').addEventListener('click', async () => {
    const payload = encodePayload();
    const url = location.origin + location.pathname + '#s=' + payload;
    history.replaceState(null, '', '#s=' + payload);
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制，发给同学即可打开同一组函数');
    } catch (err) {
      prompt('复制这个链接：', url);
    }
  });

  function loadFromHash() {
    const h = location.hash || '';
    if (!h.startsWith('#s=')) return false;
    const data = decodePayload(h.slice(3));
    if (!data || !Array.isArray(data.f)) return false;
    state.funcs = [];
    state.nextId = 1;
    if (data.p && typeof data.p === 'object') {
      state.params = {};
      for (const [k, v] of Object.entries(data.p)) {
        if (Number.isFinite(Number(v))) state.params[k] = { value: Number(v), min: -5, max: 5 };
      }
    }
    for (const item of data.f) {
      state.funcs.push({
        id: state.nextId++,
        input: String(item.e || ''),
        visible: item.h !== 0,
        color: item.c || PALETTE[state.funcs.length % PALETTE.length],
        kind: item.k === 'deriv' || item.k === 'nderiv' ? item.k : 'fn',
        order: item.o === 2 ? 2 : 1,
        analysis: null,
        error: '',
      });
    }
    if (!state.funcs.length) return false;
    state.activeId = state.funcs[0].id;
    if (data.w && typeof data.w === 'object' && Number.isFinite(data.w.xMin)) {
      setTimeout(() => state.plot.setView(data.w), 0);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * photo OCR
   * ------------------------------------------------------------------ */

  const photoModal = $('#photoModal');
  const dropzone = $('#dropzone');
  const previewImg = $('#previewImg');
  const photoPreview = $('#photoPreview');
  const ocrText = $('#ocrText');
  const btnOcrRun = $('#btnOcrRun');
  const btnOcrImport = $('#btnOcrImport');
  const ocrProgress = $('#ocrProgress');
  const ocrBar = $('#ocrBar');
  const ocrStatus = $('#ocrStatus');
  const prepCanvas = document.createElement('canvas');

  let ocrBusy = false;

  function openPhotoModal() {
    photoModal.classList.remove('hidden');
    ocrText.focus();
  }

  function closePhotoModal() {
    if (ocrBusy) return;
    photoModal.classList.add('hidden');
  }

  $('#btnPhoto').addEventListener('click', openPhotoModal);
  $('#btnPhotoClose').addEventListener('click', closePhotoModal);
  photoModal.addEventListener('click', (e) => { if (e.target === photoModal) closePhotoModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !photoModal.classList.contains('hidden')) closePhotoModal();
  });

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    $('#fileInput').click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });
  $('#btnPickFile').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
  $('#btnPickCamera').addEventListener('click', (e) => { e.stopPropagation(); $('#cameraInput').click(); });
  $('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); });
  $('#cameraInput').addEventListener('change', (e) => { if (e.target.files[0]) handlePhoto(e.target.files[0]); });

  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) handlePhoto(file);
    else toast('请拖入图片文件');
  });

  document.addEventListener('paste', (e) => {
    if (photoModal.classList.contains('hidden')) return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) { handlePhoto(file); e.preventDefault(); }
        break;
      }
    }
  });

  function handlePhoto(file) {
    if (!file.type.startsWith('image/')) { toast('这不是图片'); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      state.ocrImage = img;
      URL.revokeObjectURL(url);
      prepareCanvas(img);
      previewImg.src = prepCanvas.toDataURL('image/png');
      photoPreview.classList.remove('hidden');
      btnOcrRun.disabled = false;
      btnOcrImport.disabled = !ocrText.value.trim();
      ocrText.value = '';
      ocrProgress.classList.add('hidden');
      toast('图片已载入，点「开始识别」');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('图片读取失败'); };
    img.src = url;
  }

  function prepareCanvas(img) {
    const maxSide = 1500;
    const scale = Math.min(3, Math.max(1, Math.min(maxSide / img.width, maxSide / img.height)));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    prepCanvas.width = w + 40;
    prepCanvas.height = h + 40;
    const ctx = prepCanvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, prepCanvas.width, prepCanvas.height);
    ctx.drawImage(img, 20, 20, w, h);

    const data = ctx.getImageData(0, 0, prepCanvas.width, prepCanvas.height);
    const d = data.data;
    let sum = 0;
    const lums = new Float32Array(d.length / 4);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lums[p] = lum;
      sum += lum;
    }
    const mean = sum / lums.length;
    const invert = mean < 115;

    // percentile stretch
    const hist = new Uint32Array(256);
    for (let i = 0; i < lums.length; i++) {
      const v = Math.max(0, Math.min(255, Math.round(invert ? 255 - lums[i] : lums[i])));
      hist[v]++;
    }
    const total = lums.length;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    if (hi <= lo) { lo = 0; hi = 255; }
    const range = hi - lo;

    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = invert ? 255 - lums[p] : lums[p];
      v = (v - lo) / range * 255;
      v = Math.max(0, Math.min(255, v));
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  }

  function cleanOcr(text) {
    let s = String(text || '');
    s = s.split(/\n+/).map((x) => x.trim()).filter(Boolean).join(' ');
    if (!s) return '';
    // pick the most math-looking line if several
    const parts = s.split(/\s{2,}/);
    if (parts.length > 1) {
      const best = parts.find((p) => /[xX]/.test(p) && /[0-9]/.test(p)) || parts[0];
      s = best;
    }
    s = s.replace(/[×✕]/g, '*').replace(/[÷]/g, '/').replace(/[−–—]/g, '-')
      .replace(/[“”"'`]/g, '')
      .replace(/π/g, 'pi').replace(/∞/g, 'Infinity')
      .replace(/√/g, 'sqrt')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/\bIn\b/g, 'ln').replace(/\b1n\b/g, 'ln')
      .replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, '')
      .replace(/[?？]/g, '')
      .replace(/\s*([+\-*/^=()])\s*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[=,;.]+|[=,;.]+$/g, '');

    // x2 -> x^2 (avoid log2 etc.)
    s = s.replace(/(?<![A-Za-z])([A-Za-z])([2-9])(?=$|[+\-*/^)])/g, '$1^$2');
    return s;
  }

  function setOcrProgress(pct, label) {
    ocrProgress.classList.remove('hidden');
    ocrBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    ocrStatus.textContent = label;
  }

  function onOcrLog(m) {
    const map = {
      'loading tesseract core': '加载识别核心…',
      'initializing tesseract': '初始化…',
      'loading language traineddata': '加载语言包…',
      'initializing api': '准备识别…',
      'recognizing text': '识别中',
    };
    if (m.status === 'recognizing text') {
      setOcrProgress((m.progress || 0) * 100, `识别中 ${Math.round((m.progress || 0) * 100)}%`);
    } else {
      setOcrProgress(8, map[m.status] || m.status || '处理中…');
    }
  }

  function getOcrWorker() {
    if (state.ocrWorkerPromise) return state.ocrWorkerPromise;
    if (!window.Tesseract) return Promise.reject(new Error('OCR 组件未加载'));
    const base = new URL('./', location.href).href;
    state.ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: base + 'vendor/tesseract/worker.min.js',
      corePath: base + 'vendor/tesseract/tesseract-core-simd.wasm.js',
      langPath: base + 'vendor/tesseract/lang',
      workerBlobURL: false,
      gzip: true,
      logger: onOcrLog,
    }).catch((err) => {
      state.ocrWorkerPromise = null;
      throw err;
    });
    return state.ocrWorkerPromise;
  }

  btnOcrRun.addEventListener('click', async () => {
    if (!state.ocrImage || ocrBusy) return;
    ocrBusy = true;
    btnOcrRun.disabled = true;
    btnOcrImport.disabled = true;
    setOcrProgress(2, '加载识别核心…');
    try {
      const worker = await getOcrWorker();
      await worker.setParameters({
        tessedit_pageseg_mode: '7',
        preserve_interword_spaces: '1',
      });
      setOcrProgress(15, '识别中…');
      const result = await worker.recognize(prepCanvas);
      const text = cleanOcr(result?.data?.text || '');
      ocrText.value = text;
      setOcrProgress(100, text ? '识别完成' : '没识别到文字');
      btnOcrImport.disabled = !text;
      if (text) toast('识别完成，先核对再导入');
      else toast('没有识别到内容，换张更清晰的图试试');
    } catch (err) {
      console.error(err);
      setOcrProgress(0, '识别失败');
      ocrStatus.textContent = '识别失败';
      toast('OCR 加载或识别失败：' + (err.message || err));
      btnOcrRun.disabled = false;
    } finally {
      ocrBusy = false;
      btnOcrRun.disabled = !state.ocrImage;
    }
  });

  ocrText.addEventListener('input', () => {
    btnOcrImport.disabled = !ocrText.value.trim();
  });

  btnOcrImport.addEventListener('click', () => {
    const raw = ocrText.value.trim();
    if (!raw) return;
    addFunc(raw, { focus: false });
    photoModal.classList.add('hidden');
    toast('已导入识别结果，可在左侧继续修改');
  });

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  function boot() {
    if (!window.math) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#eee;background:#111;height:100vh">math.js 加载失败，请检查 vendor/math.min.js 是否完整。</div>';
      return;
    }

    state.plot = new Plotter(canvas);

    const loaded = loadFromHash();
    if (!loaded) {
      addFunc('sin(x)/x', { silent: true, focus: false });
    }

    renderFnList();
    recompute();

    if (loaded) {
      // restore view after the first layout pass
      const h = location.hash;
      const data = decodePayload(h.slice(3));
      if (data && data.w) state.plot.setView(data.w);
    }

    $('#limitPoint').disabled = false;
    updateFullscreenIcon();
  }

  function updateFullscreenIcon() {
    const path = document.fullscreenElement
      ? '<path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5"/>'
      : '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>';
    $('#btnFull').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
