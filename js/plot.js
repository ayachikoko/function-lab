/* Plotter — canvas 2D function plotter with independent axis zoom. */
(function () {
  'use strict';

  const MIN_SPAN = 1e-9;
  const MAX_SPAN = 1e10;

  function niceStep(range, target) {
    const raw = Math.max(range, 1e-12) / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let mult = 1;
    if (norm > 5) mult = 10;
    else if (norm > 2) mult = 5;
    else if (norm > 1) mult = 2;
    return mult * mag;
  }

  function decimalsFor(step) {
    if (!isFinite(step) || step <= 0) return 0;
    const d = Math.ceil(-Math.log10(step));
    return Math.min(9, Math.max(0, d));
  }

  function fmtTick(v, step) {
    if (Math.abs(v) < step * 1e-6) return '0';
    const d = decimalsFor(step);
    if (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-5) {
      return v.toExponential(1).replace('e+', 'e').replace(/e(-?)0+(\d)/, 'e$1$2');
    }
    return String(Number(v.toFixed(d)));
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  class Plotter {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.view = { xMin: -10, xMax: 10, yMin: -6, yMax: 6 };
      this.functions = [];
      this.dpr = 1;
      this.w = 0;
      this.h = 0;
      this.hover = null;
      this.onViewChange = null;
      this._raf = 0;
      this._pointers = new Map();
      this._pinch = null;
      this._panning = false;
      this._ready = false;

      this._bound = {
        down: this._onDown.bind(this),
        move: this._onMove.bind(this),
        up: this._onUp.bind(this),
        wheel: this._onWheel.bind(this),
        leave: this._onLeave.bind(this),
      };

      canvas.addEventListener('pointerdown', this._bound.down);
      canvas.addEventListener('pointermove', this._bound.move);
      canvas.addEventListener('pointerup', this._bound.up);
      canvas.addEventListener('pointercancel', this._bound.up);
      canvas.addEventListener('pointerleave', this._bound.leave);
      canvas.addEventListener('wheel', this._bound.wheel, { passive: false });

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement || canvas);
      this.resize();
    }

    resize() {
      const parent = this.canvas.parentElement || this.canvas;
      const rect = parent.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (w === this.w && h === this.h && dpr === this.dpr && this._ready) return;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      if (!this._ready) {
        this.resetView(false);
        this._ready = true;
      }
      this.draw();
    }

    resetView(redraw = true) {
      const aspect = Math.max(0.2, this.w / Math.max(1, this.h));
      const xSpan = 20;
      const ySpan = xSpan / aspect;
      this.view = { xMin: -xSpan / 2, xMax: xSpan / 2, yMin: -ySpan / 2, yMax: ySpan / 2 };
      if (redraw) {
        this.draw();
        this._emitView();
      }
    }

    setView(v, redraw = true) {
      if (!v || !isFinite(v.xMin) || !isFinite(v.xMax) || v.xMin >= v.xMax || v.yMin >= v.yMax) return;
      this.view = { xMin: v.xMin, xMax: v.xMax, yMin: v.yMin, yMax: v.yMax };
      if (redraw) this.draw();
    }

    setFunctions(fns) {
      this.functions = fns || [];
      this.draw();
    }

    _emitView() {
      if (typeof this.onViewChange === 'function') this.onViewChange(this.view, this);
    }

    xToPx(x) { return (x - this.view.xMin) / (this.view.xMax - this.view.xMin) * this.w; }
    yToPx(y) { return this.h - (y - this.view.yMin) / (this.view.yMax - this.view.yMin) * this.h; }
    pxToX(px) { return this.view.xMin + px / this.w * (this.view.xMax - this.view.xMin); }
    pxToY(py) { return this.view.yMin + (this.h - py) / this.h * (this.view.yMax - this.view.yMin); }

    _clampView(v) {
      let xs = v.xMax - v.xMin;
      let ys = v.yMax - v.yMin;
      if (!isFinite(xs) || xs <= 0) xs = 20;
      if (!isFinite(ys) || ys <= 0) ys = 12;
      xs = clamp(xs, MIN_SPAN, MAX_SPAN);
      ys = clamp(ys, MIN_SPAN, MAX_SPAN);
      const cx = (v.xMin + v.xMax) / 2;
      const cy = (v.yMin + v.yMax) / 2;
      const nv = {
        xMin: cx - xs / 2,
        xMax: cx + xs / 2,
        yMin: cy - ys / 2,
        yMax: cy + ys / 2,
      };
      // hard-stop runaway values
      if (!isFinite(nv.xMin) || !isFinite(nv.yMin)) return this.view;
      return nv;
    }

    zoomAt(px, py, factorX, factorY) {
      const fx = clamp(factorX || 1, 0.5, 2);
      const fy = clamp(factorY || 1, 0.5, 2);
      const ax = this.pxToX(px);
      const ay = this.pxToY(py);
      const v = this.view;
      const nv = {
        xMin: ax + (v.xMin - ax) / fx,
        xMax: ax + (v.xMax - ax) / fx,
        yMin: ay + (v.yMin - ay) / fy,
        yMax: ay + (v.yMax - ay) / fy,
      };
      this.view = this._clampView(nv);
      this.draw();
      this._emitView();
    }

    zoomCenter(fx, fy) {
      this.zoomAt(this.w / 2, this.h / 2, fx, fy);
    }

    panByPx(dx, dy) {
      const v = this.view;
      const xs = v.xMax - v.xMin;
      const ys = v.yMax - v.yMin;
      this.view = {
        xMin: v.xMin - dx / this.w * xs,
        xMax: v.xMax - dx / this.w * xs,
        yMin: v.yMin + dy / this.h * ys,
        yMax: v.yMax + dy / this.h * ys,
      };
      this.draw();
      this._emitView();
    }

    _onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      this.canvas.setPointerCapture?.(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._panning = true;
        this._last = { x: e.clientX, y: e.clientY };
        this.canvas.classList.add('dragging');
      } else if (this._pointers.size === 2) {
        this._panning = false;
        const pts = [...this._pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const rect = this.canvas.getBoundingClientRect();
        this._pinch = {
          dist: Math.max(1, dist),
          mid: { x: (pts[0].x + pts[1].x) / 2 - rect.left, y: (pts[0].y + pts[1].y) / 2 - rect.top },
          view: { ...this.view },
        };
      }
    }

    _onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      this.hover = { px, py };
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this._pointers.size >= 2 && this._pinch) {
        const pts = [...this._pointers.values()];
        const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        const scale = clamp(dist / this._pinch.dist, 0.2, 5);
        const mx = (pts[0].x + pts[1].x) / 2 - rect.left;
        const my = (pts[0].y + pts[1].y) / 2 - rect.top;
        const v0 = this._pinch.view;
        const ax = v0.xMin + (this._pinch.mid.x / this.w) * (v0.xMax - v0.xMin);
        const ay = v0.yMin + (this.h - this._pinch.mid.y) / this.h * (v0.yMax - v0.yMin);
        const xs = (v0.xMax - v0.xMin) / scale;
        const ys = (v0.yMax - v0.yMin) / scale;
        this.view = this._clampView({
          xMin: ax - (mx / this.w) * xs,
          xMax: ax - (mx / this.w) * xs + xs,
          yMin: ay - (this.h - my) / this.h * ys,
          yMax: ay - (this.h - my) / this.h * ys + ys,
        });
        this.draw();
        this._emitView();
        return;
      }

      if (this._panning && this._last) {
        const dx = e.clientX - this._last.x;
        const dy = e.clientY - this._last.y;
        this._last = { x: e.clientX, y: e.clientY };
        if (dx || dy) this.panByPx(dx, dy);
        return;
      }
      this.draw();
    }

    _onUp(e) {
      if (this._pointers.has(e.pointerId)) this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) {
        this._panning = false;
        this._last = null;
        this.canvas.classList.remove('dragging');
      } else if (this._pointers.size === 1) {
        const p = [...this._pointers.values()][0];
        this._last = { x: p.x, y: p.y };
        this._panning = true;
      }
      this.draw();
    }

    _onLeave() {
      if (this._pointers.size === 0) {
        this.hover = null;
        this.draw();
      }
    }

    _onWheel(e) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let mode = 'both';
      if (e.shiftKey) mode = 'x';
      else if (e.altKey) mode = 'y';
      else if (py > this.h - 30) mode = 'x';
      else if (px < 30) mode = 'y';

      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= this.h;
      const factor = clamp(Math.exp(-delta * 0.0016), 0.5, 2);
      this.zoomAt(px, py, mode === 'y' ? 1 : factor, mode === 'x' ? 1 : factor);
    }

    draw() {
      if (!this._ready && (this.w === 0 || this.h === 0)) return;
      const ctx = this.ctx;
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);

      // background
      const bg = ctx.createLinearGradient(0, 0, 0, this.h);
      bg.addColorStop(0, '#0d0a12');
      bg.addColorStop(1, '#100c17');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.w, this.h);

      const v = this.view;
      const xStep = niceStep(v.xMax - v.xMin, Math.max(4, Math.floor(this.w / 95)));
      const yStep = niceStep(v.yMax - v.yMin, Math.max(3, Math.floor(this.h / 70)));

      this._drawGrid(ctx, xStep, yStep);
      this._drawAxes(ctx, xStep, yStep);
      this._drawCurves(ctx);

      if (!this.functions.length || this.functions.every(f => !f.visible)) {
        ctx.save();
        ctx.fillStyle = 'rgba(163,150,184,.35)';
        ctx.font = '13px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('在左侧输入一个函数，图像会出现在这里', this.w / 2, this.h / 2);
        ctx.restore();
      }

      this._drawHover(ctx);
    }

    _drawGrid(ctx, xStep, yStep) {
      const { xMin, xMax, yMin, yMax } = this.view;
      const w = this.w, h = this.h;

      const xMinor = xStep / 5;
      const yMinor = yStep / 5;
      const xMinorPx = xMinor / (xMax - xMin) * w;
      const yMinorPx = yMinor / (yMax - yMin) * h;

      ctx.save();
      if (xMinorPx > 7 && yMinorPx > 7) {
        ctx.beginPath();
        for (let x = Math.ceil(xMin / xMinor) * xMinor; x <= xMax + xMinor * 0.5; x += xMinor) {
          const px = this.xToPx(x);
          ctx.moveTo(px, 0); ctx.lineTo(px, h);
        }
        for (let y = Math.ceil(yMin / yMinor) * yMinor; y <= yMax + yMinor * 0.5; y += yMinor) {
          const py = this.yToPx(y);
          ctx.moveTo(0, py); ctx.lineTo(w, py);
        }
        ctx.strokeStyle = 'rgba(255,255,255,.028)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax + xStep * 0.5; x += xStep) {
        const px = this.xToPx(x);
        ctx.moveTo(px, 0); ctx.lineTo(px, h);
      }
      for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax + yStep * 0.5; y += yStep) {
        const py = this.yToPx(y);
        ctx.moveTo(0, py); ctx.lineTo(w, py);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.062)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    _drawAxes(ctx, xStep, yStep) {
      const { xMin, xMax, yMin, yMax } = this.view;
      const w = this.w, h = this.h;
      const hasX = yMin <= 0 && yMax >= 0;
      const hasY = xMin <= 0 && xMax >= 0;
      const x0 = clamp(this.xToPx(0), 0, w);
      const y0 = clamp(this.yToPx(0), 0, h);

      ctx.save();

      // axis lines
      ctx.strokeStyle = 'rgba(224,212,240,.42)';
      ctx.lineWidth = 1.15;
      if (hasX) {
        ctx.beginPath();
        ctx.moveTo(0, y0); ctx.lineTo(w, y0);
        ctx.stroke();
        // arrow
        ctx.fillStyle = 'rgba(224,212,240,.42)';
        ctx.beginPath();
        ctx.moveTo(w - 1, y0); ctx.lineTo(w - 9, y0 - 4); ctx.lineTo(w - 9, y0 + 4); ctx.closePath(); ctx.fill();
      }
      if (hasY) {
        ctx.beginPath();
        ctx.moveTo(x0, h); ctx.lineTo(x0, 0);
        ctx.stroke();
        ctx.fillStyle = 'rgba(224,212,240,.42)';
        ctx.beginPath();
        ctx.moveTo(x0, 0); ctx.lineTo(x0 - 4, 8); ctx.lineTo(x0 + 4, 8); ctx.closePath(); ctx.fill();
      }

      // labels
      ctx.font = '11px ui-monospace, "Cascadia Code", Consolas, monospace';
      ctx.fillStyle = 'rgba(158,144,178,.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const labelY = hasX ? (y0 > h - 26 ? y0 - 18 : y0 + 6) : h - 18;
      ctx.textBaseline = hasX && y0 > h - 26 ? 'bottom' : 'top';

      for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax + xStep * 0.45; x += xStep) {
        if (Math.abs(x) < xStep * 1e-6) continue;
        const px = this.xToPx(x);
        if (px < 12 || px > w - 12) continue;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(224,212,240,.35)';
        ctx.moveTo(px, y0 - 3);
        ctx.lineTo(px, y0 + 3);
        ctx.stroke();
        ctx.fillText(fmtTick(x, xStep), px, labelY);
      }

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const labelX = hasY ? (x0 > w - 42 ? x0 - 8 : x0 + 8) : 34;
      if (hasY && x0 > w - 42) ctx.textAlign = 'right';
      else if (hasY) ctx.textAlign = 'left';
      else ctx.textAlign = 'right';

      for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax + yStep * 0.45; y += yStep) {
        if (Math.abs(y) < yStep * 1e-6) continue;
        const py = this.yToPx(y);
        if (py < 12 || py > h - 8) continue;
        if (hasY) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(224,212,240,.35)';
          ctx.moveTo(x0 - 3, py);
          ctx.lineTo(x0 + 3, py);
          ctx.stroke();
        }
        ctx.fillText(fmtTick(y, yStep), labelX, py);
      }

      if (hasX && hasY) {
        ctx.fillStyle = 'rgba(158,144,178,.9)';
        ctx.font = '11px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('0', x0 - 5, y0 + 6);
      }
      ctx.restore();
    }

    _eval(fn, x) {
      try {
        const y = fn.evalX(x);
        return typeof y === 'number' ? y : Number(y);
      } catch (err) {
        return NaN;
      }
    }

    _drawCurves(ctx) {
      const v = this.view;
      const w = this.w;
      const n = Math.max(240, Math.round(w * 1.25));
      const dx = (v.xMax - v.xMin) / n;
      const span = v.yMax - v.yMin;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, this.h);
      ctx.clip();

      for (const fn of this.functions) {
        if (!fn.visible) continue;
        ctx.strokeStyle = fn.color;
        ctx.lineWidth = fn.kind === 'deriv' ? 2.1 : 2.35;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (typeof fn.dash === 'number') ctx.setLineDash([7, 5]);
        else ctx.setLineDash([]);

        let started = false;
        let prevY = NaN;
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const x = v.xMin + i * dx;
          const y = this._eval(fn, x);
          if (!Number.isFinite(y)) {
            started = false;
            prevY = NaN;
            continue;
          }
          const px = this.xToPx(x);
          const py = this.yToPx(y);

          if (started && Number.isFinite(prevY)) {
            const jump = Math.abs(y - prevY);
            const signFlip = (y > 0) !== (prevY > 0);
            if (jump > span * 10 && (signFlip || Math.min(Math.abs(y), Math.abs(prevY)) > span)) {
              started = false;
            }
          }

          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
          prevY = y;
        }
        ctx.stroke();
      }
      ctx.restore();
      ctx.setLineDash([]);
    }

    _drawHover(ctx) {
      if (!this.hover) return;
      const { px, py } = this.hover;
      if (px < 0 || py < 0 || px > this.w || py > this.h) return;
      const x = this.pxToX(px);
      const y = this.pxToY(py);

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, this.h);
      ctx.moveTo(0, py); ctx.lineTo(this.w, py);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const fn of this.functions) {
        if (!fn.visible) continue;
        const fy = this._eval(fn, x);
        if (!Number.isFinite(fy)) continue;
        const fpy = this.yToPx(fy);
        if (fpy < -20 || fpy > this.h + 20) continue;
        ctx.beginPath();
        ctx.arc(px, fpy, 4, 0, Math.PI * 2);
        ctx.fillStyle = fn.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(16,13,22,.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }

    exportPNG(filename = 'function-plot.png') {
      this.hover = null;
      this.draw();
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    destroy() {
      this.resizeObserver?.disconnect();
      const c = this.canvas;
      c.removeEventListener('pointerdown', this._bound.down);
      c.removeEventListener('pointermove', this._bound.move);
      c.removeEventListener('pointerup', this._bound.up);
      c.removeEventListener('pointercancel', this._bound.up);
      c.removeEventListener('pointerleave', this._bound.leave);
      c.removeEventListener('wheel', this._bound.wheel);
    }
  }

  window.Plotter = Plotter;
})();
