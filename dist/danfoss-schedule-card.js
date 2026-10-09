/*
 * danfoss-schedule-card  v1.0
 * Paint-grid week schedule for Danfoss Ally TRVs (ZHA) – backend: pyscript/climate_schedule.py
 *
 * type: custom:danfoss-schedule-card
 * schedule_id: living_room            # required
 * title: Living room
 * climates:                           # climate entities (or {entity, ieee})
 *   - climate.living_room_trv_1
 * mode: native                        # native = program valves | ha = HA sets temperature
 * presets:                            # optional, used until the first save
 *   - {name: Comfort, temp: 21.5, color: "#ff8a3d"}
 */
(() => {
  const VERSION = '1.0.0';
  const SLOTS = 48, SLOT_MIN = 30, MAX_BLOCKS = 6;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DEFAULT_PRESETS = [
    { name: 'Comfort', temp: 21.5, color: '#ff8a3d' },
    { name: 'Eco', temp: 19, color: '#34c759' },
    { name: 'Night', temp: 17.5, color: '#5e5ce6' },
    { name: 'Away', temp: 15, color: '#8e8e93' },
  ];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fromBlocks = (bl) => { let s = ''; bl.forEach(([start, p], i) => { const end = i + 1 < bl.length ? bl[i + 1][0] : SLOTS; s += String(p).repeat(end - start); }); return s; };
  const defaultDays = () => {
    const wd = fromBlocks([[0, 2], [13, 0], [16, 3], [34, 0], [45, 2]]);
    const we = fromBlocks([[0, 2], [16, 0], [26, 1], [30, 0], [46, 2]]);
    return [wd, wd, wd, wd, wd, we, we];
  };
  const blockCount = (day, presets) => { let n = 0, prev = null; for (const ch of day) { const t = presets[+ch]?.temp; if (t !== prev) { n++; prev = t; } } return n; };
  const nowPos = () => { const d = new Date(); return { day: (d.getDay() + 6) % 7, min: d.getHours() * 60 + d.getMinutes() }; };

  class DanfossScheduleCard extends HTMLElement {
    static getStubConfig() { return { schedule_id: 'living_room', title: 'Living room', climates: [] }; }
    getCardSize() { return 7; }
    getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

    setConfig(cfg) {
      if (!cfg || !cfg.schedule_id) throw new Error('schedule_id is required');
      this._cfg = { mode: 'native', title: cfg.schedule_id, ...cfg };
      this._eid = 'pyscript.climate_schedule_' + slug(cfg.schedule_id);
      this._sel = this._sel || 0;
      this._draft = null;
      this._msg = null;
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this._render();
    }

    set hass(h) {
      const old = this._hass;
      this._hass = h;
      const watch = [this._eid, ...this._climates()];
      if (!old || watch.some((id) => old.states[id] !== h.states[id])) { if (!this._painting) this._render(); }
    }

    connectedCallback() { this._timer = setInterval(() => { if (!this._painting) this._render(); }, 60000); }
    disconnectedCallback() { clearInterval(this._timer); }

    /* ---------- data ---------- */
    _entity() { return this._hass && this._hass.states[this._eid]; }
    _saved() { const e = this._entity(); return e && Array.isArray(e.attributes.days) ? { presets: e.attributes.presets, days: e.attributes.days } : null; }
    _data() { if (this._draft) return this._draft; const s = this._saved(); return s ? s : { presets: this._cfg.presets || DEFAULT_PRESETS, days: defaultDays() }; }
    _edit() { if (!this._draft) this._draft = clone(this._data()); return this._draft; }
    _climates() {
      const c = (this._cfg && this._cfg.climates && this._cfg.climates.length) ? this._cfg.climates : (this._entity()?.attributes.climates || []);
      return c.map((x) => (typeof x === 'string' ? x : x.entity));
    }
    _invalid(data) {
      for (let d = 0; d < 7; d++) { const n = blockCount(data.days[d], data.presets); if (n > MAX_BLOCKS) return `${DAYS[d]} has ${n} blocks – Danfoss allows max ${MAX_BLOCKS} per day`; }
      return null;
    }
    _current(data) {
      const { day, min } = nowPos();
      const slot = Math.floor(min / SLOT_MIN);
      const p = +data.days[day][slot], t = data.presets[p].temp;
      for (let k = 1; k <= SLOTS * 7; k++) {
        const s = slot + k, d = (day + Math.floor(s / SLOTS)) % 7, ss = s % SLOTS;
        if (data.presets[+data.days[d][ss]].temp !== t) {
          const dayTxt = Math.floor(s / SLOTS) === 0 ? '' : Math.floor(s / SLOTS) === 1 ? 'tomorrow ' : DAYS[d] + ' ';
          return { p, t, until: dayTxt + fmt(ss * SLOT_MIN) };
        }
      }
      return { p, t, until: null };
    }

    /* ---------- actions ---------- */
    async _save() {
      const data = this._data(), err = this._invalid(data);
      if (err) { this._toast(err, true); return; }
      const climates = this._cfg.climates && this._cfg.climates.length ? this._cfg.climates : (this._entity()?.attributes.climates || []);
      if (!climates.length) { this._toast('No climates configured in the card', true); return; }
      this._busy = true; this._render();
      try {
        await this._hass.callService('pyscript', 'climate_schedule_save', {
          schedule_id: slug(this._cfg.schedule_id), title: this._cfg.title, climates,
          presets: data.presets, days: data.days, mode: this._cfg.mode, oper_mode: this._cfg.oper_mode ?? 1,
        });
        this._draft = null;
        this._toast(this._cfg.mode === 'ha' ? 'Saved – HA will set temperatures' : 'Saved – programming valves…');
      } catch (e) { this._toast('Save failed: ' + (e.message || e), true); }
      this._busy = false; this._render();
    }
    async _resync() {
      try { await this._hass.callService('pyscript', 'climate_schedule_push', { schedule_id: slug(this._cfg.schedule_id) }); this._toast('Re-sync started'); }
      catch (e) { this._toast('Re-sync failed: ' + (e.message || e), true); }
    }
    _toast(text, err = false) { this._msg = { text, err }; clearTimeout(this._mt); this._mt = setTimeout(() => { this._msg = null; this._render(); }, 5000); this._render(); }
    _copy(from, to) { const d = this._edit(); to.forEach((i) => (d.days[i] = d.days[from])); this._render(); }

    /* ---------- painting ---------- */
    /* drag paints a rectangle: anchor cell → current cell (days × time) */
    _paintAt(x, y) {
      const el = this.shadowRoot.elementFromPoint(x, y);
      if (!el || !el.classList.contains('cell')) return;
      const d = +el.dataset.d, c = +el.dataset.c, data = this._edit();
      if (!this._anchor) { this._anchor = { d, c }; this._snap = data.days.slice(); }
      const d0 = Math.min(this._anchor.d, d), d1 = Math.max(this._anchor.d, d);
      const c0 = Math.min(this._anchor.c, c), c1 = Math.max(this._anchor.c, c);
      const p = data.presets[this._sel];
      for (let i = 0; i < 7; i++) {
        const src = this._snap[i];
        const next = i >= d0 && i <= d1 ? src.slice(0, c0) + String(this._sel).repeat(c1 - c0 + 1) + src.slice(c1 + 1) : src;
        if (next === data.days[i]) continue;
        data.days[i] = next;
        this.shadowRoot.querySelectorAll(`.cell[data-d="${i}"]`).forEach((cell, k) => { cell.style.background = data.presets[+next[k]].color; });
        const n = blockCount(next, data.presets);
        const cnt = this.shadowRoot.querySelector(`.cnt[data-d="${i}"]`);
        cnt.textContent = `${n}/${MAX_BLOCKS}`; cnt.classList.toggle('over', n > MAX_BLOCKS);
        this.shadowRoot.querySelector(`.row[data-d="${i}"]`).classList.toggle('over', n > MAX_BLOCKS);
      }
      const tip = this.shadowRoot.querySelector('.tip'), r = this.getBoundingClientRect();
      const dTxt = d0 === d1 ? DAYS[d0] : `${DAYS[d0]}–${DAYS[d1]}`;
      tip.textContent = `${dTxt} ${fmt(c0 * SLOT_MIN)}–${fmt((c1 + 1) * SLOT_MIN)} → ${p.name} ${(+p.temp).toFixed(1)}°`;
      tip.style.left = x - r.left + 'px'; tip.style.top = y - r.top + 'px'; tip.style.display = 'block';
    }
    _bindGrid() {
      const g = this.shadowRoot.querySelector('.grid');
      g.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('cell')) return; e.preventDefault(); g.setPointerCapture(e.pointerId); this._painting = true; this._paintAt(e.clientX, e.clientY); });
      g.addEventListener('pointermove', (e) => { if (this._painting) this._paintAt(e.clientX, e.clientY); });
      const up = () => { if (!this._painting) return; this._painting = false; this._anchor = null; this._snap = null; this._render(); };
      g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    }

    /* ---------- render ---------- */
    _render() {
      if (!this.shadowRoot || !this._cfg) return;
      const data = this._data(), ent = this._entity(), dirty = !!this._draft;
      const invalid = this._invalid(data), cur = this._current(data), np = nowPos();
      const status = ent?.attributes.status || {};
      const mode = this._cfg.mode;

      const chips = data.presets.map((p, i) => `
        <div class="chip ${i === this._sel ? 'on' : ''}" data-i="${i}" style="--c:${p.color}">
          <span class="dot"></span><span class="nm">${esc(p.name)}</span>
          <button class="tb" data-i="${i}" data-d="-1">−</button><span class="tv">${(+p.temp).toFixed(1)}°</span><button class="tb" data-i="${i}" data-d="1">+</button>
        </div>`).join('');

      const rows = DAYS.map((name, d) => {
        const n = blockCount(data.days[d], data.presets);
        let cells = '';
        for (let c = 0; c < SLOTS; c++) cells += `<div class="cell${c % 12 === 0 && c ? ' h6' : ''}" data-d="${d}" data-c="${c}" style="background:${data.presets[+data.days[d][c]].color}"></div>`;
        const now = d === np.day ? `<div class="now" style="left:${(np.min / 1440) * 100}%"></div>` : '';
        return `<div class="row${n > MAX_BLOCKS ? ' over' : ''}" data-d="${d}">
          <div class="dl${d === np.day ? ' today' : ''}">${name}</div>
          <div class="cells">${cells}${now}</div>
          <div class="cnt${n > MAX_BLOCKS ? ' over' : ''}" data-d="${d}">${n}/${MAX_BLOCKS}</div></div>`;
      }).join('');

      const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${h}</span>`).join('');

      const valves = this._climates().map((id) => {
        const st = this._hass?.states[id], s = status[id];
        const name = st?.attributes.friendly_name || id;
        const temp = st?.attributes.current_temperature;
        const cls = mode === 'ha' ? 'ha' : !st || st.state === 'unavailable' ? 'err' : s ? s.state : 'unknown';
        const title = mode === 'ha' ? 'HA-driven' : s ? `${s.state} · ${s.at?.replace('T', ' ') || ''} ${s.msg || ''}` : 'not programmed yet';
        return `<div class="valve" title="${esc(title)}"><span class="sd ${cls}"></span>${esc(name)}${temp != null ? `<b>${(+temp).toFixed(1)}°</b>` : ''}</div>`;
      }).join('');

      const savedTxt = !ent ? 'Not saved yet' : dirty ? 'Unsaved changes' : `Saved ${ent.attributes.updated ? ent.attributes.updated.slice(5, 16).replace('T', ' ') : ''}`;

      this.shadowRoot.innerHTML = `<style>${CSS}</style>
      <ha-card>
        <div class="head">
          <div class="ic">🌡️</div>
          <div class="ttl"><div class="t">${esc(this._cfg.title)}</div>
            <div class="s"><span class="badge ${mode}">${mode === 'ha' ? 'HA-driven' : 'On-valve schedule'}</span> ${savedTxt}</div></div>
          <div class="nowt"><b style="color:${data.presets[cur.p].color}">${(+cur.t).toFixed(1)}°</b><div class="s">${esc(data.presets[cur.p].name)}${cur.until ? ' until ' + cur.until : ''}</div></div>
        </div>
        <div class="presets">${chips}</div>
        <div class="ruler"><span></span><div class="ticks">${ticks}</div><span></span></div>
        <div class="grid">${rows}</div>
        <div class="tools">
          <button class="btn" data-a="wd">Mon → Tue–Fri</button>
          <button class="btn" data-a="we">Sat → Sun</button>
          <span class="sp"></span>
          ${dirty ? '<button class="btn" data-a="revert">Revert</button>' : ''}
          ${ent && mode === 'native' && !dirty ? '<button class="btn" data-a="resync">Re-sync</button>' : ''}
          <button class="btn pri" data-a="save" ${invalid || this._busy || (!dirty && ent) ? 'disabled' : ''}>${this._busy ? 'Saving…' : mode === 'ha' ? 'Save' : 'Save & program'}</button>
        </div>
        ${invalid ? `<div class="warn">⚠ ${esc(invalid)}</div>` : ''}
        ${this._msg ? `<div class="msg ${this._msg.err ? 'err' : ''}">${esc(this._msg.text)}</div>` : ''}
        <div class="valves">${valves || '<span class="s">No climates configured</span>'}</div>
        <div class="tip"></div>
      </ha-card>`;

      const root = this.shadowRoot;
      root.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', (e) => {
        const b = e.target.closest('.tb'), i = +el.dataset.i;
        if (b) { const d = this._edit(); d.presets[i].temp = Math.max(5, Math.min(30, +d.presets[i].temp + 0.5 * +b.dataset.d)); }
        else this._sel = i;
        this._render();
      }));
      root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'wd') this._copy(0, [1, 2, 3, 4]);
        else if (a === 'we') this._copy(5, [6]);
        else if (a === 'revert') { this._draft = null; this._render(); }
        else if (a === 'resync') this._resync();
        else if (a === 'save') this._save();
      }));
      this._bindGrid();
    }
  }

  const CSS = `
  :host{--bg2:var(--secondary-background-color,#2a2a2e);--txt:var(--primary-text-color,#f2f2f4);--mut:var(--secondary-text-color,#8e8e96);--acc:var(--primary-color,#0a84ff);--ln:var(--divider-color,#38383d)}
  ha-card{display:block;padding:16px;position:relative;color:var(--txt);overflow:hidden;background:var(--ha-card-background,var(--card-background-color,#1f1f22));border-radius:var(--ha-card-border-radius,12px)}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .ic{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:20px;background:rgba(255,138,61,.16);flex:none}
  .ttl{min-width:0}.t{font-weight:600;font-size:16px}.s{color:var(--mut);font-size:12px}
  .badge{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;background:rgba(10,132,255,.18);color:var(--acc);margin-right:4px}
  .badge.ha{background:rgba(255,159,10,.18);color:#ff9f0a}
  .nowt{margin-left:auto;text-align:right;flex:none}.nowt b{font-size:24px;font-weight:600}
  .presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .chip{display:flex;align-items:center;gap:5px;padding:4px 3px 4px 10px;border-radius:12px;background:var(--bg2);border:2px solid transparent;cursor:pointer;user-select:none}
  .chip.on{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 25%,transparent)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--c)}
  .nm{font-size:13px}.tv{font-variant-numeric:tabular-nums;min-width:40px;text-align:center;font-weight:600;font-size:13px}
  .tb{border:0;background:transparent;color:var(--mut);width:24px;height:24px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1}
  .tb:hover{background:var(--ln);color:var(--txt)}
  .ruler,.row{display:grid;grid-template-columns:34px 1fr 34px;align-items:center;column-gap:6px}
  .ticks{position:relative;height:14px;color:var(--mut);font-size:10px}
  .ticks span{position:absolute;transform:translateX(-50%)}.ticks span:first-child{transform:none}.ticks span:last-child{transform:translateX(-100%)}
  .grid{touch-action:none;user-select:none}
  .row{margin:3px 0}
  .dl{font-weight:600;color:var(--mut);font-size:12px}.dl.today{color:var(--acc)}
  .cells{position:relative;display:grid;grid-template-columns:repeat(48,1fr);gap:1px;border-radius:7px;overflow:hidden;outline:2px solid transparent;outline-offset:1px}
  .row.over .cells{outline-color:#ff453a}
  .cell{height:30px;cursor:cell}
  .cell.h6{box-shadow:inset 2px 0 0 rgba(0,0,0,.35)}
  .now{position:absolute;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 5px rgba(0,0,0,.7);pointer-events:none}
  .cnt{font-size:11px;color:var(--mut);text-align:right;font-variant-numeric:tabular-nums}.cnt.over{color:#ff453a;font-weight:700}
  .tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}.sp{flex:1}
  .btn{border:1px solid var(--ln);background:var(--bg2);color:var(--txt);padding:7px 12px;border-radius:10px;cursor:pointer;font:inherit;font-size:13px}
  .btn:hover:not([disabled]){border-color:var(--acc)}
  .btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
  .btn[disabled]{opacity:.4;cursor:default}
  .warn,.msg{margin-top:10px;padding:8px 12px;border-radius:10px;font-size:13px}
  .warn{background:rgba(255,69,58,.15);color:#ff6961}
  .msg{background:rgba(52,199,89,.15);color:#34c759}.msg.err{background:rgba(255,69,58,.15);color:#ff6961}
  .valves{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--ln)}
  .valve{display:flex;align-items:center;gap:6px;font-size:12px;background:var(--bg2);padding:5px 10px;border-radius:9px}
  .valve b{font-weight:600}
  .sd{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  .sd.ok{background:#34c759}.sd.pending{background:#ff9f0a;animation:p 1s infinite alternate}.sd.error,.sd.err{background:#ff453a}.sd.ha{background:#ff9f0a}
  @keyframes p{to{opacity:.3}}
  .tip{position:absolute;z-index:5;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.85);color:#fff;font-size:12px;pointer-events:none;transform:translate(-50%,-150%);display:none;white-space:nowrap}
  @media (max-width:500px){.cell{height:24px}.nowt b{font-size:20px}}
  `;

  if (!customElements.get('danfoss-schedule-card')) customElements.define('danfoss-schedule-card', DanfossScheduleCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'danfoss-schedule-card'))
    window.customCards.push({ type: 'danfoss-schedule-card', name: 'Danfoss Schedule Card', description: 'Paint-grid week schedule for Danfoss Ally TRVs (ZHA + pyscript)', preview: true });
  console.info(`%c DANFOSS-SCHEDULE-CARD %c v${VERSION} `, 'background:#ff8a3d;color:#fff;font-weight:700', 'background:#333;color:#fff');
})();
