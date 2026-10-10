/*
 * danfoss-schedule-card  v1.8
 * Paint-grid week schedule for Danfoss Ally TRVs (ZHA and/or Zigbee2MQTT) – backend: pyscript/climate_schedule.py
 *
 * type: custom:danfoss-schedule-card
 * schedule_id: living_room            # required
 * title: Living room
 * icon: mdi:thermometer               # any mdi: icon, or an emoji
 * temperature_sensor: sensor.living_room_temperature   # optional, room temperature in the header
 * climates:                           # climate entities (or {entity, ieee} / {entity, z2m})
 *   - climate.living_room_trv_1
 * mode: native                        # native = program valves | ha = HA sets temperature
 * presets:                            # edited in the card editor, applied with Save & program
 *   - {name: Comfort, temp: 23, color: "#ff8a3d"}
 */
(() => {
  const VERSION = '1.8.0';
  const SLOTS = 48, SLOT_MIN = 30, MAX_BLOCKS = 6, MAX_PRESETS = 8;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DEFAULT_PRESETS = [
    { name: 'Eco', temp: 19, color: '#34c759' },
    { name: 'Night', temp: 17.5, color: '#5e5ce6' },
    { name: 'Away', temp: 15, color: '#8e8e93' },
    { name: 'Comfort', temp: 23, color: '#ff8a3d' },
    { name: 'Warm', temp: 25, color: '#ff453a' },
  ];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fromBlocks = (bl) => { let s = ''; bl.forEach(([start, p], i) => { const end = i + 1 < bl.length ? bl[i + 1][0] : SLOTS; s += String(p).repeat(end - start); }); return s; };
  const defaultDays = () => {
    // indexes into DEFAULT_PRESETS: 0 Eco, 1 Night, 2 Away, 3 Comfort
    const wd = fromBlocks([[0, 1], [13, 3], [16, 2], [34, 3], [45, 1]]);
    const we = fromBlocks([[0, 1], [16, 3], [26, 0], [30, 3], [46, 1]]);
    return [wd, wd, wd, wd, wd, we, we];
  };
  const blockCount = (day, presets) => { let n = 0, prev = null; for (const ch of day) { const t = presets[+ch]?.temp; if (t !== prev) { n++; prev = t; } } return n; };
  const errText = (e) => {
    const m = String((e && e.message) || e);
    return /climate_schedule_\w+ not found/i.test(m) ? 'Backend not loaded – copy climate_schedule.py to /config/pyscript/ and reload pyscript (check the HA log for pyscript errors)' : m;
  };
  const BOOST_MINUTES = [30, 60, 120, 180, 0]; // 0 = until the next block change
  const durTxt = (m) => (!m ? 'Until next change' : m < 60 ? `${m} min` : `${m / 60} h`);
  const untilTxt = (iso) => {
    const d = new Date(iso), t = fmt(d.getHours() * 60 + d.getMinutes());
    return d.toDateString() === new Date().toDateString() ? t : `${DAYS[(d.getDay() + 6) % 7]} ${t}`;
  };
  const normP = (ps) => JSON.stringify((ps || []).map((p) => ({ name: String(p.name), temp: +p.temp, color: String(p.color) })));
  const fitDays = (days, n) => days.map((d) => d.replace(/./g, (ch) => (+ch < n ? ch : '0')));
  const nowPos = () => { const d = new Date(); return { day: (d.getDay() + 6) % 7, min: d.getHours() * 60 + d.getMinutes() }; };

  class DanfossScheduleCard extends HTMLElement {
    static getStubConfig() { return { schedule_id: 'living_room', title: 'Living room', climates: [] }; }
    static getConfigElement() { return document.createElement('danfoss-schedule-card-editor'); }
    getCardSize() { return 7; }
    getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

    setConfig(cfg) {
      if (!cfg || !cfg.schedule_id) throw new Error('schedule_id is required');
      this._cfg = { mode: 'native', title: cfg.schedule_id, ...cfg };
      this._eid = 'pyscript.climate_schedule_' + slug(cfg.schedule_id);
      this._sel = this._sel || 0;
      this._draft = null;
      this._editing = false;
      this._msg = null;
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this._render();
    }

    set hass(h) {
      const old = this._hass;
      this._hass = h;
      const watch = [this._eid, ...this._climates(), this._cfg && this._cfg.temperature_sensor].filter(Boolean);
      if (!old || watch.some((id) => old.states[id] !== h.states[id])) { if (!this._hold()) this._render(); }
    }

    connectedCallback() { this._timer = setInterval(() => { if (!this._hold()) this._render(); }, 60000); }
    disconnectedCallback() { clearInterval(this._timer); }

    _hold() { return this._painting; }

    /* ---------- data ---------- */
    _entity() { return this._hass && this._hass.states[this._eid]; }
    _saved() { const e = this._entity(); return e && Array.isArray(e.attributes.days) ? { presets: e.attributes.presets, days: e.attributes.days } : null; }
    _cfgPresets() { const p = this._cfg.presets; return p && p.length ? p : null; }
    /* presets edited in the card editor replace the saved ones once Save & program is pressed */
    _presetsChanged() { const s = this._saved(), cp = this._cfgPresets(); return !!(s && cp && normP(cp) !== normP(s.presets)); }
    _data() {
      if (this._draft) return this._draft;
      const s = this._saved(), cp = this._cfgPresets();
      if (s) return cp ? { presets: cp, days: fitDays(s.days, cp.length) } : s;
      const presets = cp || DEFAULT_PRESETS;
      return { presets, days: fitDays(defaultDays(), presets.length) };
    }
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
          z2m_base_topic: this._cfg.z2m_base_topic,
        });
        this._draft = null; this._editing = false;
        this._toast(this._cfg.mode === 'ha' ? 'Saved – HA will set temperatures' : 'Saved – programming valves…');
      } catch (e) { this._toast('Save failed: ' + errText(e), true); }
      this._busy = false; this._render();
    }
    async _resync() {
      try { await this._hass.callService('pyscript', 'climate_schedule_push', { schedule_id: slug(this._cfg.schedule_id) }); this._toast('Re-sync started'); }
      catch (e) { this._toast('Re-sync failed: ' + errText(e), true); }
    }
    _toast(text, err = false) { this._msg = { text, err }; clearTimeout(this._mt); this._mt = setTimeout(() => { this._msg = null; this._render(); }, 5000); this._render(); }
    _openBoost(cur, presets) {
      this._bo = true; this._bm = 60;
      // a boost should be warm: the warmest preset, or 2° above now if that is higher
      this._bt = Math.min(30, Math.round(Math.max(+cur.t + 2, ...presets.map((p) => +p.temp)) * 2) / 2);
      this._render();
    }
    async _boostStart() {
      try {
        await this._hass.callService('pyscript', 'climate_schedule_boost', { schedule_id: slug(this._cfg.schedule_id), temperature: this._bt, minutes: this._bm });
        this._bo = false; this._toast(`Boost ${this._bt.toFixed(1)}° – ${durTxt(this._bm).toLowerCase()}`);
      } catch (e) { this._toast('Boost failed: ' + errText(e), true); }
    }
    async _boostCancel() {
      try { await this._hass.callService('pyscript', 'climate_schedule_boost_cancel', { schedule_id: slug(this._cfg.schedule_id) }); this._toast('Boost cancelled, back to the schedule'); }
      catch (e) { this._toast('Cancel failed: ' + errText(e), true); }
    }
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
      if (!this._editing) return; // view mode: taps and swipes must not paint (mobile scrolling)
      const g = this.shadowRoot.querySelector('.grid');
      g.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('cell')) return; e.preventDefault(); g.setPointerCapture(e.pointerId); this._painting = true; this._paintAt(e.clientX, e.clientY); });
      g.addEventListener('pointermove', (e) => { if (this._painting) this._paintAt(e.clientX, e.clientY); });
      const up = () => { if (!this._painting) return; this._painting = false; this._anchor = null; this._snap = null; this._render(); };
      g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    }

    /* ---------- render ---------- */
    _render() {
      if (!this.shadowRoot || !this._cfg) return;
      const data = this._data(), ent = this._entity(), ed = !!this._editing, pc = this._presetsChanged(), dirty = !!this._draft || pc;
      const invalid = this._invalid(data), cur = this._current(data), np = nowPos();
      const status = ent?.attributes.status || {};
      const mode = this._cfg.mode;

      const chips = data.presets.map((p, i) => `
        <div class="chip${ed ? ' pick' : ''}${ed && i === this._sel ? ' on' : ''}" data-i="${i}" style="--c:${p.color}">
          <span class="dot"></span><span class="nm">${esc(p.name)}</span><span class="tv">${(+p.temp).toFixed(1)}°</span>
        </div>`).join('');

      const rows = DAYS.map((name, d) => {
        const n = blockCount(data.days[d], data.presets);
        let cells = '';
        for (let c = 0; c < SLOTS; c++) cells += `<div class="cell${c === SLOTS - 1 ? '' : c % 12 === 11 ? ' l6' : c % 2 ? ' l1' : ' l0'}" data-d="${d}" data-c="${c}" style="background:${data.presets[+data.days[d][c]].color}"></div>`;
        const now = d === np.day ? `<div class="now" style="left:${(np.min / 1440) * 100}%"></div>` : '';
        return `<div class="row${n > MAX_BLOCKS ? ' over' : ''}" data-d="${d}">
          <div class="dl${d === np.day ? ' today' : ''}">${name}</div>
          <div class="cells">${cells}${now}</div>
          <div class="cnt${n > MAX_BLOCKS ? ' over' : ''}" data-d="${d}">${n}/${MAX_BLOCKS}</div></div>`;
      }).join('');

      /* every hour is rendered; CSS container queries hide some when the card is narrow */
      const ticks = Array.from({ length: 25 }, (_, h) => `<span class="hr${h % 2 ? '' : ' m2'}${h % 3 ? '' : ' m3'}${h % 6 ? '' : ' m6'}" style="left:${(h / 24) * 100}%">${h}</span>`).join('');

      const cfgC = {}; (this._cfg.climates || []).forEach((x) => { if (typeof x !== 'string') cfgC[x.entity] = x; });
      const valves = this._climates().map((id) => {
        const st = this._hass?.states[id], s = status[id];
        const plat = cfgC[id]?.z2m ? 'mqtt' : cfgC[id]?.ieee ? 'zha' : this._hass?.entities?.[id]?.platform;
        const via = plat === 'zha' ? 'ZHA' : plat === 'mqtt' ? 'Z2M' : '';
        const name = st?.attributes.friendly_name || id;
        const temp = st?.attributes.current_temperature;
        const cls = mode === 'ha' ? 'ha' : !st || st.state === 'unavailable' ? 'err' : s ? s.state : 'unknown';
        const last = s ? `${s.state} · ${s.at?.replace('T', ' ') || ''} ${s.msg || ''}`.trim() : 'not programmed yet';
        const title = !st ? 'Entity not found in Home Assistant'
          : st.state === 'unavailable' ? `Valve unavailable in Home Assistant (no contact). Last programming: ${last}`
          : mode === 'ha' ? 'HA-driven' : last;
        return `<div class="valve" title="${esc(title)}"><span class="sd ${cls}"></span>${esc(name)}${temp != null ? `<b>${(+temp).toFixed(1)}°</b>` : ''}${via ? `<span class="via">${via}</span>` : ''}</div>`;
      }).join('');

      const savedTxt = !ent ? 'Not saved yet' : dirty ? 'Unsaved changes' : `Saved ${ent.attributes.updated ? ent.attributes.updated.slice(5, 16).replace('T', ' ') : ''}`;

      const icon = this._cfg.icon || 'mdi:thermometer';
      const rs = this._cfg.temperature_sensor && this._hass?.states[this._cfg.temperature_sensor];
      const room = rs && !isNaN(parseFloat(rs.state)) ? `${parseFloat(rs.state).toFixed(1)}°` : rs ? '—' : null;
      const boost = ent?.attributes.boost;
      const nowHtml = boost
        ? `<b style="color:#ff453a">${(+boost.temp).toFixed(1)}°</b><div class="s">Boost until ${boost.kind === 'next' ? 'next change, ' : ''}${untilTxt(boost.until)}</div>`
        : `<b style="color:${data.presets[cur.p].color}">${(+cur.t).toFixed(1)}°</b><div class="s">${esc(data.presets[cur.p].name)}${cur.until ? ' until ' + cur.until : ''}</div>`;
      const boostPanel = this._bo && !ed ? `
        <div class="boost">
          <div class="brow"><span class="bl">Boost to</span><button class="tb" data-b="-1">−</button><b class="bt">${this._bt.toFixed(1)}°</b><button class="tb" data-b="1">+</button></div>
          <div class="brow"><span class="bl">For</span>${BOOST_MINUTES.map((m) => `<button class="dur${m === this._bm ? ' on' : ''}" data-m="${m}">${durTxt(m)}</button>`).join('')}</div>
          <div class="brow end"><button class="btn" data-a="bclose">Cancel</button><button class="btn pri" data-a="bstart">Start boost</button></div>
        </div>` : '';
      const saveBtn = `<button class="btn pri" data-a="save" ${invalid || this._busy || (!dirty && ent) ? 'disabled' : ''}>${this._busy ? 'Saving…' : mode === 'ha' ? 'Save' : 'Save & program'}</button>`;
      const tools = ed ? `
          <button class="btn" data-a="wd" title="Copy Monday's schedule to Tuesday–Friday">Copy Mon → Tue–Fri</button>
          <button class="btn" data-a="we" title="Copy Saturday's schedule to Sunday">Copy Sat → Sun</button>
          <span class="sp"></span>
          <button class="btn" data-a="cancel">Cancel</button>
          ${saveBtn}` : `
          <button class="btn" data-a="edit">✎ Edit schedule</button>
          ${ent ? (boost ? '<button class="btn hot" data-a="unboost">Cancel boost</button>' : '<button class="btn" data-a="boost">🔥 Boost</button>') : ''}
          <span class="sp"></span>
          ${ent && mode === 'native' && !pc ? '<button class="btn" data-a="resync">Re-sync</button>' : ''}
          ${pc || !ent ? saveBtn : ''}`;
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
      <ha-card>
        <div class="head">
          <div class="ic">${icon.includes(':') ? `<ha-icon icon="${esc(icon)}"></ha-icon>` : esc(icon)}</div>
          <div class="ttl"><div class="t">${esc(this._cfg.title)}</div>
            <div class="s"><span class="badge ${mode}">${mode === 'ha' ? 'HA-driven' : 'On-valve schedule'}</span> ${savedTxt}</div></div>
          <div class="nowt">
            ${room ? `<div class="room" title="${esc(rs.attributes.friendly_name || this._cfg.temperature_sensor)}"><b>${room}</b><div class="s">Room</div></div>` : ''}
            <div>${nowHtml}</div>
          </div>
        </div>
        <div class="presets">${chips}</div>
        ${ed ? '<div class="hint">Pick a preset, then drag over the grid to paint.</div>' : ''}
        <div class="ruler"><span></span><div class="ticks">${ticks}</div><span></span></div>
        <div class="grid${ed ? ' editing' : ''}">${rows}</div>
        <div class="tools">${tools}
        </div>${boostPanel}
        ${pc && !ed ? '<div class="note">Presets were changed in the card editor. Press <b>Save &amp; program</b> to apply them.</div>' : ''}
        ${invalid ? `<div class="warn">⚠ ${esc(invalid)}</div>` : ''}
        ${this._msg ? `<div class="msg ${this._msg.err ? 'err' : ''}">${esc(this._msg.text)}</div>` : ''}
        <div class="valves">${valves || '<span class="s">No climates configured</span>'}</div>
        <div class="tip"></div>
      </ha-card>`;

      const root = this.shadowRoot;
      if (ed) root.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', () => { this._sel = +el.dataset.i; this._render(); }));
      root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'wd') this._copy(0, [1, 2, 3, 4]);
        else if (a === 'we') this._copy(5, [6]);
        else if (a === 'boost') this._openBoost(cur, data.presets);
        else if (a === 'bclose') { this._bo = false; this._render(); }
        else if (a === 'bstart') this._boostStart();
        else if (a === 'unboost') this._boostCancel();
        else if (a === 'edit') { this._bo = false; this._editing = true; this._sel = Math.min(this._sel, data.presets.length - 1); this._render(); }
        else if (a === 'cancel') { this._draft = null; this._editing = false; this._render(); }
        else if (a === 'resync') this._resync();
        else if (a === 'save') this._save();
      }));
      root.querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => { this._bt = Math.max(5, Math.min(30, this._bt + 0.5 * +b.dataset.b)); this._render(); }));
      root.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { this._bm = +b.dataset.m; this._render(); }));
      this._bindGrid();
    }
  }

  const CSS = `
  :host{--bg2:var(--secondary-background-color,#2a2a2e);--txt:var(--primary-text-color,#f2f2f4);--mut:var(--secondary-text-color,#8e8e96);--acc:var(--primary-color,#0a84ff);--ln:var(--divider-color,#38383d)}
  ha-card{display:block;container-type:inline-size;padding:16px;position:relative;color:var(--txt);overflow:hidden;background:var(--ha-card-background,var(--card-background-color,#1f1f22));border-radius:var(--ha-card-border-radius,12px)}
  .head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .ic{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-size:20px;background:rgba(255,138,61,.16);color:#ff8a3d;flex:none}
  .ic ha-icon{--mdc-icon-size:24px}
  .ttl{min-width:0}.t{font-weight:600;font-size:16px}.s{color:var(--mut);font-size:12px}
  .badge{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;background:rgba(10,132,255,.18);color:var(--acc);margin-right:4px}
  .badge.ha{background:rgba(255,159,10,.18);color:#ff9f0a}
  .nowt{margin-left:auto;text-align:right;flex:none;display:flex;gap:20px;align-items:flex-start}.nowt b{font-size:24px;font-weight:600}
  .room{padding-right:20px;border-right:1px solid var(--ln)}.room b{color:var(--txt)}
  .presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .chip{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:12px;background:var(--bg2);border:2px solid transparent;user-select:none}
  .chip.pick{cursor:pointer}
  .chip.on{border-color:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 25%,transparent)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--c)}
  .nm{font-size:13px}.tv{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px}
  .hint{color:var(--mut);font-size:12px;margin:-4px 0 8px}
  .btn.hot{border-color:#ff453a;color:#ff453a}
  .boost{margin-top:10px;padding:10px 12px;border-radius:12px;background:var(--bg2);display:flex;flex-direction:column;gap:8px}
  .brow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.brow.end{justify-content:flex-end}
  .bl{color:var(--mut);font-size:13px;min-width:62px}
  .bt{font-size:18px;font-weight:600;min-width:56px;text-align:center;color:#ff453a;font-variant-numeric:tabular-nums}
  .tb{border:0;background:var(--ln);color:var(--txt);width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}
  .dur{border:1px solid var(--ln);background:transparent;color:var(--txt);padding:5px 10px;border-radius:9px;cursor:pointer;font:inherit;font-size:13px}
  .dur.on{border-color:#ff453a;background:color-mix(in srgb,#ff453a 15%,transparent)}
  .ruler,.row{display:grid;grid-template-columns:34px 1fr 34px;align-items:center;column-gap:6px}
  .ticks{position:relative;height:14px;color:var(--mut);font-size:10px}
  .ticks span{position:absolute;transform:translateX(-50%)}.ticks span:first-child{transform:none}.ticks span:last-child{transform:translateX(-100%)}
  .ticks .hr{display:none}.ticks .m6{display:block}
  @container (min-width:300px){.ticks .m3{display:block}}
  @container (min-width:380px){.ticks .m3{display:none}.ticks .m2{display:block}}
  @container (min-width:600px){.ticks .hr{display:block}}
  .grid{user-select:none}.grid.editing{touch-action:none}
  .row{margin:3px 0}
  .dl{font-weight:600;color:var(--mut);font-size:12px}.dl.today{color:var(--acc)}
  .cells{position:relative;display:grid;grid-template-columns:repeat(48,1fr);border-radius:7px;overflow:hidden;outline:2px solid transparent;outline-offset:1px}
  .row.over .cells{outline-color:#ff453a}
  .cell{height:30px}.grid.editing .cell{cursor:cell}
  /* separators are cut out of the cell with a mask, so the card background shows through like a gap
     (themes may use a gradient as card background, which can't be used as a line colour) */
  .cell.l0{-webkit-mask:linear-gradient(to left,rgba(0,0,0,.45) 1px,#000 1px);mask:linear-gradient(to left,rgba(0,0,0,.45) 1px,#000 1px)}
  .cell.l1{-webkit-mask:linear-gradient(to left,transparent 1px,#000 1px);mask:linear-gradient(to left,transparent 1px,#000 1px)}
  .cell.l6{-webkit-mask:linear-gradient(to left,transparent 2px,#000 2px);mask:linear-gradient(to left,transparent 2px,#000 2px)}
  .now{position:absolute;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 5px rgba(0,0,0,.7);pointer-events:none}
  .cnt{font-size:11px;color:var(--mut);text-align:right;font-variant-numeric:tabular-nums}.cnt.over{color:#ff453a;font-weight:700}
  .tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}.sp{flex:1}
  .btn{border:1px solid var(--ln);background:var(--bg2);color:var(--txt);padding:7px 12px;border-radius:10px;cursor:pointer;font:inherit;font-size:13px}
  .btn:hover:not([disabled]){border-color:var(--acc)}
  .btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
  .btn[disabled]{opacity:.4;cursor:default}
  .note{margin-top:10px;padding:8px 12px;border-radius:10px;font-size:13px;background:color-mix(in srgb,var(--acc) 12%,transparent)}
  .warn,.msg{margin-top:10px;padding:8px 12px;border-radius:10px;font-size:13px}
  .warn{background:rgba(255,69,58,.15);color:#ff6961}
  .msg{background:rgba(52,199,89,.15);color:#34c759}.msg.err{background:rgba(255,69,58,.15);color:#ff6961}
  .valves{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--ln)}
  .valve{display:flex;align-items:center;gap:6px;font-size:12px;background:var(--bg2);padding:5px 10px;border-radius:9px}
  .valve b{font-weight:600}
  .via{font-size:9px;font-weight:700;letter-spacing:.3px;padding:1px 4px;border-radius:4px;background:var(--ln);color:var(--mut)}
  .sd{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  .sd.ok{background:#34c759}.sd.pending{background:#ff9f0a;animation:p 1s infinite alternate}.sd.error,.sd.err{background:#ff453a}.sd.ha{background:#ff9f0a}
  @keyframes p{to{opacity:.3}}
  .tip{position:absolute;z-index:5;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.85);color:#fff;font-size:12px;pointer-events:none;transform:translate(-50%,-150%);display:none;white-space:nowrap}
  @media (max-width:500px){.cell{height:24px}.nowt b{font-size:20px}.nowt{gap:12px}.room{padding-right:12px}}
  `;

  /* ---------- visual editor ---------- */
  const EDITOR_SCHEMA = [
    { name: 'schedule_id', required: true, selector: { text: {} } },
    { name: 'title', selector: { text: {} } },
    { name: 'icon', selector: { icon: { placeholder: 'mdi:thermometer' } } },
    { name: 'climates', selector: { entity: { multiple: true, filter: { domain: 'climate' } } } },
    { name: 'temperature_sensor', selector: { entity: { filter: { domain: 'sensor', device_class: 'temperature' } } } },
    { name: 'mode', selector: { select: { mode: 'dropdown', options: [
      { value: 'native', label: 'Native – program the valves' },
      { value: 'ha', label: 'HA – Home Assistant sets the temperature' },
    ] } } },
    { name: 'oper_mode', selector: { number: { min: 0, max: 255, mode: 'box' } } },
    { name: 'z2m_base_topic', selector: { text: {} } },
  ];
  const EDITOR_LABELS = {
    schedule_id: ['Schedule ID', 'Unique per room. Changing it starts a new, empty schedule.'],
    title: ['Title'],
    icon: ['Icon', 'Shown next to the title. Leave empty for mdi:thermometer.'],
    climates: ['Valves', 'All valves on this card get the same schedule.'],
    temperature_sensor: ['Room temperature sensor', 'Optional. Shown in the header next to the target temperature.'],
    mode: ['Mode', 'Native keeps running even when HA or Zigbee is down.'],
    oper_mode: ['Operation mode after upload', 'Advanced. programming_operation_mode written after programming (default 1 = schedule).'],
    z2m_base_topic: ['Zigbee2MQTT base topic', 'Only for Zigbee2MQTT valves. Leave empty for the default "zigbee2mqtt".'],
  };
  const PALETTE = ['#ff8a3d', '#34c759', '#5e5ce6', '#8e8e93', '#ff453a', '#0a84ff', '#ffd60a', '#bf5af2'];

  class DanfossScheduleCardEditor extends HTMLElement {
    setConfig(cfg) { this._cfg = { ...cfg }; this._render(); }
    set hass(h) { this._hass = h; if (this._form) { this._form.hass = h; this._renderNote(); this._syncPresets(); } }

    _emit(cfg) {
      this._cfg = cfg;
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: cfg }, bubbles: true, composed: true }));
    }
    _saved() {
      const id = this._cfg && this._cfg.schedule_id, e = id && this._hass && this._hass.states['pyscript.climate_schedule_' + slug(id)];
      return e && Array.isArray(e.attributes.days) ? e.attributes : null;
    }
    _cfgPresets() { return this._cfg.presets && this._cfg.presets.length ? this._cfg.presets : null; }
    /* what the schedule uses now: the editor's own changes, else the saved presets */
    _presets() { const s = this._saved(); return this._cfgPresets() || (s ? s.presets : DEFAULT_PRESETS); }
    /* removing a preset shifts the indexes after it, so only the last one can go, and only if it is unused */
    _lastUsed() { const s = this._saved(), n = String(this._presets().length - 1); return !!(s && s.days.some((d) => d.includes(n))); }
    _key() { return JSON.stringify(this._presets()) + '|' + this._lastUsed(); }
    _syncPresets() { if (this.shadowRoot && this._key() !== this._shown) this._renderPresets(); }
    /* remember what is on screen before emitting, so the setConfig echo does not rebuild the inputs (keeps focus) */
    _setPresets(list) { this._cfg = { ...this._cfg, presets: list }; this._shown = this._key(); this._emit(this._cfg); }

    _formChanged(v) {
      const ieee = {};
      (this._cfg.climates || []).forEach((x) => { if (typeof x !== 'string') ieee[x.entity] = x; });
      const cfg = { ...this._cfg };
      for (const { name } of EDITOR_SCHEMA) {
        const val = v[name];
        if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) delete cfg[name];
        else cfg[name] = val;
      }
      if (cfg.climates) cfg.climates = cfg.climates.map((id) => ieee[id] || id); // keep {entity, ieee|z2m} overrides
      this._emit(cfg);
    }

    _render() {
      if (!this._cfg) return;
      if (!this.shadowRoot) this._build();
      this._form.hass = this._hass;
      this._form.data = { mode: 'native', ...this._cfg, climates: (this._cfg.climates || []).map((x) => (typeof x === 'string' ? x : x.entity)) };
      this._renderNote();
      this._syncPresets();
    }

    _build() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${EDITOR_CSS}</style>
        <ha-form></ha-form>
        <div class="sec">Presets</div>
        <div class="note"></div>
        <div class="plist"></div>
        <button class="add">+ Add preset</button>`;
      this._form = root.querySelector('ha-form');
      this._form.schema = EDITOR_SCHEMA;
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name]?.[0] ?? s.name;
      this._form.computeHelper = (s) => EDITOR_LABELS[s.name]?.[1];
      this._form.addEventListener('value-changed', (e) => this._formChanged(e.detail.value));

      root.querySelector('.note').addEventListener('click', (e) => {
        if (!e.target.closest('.undo')) return;
        const cfg = { ...this._cfg }; delete cfg.presets; // back to the saved presets
        this._emit(cfg); this._renderPresets(); this._renderNote();
      });
      const pl = root.querySelector('.plist');
      pl.addEventListener('input', (e) => {
        const k = e.target.dataset.k; if (!k) return;
        const i = +e.target.closest('.pr').dataset.i, list = clone(this._presets());
        if (k === 'temp') { if (e.target.value === '' || isNaN(+e.target.value)) return; list[i].temp = +e.target.value; }
        else list[i][k] = e.target.value;
        this._setPresets(list);
      });
      pl.addEventListener('click', (e) => {
        const b = e.target.closest('.del'); if (!b) return;
        const list = clone(this._presets()); list.pop();
        this._setPresets(list); this._renderPresets();
      });
      root.querySelector('.add').addEventListener('click', () => {
        const list = clone(this._presets());
        if (list.length >= MAX_PRESETS) return;
        list.push({ name: `Preset ${list.length + 1}`, temp: 20, color: PALETTE[list.length % PALETTE.length] });
        this._setPresets(list); this._renderPresets();
      });
    }

    _renderNote() {
      const note = this.shadowRoot && this.shadowRoot.querySelector('.note'); if (!note) return;
      const s = this._saved(), cp = this._cfgPresets(), changed = !!(s && cp && normP(cp) !== normP(s.presets));
      const html = changed
        ? 'Changed. Press <b>Save &amp; program</b> on the card to send them to the valves. <button class="undo">Undo changes</button>'
        : 'Changes are sent to the valves when you press <b>Save &amp; program</b> on the card.';
      if (html !== this._noteHtml) { note.innerHTML = html; this._noteHtml = html; }
      note.classList.toggle('warn', changed);
    }

    _renderPresets() {
      const list = this._presets(), last = list.length - 1, used = this._lastUsed();
      this._shown = this._key();
      this.shadowRoot.querySelector('.plist').innerHTML = list.map((p, i) => `
        <div class="pr" data-i="${i}">
          <input type="color" data-k="color" value="${esc(p.color)}" title="Color">
          <input type="text" data-k="name" value="${esc(p.name)}" placeholder="Name">
          <input type="number" data-k="temp" value="${esc(p.temp)}" min="5" max="30" step="0.5"><span class="u">°C</span>
          ${i === last ? `<button class="del" title="${used ? 'Used in the schedule – paint it over on the card first' : 'Remove'}" ${list.length <= 1 || used ? 'disabled' : ''}>✕</button>` : '<span class="del-sp"></span>'}
        </div>`).join('');
      this.shadowRoot.querySelector('.add').disabled = list.length >= MAX_PRESETS;
    }
  }

  const EDITOR_CSS = `
  :host{display:block}
  .sec{font-weight:500;margin:24px 0 2px}
  .note{font-size:12px;color:var(--secondary-text-color);margin-bottom:8px}
  .note.warn{color:var(--warning-color,#ff9f0a)}
  .pr{display:flex;align-items:center;gap:8px;margin:6px 0}
  input{font:inherit;color:var(--primary-text-color);background:var(--secondary-background-color);border:1px solid var(--divider-color);border-radius:6px;padding:6px 8px;box-sizing:border-box;height:36px}
  input[type=color]{width:40px;padding:2px;cursor:pointer;flex:none}
  input[type=text]{flex:1;min-width:0}
  input[type=number]{width:76px;flex:none}
  .u{color:var(--secondary-text-color);font-size:13px}
  button{font:inherit;cursor:pointer;border:1px solid var(--divider-color);background:transparent;color:var(--primary-text-color);border-radius:6px;padding:6px 10px}
  button[disabled]{opacity:.4;cursor:default}
  .add{margin-top:4px}
  .del,.del-sp{width:34px;flex:none}
  .note .undo{margin-left:6px;padding:2px 8px;font-size:12px}
  `;

  if (!customElements.get('danfoss-schedule-card-editor')) customElements.define('danfoss-schedule-card-editor', DanfossScheduleCardEditor);
  if (!customElements.get('danfoss-schedule-card')) customElements.define('danfoss-schedule-card', DanfossScheduleCard);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'danfoss-schedule-card'))
    window.customCards.push({ type: 'danfoss-schedule-card', name: 'Danfoss Schedule Card', description: 'Paint-grid week schedule for Danfoss Ally TRVs (ZHA / Zigbee2MQTT + pyscript)', preview: true });
  console.info(`%c DANFOSS-SCHEDULE-CARD %c v${VERSION} `, 'background:#ff8a3d;color:#fff;font-weight:700', 'background:#333;color:#fff');
})();
