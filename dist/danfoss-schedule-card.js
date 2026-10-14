/*
 * danfoss-schedule-card  v1.16
 * Paint-grid week schedule for Danfoss Ally TRVs (ZHA and/or Zigbee2MQTT) – backend: pyscript/climate_schedule.py
 *
 * type: custom:danfoss-schedule-card
 * schedule_id: living_room            # required
 * title: Living room
 * icon: mdi:thermometer               # any mdi: icon, or an emoji
 * temperature_sensor: sensor.living_room_temperature   # optional, room temperature in the header
 * show_graph: true                    # room temperature + target history (needs temperature_sensor)
 * battery_low: 15                     # %, valve battery shown red below this
 * presence_persons: [person.a, person.b]  # home mode while at least one of them is home
 * presence_replace: [Away]            # presets raised in home mode
 * presence_preset: Comfort            # …to this preset
 * presence_delay: 30                  # min a change of who is home must last (both ways)
 * climates:                           # climate entities (or {entity, ieee} / {entity, z2m})
 *   - climate.living_room_trv_1
 * mode: native                        # native = program valves | ha = HA sets temperature
 * presets:                            # edited in the card editor, applied with Save & program
 *   - {name: Comfort, temp: 23, color: "#ff8a3d"}
 */
(() => {
  const VERSION = '1.16.1';
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
  const GH = 110; // graph plot height, px
  const BATTERY_LOW = 15; // %, default for battery_low: the valve chip's battery turns red below this
  const G_LO = 5, G_HI = 35; // fixed scale = the Ally's setpoint range, same on every card
  const HIST_REFRESH = 10 * 60e3;
  const HIST_TIMEOUT = 20e3; // a request lost while the tab slept must not block reloads forever
  /* a room temperature outside this range is a sensor glitch (e.g. 327.67 / 655.35 from an invalid
     reading): dropped, so the line continues instead of spiking. unavailable/unknown stay gaps. */
  const reading = (state) => { const v = parseFloat(state); return isNaN(v) ? NaN : v < -30 || v > 60 ? null : v; };
  const durTxt = (m) => (!m ? 'Until next change' : m < 60 ? `${m} min` : `${m / 60} h`);
  const untilTxt = (iso) => { // backend times are local wall-clock strings (no zone); also takes a Date
    const d = iso instanceof Date ? iso : new Date(iso), t = fmt(d.getHours() * 60 + d.getMinutes());
    return d.toDateString() === new Date().toDateString() ? t : `${DAYS[(d.getDay() + 6) % 7]} ${t}`;
  };
  const presenceCfg = (cfg, presets) => {
    const names = presets.map((p) => p.name);
    return {
      persons: cfg.presence_persons || [],
      replace: cfg.presence_replace || (names.includes('Away') ? ['Away'] : []),
      preset: cfg.presence_preset || (names.includes('Comfort') ? 'Comfort' : null),
      delay: cfg.presence_delay != null && cfg.presence_delay !== '' ? +cfg.presence_delay : 30,
    };
  };
  const normPresence = (x) => JSON.stringify({ persons: [...(x.persons || [])].sort(), replace: [...(x.replace || [])].sort(), preset: x.preset || null, delay: x.delay ?? 30 });
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
      this._histCheck(old);
      this._syncPresence();
      if (!old || watch.some((id) => old.states[id] !== h.states[id])) { if (!this._hold()) this._render(); }
    }

    connectedCallback() {
      this._timer = setInterval(() => { if (!this._hold()) this._render(); }, 60000);
      if (this._ro) this._ro.observe(this._card);
      /* many cards on a view: only the visible ones (plus a margin) redraw and load history */
      if (!this._io && typeof IntersectionObserver === 'function') {
        this._io = new IntersectionObserver((es) => {
          const v = es[es.length - 1].isIntersecting;
          if (v === this._vis) return;
          this._vis = v;
          if (v) { this._histCheck(null); if (this._dirty && !this._hold()) this._render(); }
        }, { rootMargin: '300px 0px' });
      }
      this._io?.observe(this);
      // back from a sleeping tab: the live updates missed meanwhile are only in the history
      this._onVis = () => { if (document.visibilityState === 'visible' && this._graphOn()) { this._histBusy = 0; this._loadHist(); } };
      document.addEventListener('visibilitychange', this._onVis);
    }
    disconnectedCallback() { clearInterval(this._timer); this._ro?.disconnect(); this._io?.disconnect(); this._vis = undefined; document.removeEventListener('visibilitychange', this._onVis); }

    _hold() { return this._painting; }

    /* ---------- data ---------- */
    _entity() { return this._hass && this._hass.states[this._eid]; }
    _saved() { const e = this._entity(); return e && Array.isArray(e.attributes.days) ? { presets: e.attributes.presets, days: e.attributes.days } : null; }
    _cfgPresets() { const p = this._cfg.presets; return p && p.length ? p : null; }
    /* presets edited in the card editor replace the saved ones once Save & program is pressed */
    _presetsChanged() { const s = this._saved(), cp = this._cfgPresets(); return !!(s && cp && normP(cp) !== normP(s.presets)); }
    /* settings that live in the backend schedule and only reach it with Save & program */
    _settingsChanged() { const e = this._entity(); return !!(e && Array.isArray(e.attributes.days) && !!this._cfg.nightly_resync !== !!e.attributes.nightly_resync); }
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
          z2m_base_topic: this._cfg.z2m_base_topic, nightly_resync: !!this._cfg.nightly_resync,
        });
        this._draft = null; this._editing = false;
        this._toast(this._cfg.mode === 'ha' ? 'Saved – HA will set temperatures' : 'Saved – programming valves…');
      } catch (e) { this._toast('Save failed: ' + errText(e), true); }
      this._busy = false; this._render();
    }
    async _retryValve(eid) {
      try {
        await this._hass.callService('pyscript', 'climate_schedule_push', { schedule_id: slug(this._cfg.schedule_id), valve: eid });
        this._toast(`Programming ${this._hass.states[eid]?.attributes.friendly_name || eid} again…`);
      } catch (e) { this._toast('Retry failed: ' + errText(e), true); }
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
    /* presence settings live in the card config; the backend needs them even when no card is open */
    _syncPresence() {
      const e = this._entity();
      if (!e || !Array.isArray(e.attributes.days) || !this._hass?.callService) return;
      const want = presenceCfg(this._cfg, e.attributes.presets || []), have = e.attributes.presence || {};
      if (!want.persons.length && !(have.persons || []).length) return; // presence not used
      const key = normPresence(want);
      if (key === normPresence(have) || key === this._sentPresence) return;
      this._sentPresence = key;
      this._hass.callService('pyscript', 'climate_schedule_settings', {
        schedule_id: slug(this._cfg.schedule_id), presence_persons: want.persons, presence_replace: want.replace, presence_preset: want.preset,
        presence_delay: want.delay,
      }).catch(() => { this._sentPresence = null; });
    }
    _presenceBadge(pst) {
      if (!pst) return '';
      const names = (pst.who || []).map((p) => this._hass?.states[p]?.attributes.friendly_name || p).join(', ');
      const at = pst.since ? untilTxt(new Date(Date.parse(pst.since) + (pst.delay || 0) * 60e3)) : '';
      const home = pst.home ?? !!pst.who?.length; // older backends had no "home"
      if (pst.active) {
        const title = pst.pending === false && !pst.manual ? `Nobody home since ${untilTxt(pst.since)} – back to the schedule at ${at} unless someone comes back`
          : home && names ? `Home: ${names}` : 'Home today (manual, until midnight)';
        return `<span class="badge home" title="${esc(title)}">🏠 Home${!home && pst.manual ? ' today' : ''}${pst.pending === false && !pst.manual ? ` · until ${at}` : ''}</span>`;
      }
      if (pst.pending === true) return `<span class="badge home soon" title="${esc(`${names} home – home mode starts at ${at} if it stays so`)}">🏠 from ${at}</span>`;
      return '';
    }
    async _homeToday(on) {
      try {
        await this._hass.callService('pyscript', 'climate_schedule_home_today', { schedule_id: slug(this._cfg.schedule_id), enable: on });
        this._toast(on ? 'Home today: on until midnight' : 'Home today: off');
      } catch (e) { this._toast('Home today failed: ' + errText(e), true); }
    }

    /* ---------- valve device helpers ---------- */
    /* entity ids of the same device (battery sensor, Z2M limit numbers); the map is rebuilt
       only when HA hands out a new entity registry */
    _devEntities(eid) {
      const ents = this._hass?.entities;
      if (!ents) return [];
      if (this._devMapFor !== ents) {
        this._devMap = {};
        for (const [id, e] of Object.entries(ents)) if (e.device_id) (this._devMap[e.device_id] ||= []).push(id);
        this._devMapFor = ents;
      }
      return this._devMap[ents[eid]?.device_id] || [];
    }
    _battery(eid) {
      for (const id of this._devEntities(eid)) {
        const st = this._hass.states[id];
        if (id.startsWith('sensor.') && st?.attributes.device_class === 'battery' && !isNaN(parseFloat(st.state))) return parseFloat(st.state);
      }
      return null;
    }
    /* the setpoint range the valve accepts: climate min/max_temp, tightened by Z2M's limit numbers */
    _limits(eid) {
      const a = this._hass?.states[eid]?.attributes || {};
      let lo = Math.max(5, parseFloat(a.min_temp) || 5), hi = Math.min(35, parseFloat(a.max_temp) || 35);
      for (const id of this._devEntities(eid)) {
        const v = parseFloat(this._hass.states[id]?.state);
        if (isNaN(v) || !id.startsWith('number.')) continue;
        if (id.endsWith('max_heat_setpoint_limit')) hi = Math.min(hi, v);
        else if (id.endsWith('min_heat_setpoint_limit')) lo = Math.max(lo, v);
      }
      return { lo, hi };
    }

    /* ---------- room temperature history ---------- */
    _graphOn() { return !!(this._cfg && this._cfg.temperature_sensor && this._cfg.show_graph !== false); }
    _histCheck(old) {
      if (!this._graphOn()) return;
      if (this._vis === false) { if (this._hist && old) this._liveOnly(old); return; } // no history load off-screen
      const id = this._cfg.temperature_sensor, h = this._hist;
      if (!h || h.id !== id || Date.now() - h.at > HIST_REFRESH) { this._loadHist(); return; }
      const st = this._hass.states[id];
      if (old && st && old.states[id] !== st) { const v = reading(st.state); if (v !== null) h.pts.push({ t: Date.parse(st.last_updated) || Date.now(), v, raw: st.state, live: true }); }
    }
    _liveOnly(old) { // keep appending live readings while off-screen, so nothing is missing later
      const id = this._cfg.temperature_sensor, st = this._hass.states[id];
      if (st && old.states[id] !== st) { const v = reading(st.state); if (v !== null) this._hist.pts.push({ t: Date.parse(st.last_updated) || Date.now(), v, raw: st.state, live: true }); }
    }
    async _loadHist() {
      if ((this._histBusy && Date.now() - this._histBusy < HIST_TIMEOUT) || !this._hass?.callWS) return;
      const busy = (this._histBusy = Date.now());
      const id = this._cfg.temperature_sensor;
      try { // yesterday 00:00 until now covers both day views
        const y0 = new Date(); y0.setHours(0, 0, 0, 0); y0.setDate(y0.getDate() - 1);
        const r = await Promise.race([
          this._hass.callWS({
            type: 'history/history_during_period', start_time: y0.toISOString(),
            entity_ids: [id], minimal_response: true, no_attributes: true, significant_changes_only: false,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), HIST_TIMEOUT)),
        ]);
        this._hist = { id, at: Date.now(), pts: (r[id] || []).map((x) => ({ t: (x.lu || x.lc) * 1000, v: reading(x.s), raw: x.s })).filter((p) => p.v !== null) };
      } catch (e) {
        // keep what is drawn and try again in a minute; only an empty graph shows the error
        if (this._hist?.id === id && !this._hist.err) this._hist.at = Date.now() - HIST_REFRESH + 60e3;
        else this._hist = { id, at: Date.now(), pts: [], err: true };
      }
      if (this._histBusy === busy) this._histBusy = 0;
      if (!this._hold()) this._render();
    }
    /* one calendar day, laid out exactly like the schedule rows above (same columns, one bar per half hour) */
    _graphHtml(data) {
      this._gm = null;
      if (!this._graphOn()) return '';
      const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
      if (this._gy) d0.setDate(d0.getDate() - 1);
      const start = d0.getTime(), end = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1).getTime(); // DST-safe
      const day = (d0.getDay() + 6) % 7;
      const key = data.presets.slice(0, 3).map((p) => `<b style="background:${p.color}"></b>`).join('');
      const head = `<div class="ghead"><span class="gt">Room temperature</span>
          <button class="gh${this._gy ? ' on' : ''}" data-gy="1">Yesterday</button><button class="gh${this._gy ? '' : ' on'}" data-gy="0">Today</button>
          <span class="sp"></span><span class="lg"><i class="kr"></i>Room</span><span class="lg"><i class="kt">${key}</i>Target</span></div>`;
      const h = this._hist;
      // same three columns as a schedule row: label | 48 cells | counter
      const frame = (left, inner) => `<div class="graph">${head}<div class="gwrap">${left}${inner}<span></span></div></div>`;
      if (!h || h.id !== this._cfg.temperature_sensor || h.err)
        return frame('<span></span>', `<div class="gempty">${h?.err ? 'History not available' : 'Loading history…'}</div>`);

      /* drawn in real pixels, nothing stretched: Safari loses pieces of stretched SVG lines that
         use vector-effect:non-scaling-stroke when it repaints parts of the screen */
      const W = this._pw || 1000;
      const X = (t) => ((t - start) / (end - start)) * W;
      const Y = (v) => GH - ((Math.min(G_HI, Math.max(G_LO, v)) - G_LO) / (G_HI - G_LO)) * GH;
      // target: one bar per half-hour cell of this day's row; the rest of today is faded (planned)
      let bars = '';
      for (let c = 0; c < SLOTS; c++) {
        const p = data.presets[+data.days[day][c]], a = start + c * 1800e3;
        const gap = Math.min(1, W / SLOTS / 8), x0 = (c / SLOTS) * W + gap, x1 = ((c + 1) / SLOTS) * W - gap;
        bars += `<rect x="${x0.toFixed(1)}" y="${Y(+p.temp).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(GH - Y(+p.temp)).toFixed(1)}" style="fill:${p.color}" class="${a > now ? 'eq fut' : 'eq'}"/>`;
      }
      // room readings of this day, the last one before it carried to midnight
      const i0 = h.pts.findIndex((p) => p.t >= start), first = i0 === -1 ? h.pts.length : i0;
      const room = (first > 0 ? [{ t: start, v: h.pts[first - 1].v }] : []).concat(h.pts.slice(first).filter((p) => p.t < end));
      const stop = Math.min(now, end);
      let d = '', pen = false, lastV = null;
      room.forEach((p) => {
        // a reading holds until the next event: before unknown/unavailable, run flat up to that moment
        // (otherwise a value followed by a gap is never drawn, e.g. 20.0 at 13:27 … unavailable at 16:07)
        if (isNaN(p.v)) { if (pen) d += `H${X(p.t).toFixed(1)}`; pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`; pen = true; lastV = p.v;
      });
      if (room.length && isNaN(room[room.length - 1].v)) lastV = null; // sensor unavailable now: no "current" dot
      if (pen && room.length) d += `H${X(stop).toFixed(1)}`; // the sensor holds its last value
      this._gm = { start, end, now, room, day, presets: data.presets, days: data.days, Y };
      const ys = [G_LO, (G_LO + G_HI) / 2, G_HI];
      const today = !this._gy;
      return frame(`<div class="gy">${ys.map((y) => `<span style="top:${(Y(y) / GH) * 100}%">${y}°</span>`).join('')}</div>`, `
          <div class="gplot">
            <svg viewBox="0 0 ${W} ${GH}" ${this._pw ? '' : 'preserveAspectRatio="none" '}width="100%" height="${GH}">
              ${ys.map((y) => `<line class="gl" x1="0" x2="${W}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/>`).join('')}
              ${bars}
              ${d ? `<path class="rl" d="${d}"/>` : ''}
            </svg>
            ${today ? `<span class="gnow" style="left:${(X(now) / W) * 100}%"></span>` : ''}
            ${lastV != null && today ? `<span class="gdot" style="left:${(X(now) / W) * 100}%;top:${(Y(lastV) / GH) * 100}%"></span>` : ''}
            <span class="gcross"></span><span class="gdot hd"></span><div class="gtip"></div>
            <div class="gx ticks">${Array.from({ length: 25 }, (_, hr) => `<span class="hr${hr % 2 ? '' : ' m2'}${hr % 3 ? '' : ' m3'}${hr % 6 ? '' : ' m6'}" style="left:${(hr / 24) * 100}%">${hr}</span>`).join('')}</div>
          </div>`);
    }
    _gHover(fx) {
      this._hx = fx;
      const m = this._gm, gp = this.shadowRoot.querySelector('.gplot');
      if (!m || !gp) return;
      if (fx == null) { gp.classList.remove('hov'); return; }
      const t = m.start + fx * (m.end - m.start);
      let r = null, why = null; // last reading at or before t (none in the future); why: what made a gap
      if (t <= m.now) for (const p of m.room) { if (p.t > t) break; r = isNaN(p.v) ? null : p.v; why = isNaN(p.v) ? p : null; }
      const sg = m.presets[+m.days[m.day][Math.min(SLOTS - 1, Math.floor(fx * SLOTS))]];
      const dt = new Date(t), pct = `${fx * 100}%`;
      gp.querySelector('.gcross').style.left = pct;
      const dot = gp.querySelector('.gdot.hd');
      dot.style.left = pct; dot.style.display = r == null ? 'none' : ''; if (r != null) dot.style.top = `${(m.Y(r) / GH) * 100}%`;
      const tip = gp.querySelector('.gtip');
      tip.innerHTML = `<div class="tt">${DAYS[(dt.getDay() + 6) % 7]} ${fmt(dt.getHours() * 60 + dt.getMinutes())}</div>
        <div><i class="kr"></i><b>${r != null ? r.toFixed(1) + '°' : t > m.now ? '—' : 'no data'}</b> Room${why ? ` (${esc(why.raw || '?')} since ${fmt(new Date(why.t).getHours() * 60 + new Date(why.t).getMinutes())}${why.live ? ', live' : ''})` : ''}</div>
        <div><i style="background:${sg.color}"></i><b>${(+sg.temp).toFixed(1)}°</b> ${esc(sg.name)}${t > m.now ? ' (planned)' : ''}</div>`;
      tip.style.left = pct; tip.classList.toggle('flip', fx > 0.6);
      gp.classList.add('hov');
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
    _bindGrid(g) { // once, on the grid section; only paints in edit mode (view mode: taps/swipes scroll on mobile)
      g.addEventListener('pointerdown', (e) => { if (!this._editing || !e.target.classList.contains('cell')) return; e.preventDefault(); g.setPointerCapture(e.pointerId); this._painting = true; this._paintAt(e.clientX, e.clientY); });
      g.addEventListener('pointermove', (e) => { if (this._painting) this._paintAt(e.clientX, e.clientY); });
      const up = () => {
        if (!this._painting) return;
        this._painting = false; this._anchor = null; this._snap = null;
        this.shadowRoot.querySelector('.tip').style.display = 'none';
        this._sh = {}; // cells were recoloured directly while painting
        this._render();
      };
      g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    }

    /* ---------- render ---------- */
    _render() {
      if (!this.shadowRoot || !this._cfg) return;
      if (this._vis === false && this._card) { this._dirty = true; return; } // off-screen: catch up when scrolled into view
      this._dirty = false;
      const data = this._data(), ent = this._entity(), ed = !!this._editing, pc = this._presetsChanged() || this._settingsChanged(), dirty = !!this._draft || pc;
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

      /* every hour is rendered; the w300/w380/w600 width classes hide some when the card is narrow */
      const ticks = Array.from({ length: 25 }, (_, h) => `<span class="hr${h % 2 ? '' : ' m2'}${h % 3 ? '' : ' m3'}${h % 6 ? '' : ' m6'}" style="left:${(h / 24) * 100}%">${h}</span>`).join('');

      const cfgC = {}; (this._cfg.climates || []).forEach((x) => { if (typeof x !== 'string') cfgC[x.entity] = x; });
      /* what the valves should be set to now: the boost, else the saved schedule's current block.
         Right after a block change the valve reports its new setpoint with a delay: no warning then. */
      const sv = this._saved(), bo = ent?.attributes.boost, ps = ent?.attributes.presence_state;
      let want = null, grace = false;
      if (sv) { // right after a block change the valves report their new setpoint with a delay: no warning then
        const c = Math.floor(np.min / SLOT_MIN), tAt = (d, k) => +sv.presets[+sv.days[d][k]].temp;
        grace = (c ? tAt(np.day, c - 1) : tAt((np.day + 6) % 7, SLOTS - 1)) !== tAt(np.day, c) && np.min % SLOT_MIN < 10;
      }
      if (bo) { want = +bo.temp; grace = false; }
      else if (ps?.active) want = +ps.temp;
      else if (sv) {
        const c = Math.floor(np.min / SLOT_MIN), tAt = (d, k) => +sv.presets[+sv.days[d][k]].temp;
        want = tAt(np.day, c);
        const prev = c ? tAt(np.day, c - 1) : tAt((np.day + 6) % 7, SLOTS - 1);
        grace = prev !== want && np.min % SLOT_MIN < 10;
      }
      const valves = this._climates().map((id) => {
        const st = this._hass?.states[id], s = status[id];
        const plat = cfgC[id]?.z2m ? 'mqtt' : cfgC[id]?.ieee ? 'zha' : this._hass?.entities?.[id]?.platform;
        const via = plat === 'zha' ? 'ZHA' : plat === 'mqtt' ? 'Z2M' : '';
        const name = st?.attributes.friendly_name || id;
        const temp = st?.attributes.current_temperature;
        const cls = mode === 'ha' ? 'ha' : !st || st.state === 'unavailable' ? 'err' : s ? s.state : 'unknown';
        const last = s ? `${s.state} · ${s.at?.replace('T', ' ') || ''} ${s.msg || ''}`.trim() + (s.next ? ` · next try ${s.next.slice(11, 16)}` : '') : 'not programmed yet';
        const retry = mode === 'native' && ent && s?.state === 'error' && st && st.state !== 'unavailable';
        const title = !st ? 'Entity not found in Home Assistant'
          : st.state === 'unavailable' ? `Valve unavailable in Home Assistant (no contact). Last programming: ${last}`
          : mode === 'ha' ? 'HA-driven' : last + (retry ? '. Click the red dot to try again now.' : '');
        const sp = st && st.state !== 'unavailable' ? parseFloat(st.attributes.temperature) : NaN;
        const lim = this._limits(id), fit = (v) => Math.min(lim.hi, Math.max(lim.lo, v));
        const exp = want == null ? null : fit(want), limited = exp != null && exp !== want; // the valve can't go there
        const off = !isNaN(sp) && exp != null && !grace && Math.abs(sp - exp) > 0.05;
        // a setpoint that matches the schedule of 1–3 h ago means the valve clock is behind
        let lag = 0;
        if (off && sv && !bo) for (const hh of [1, 2, 3]) {
          const d = new Date(Date.now() - hh * 3600e3), k = Math.floor((d.getHours() * 60 + d.getMinutes()) / SLOT_MIN);
          if (Math.abs(fit(+sv.presets[+sv.days[(d.getDay() + 6) % 7][k]].temp) - sp) < 0.05) { lag = hh; break; }
        }
        const set = isNaN(sp) ? '' : `<span class="set${off ? ' off' : ''}" title="${esc(off
          ? `Valve is set to ${sp.toFixed(1)}°, ${bo ? 'the boost' : ps?.active ? 'home mode' : 'the schedule'} says ${exp.toFixed(1)}°${limited ? ` (${want.toFixed(1)}°, limited by this valve's ${exp < want ? 'max' : 'min'} setting)` : ''}. ${lag
            ? `That's the schedule of ${lag} h ago: the valve clock is probably ${lag} h behind – press Re-sync to set it.`
            : `Changed by hand on the valve, or the ${bo ? 'boost' : ps?.active ? 'home mode' : 'schedule'} wasn't applied.`}`
          : limited ? `Valve is set to ${sp.toFixed(1)}°. ${bo ? 'The boost' : 'The schedule'} says ${want.toFixed(1)}°, but this valve is limited to ${exp < want ? 'max' : 'min'} ${exp.toFixed(1)}°.`
          : `Valve is set to ${sp.toFixed(1)}°`)}">set ${sp.toFixed(1)}°${limited && !off ? ` (${exp < want ? 'max' : 'min'})` : ''}${off ? ' ⚠' : ''}</span>`;
        const bat = this._battery(id);
        const batt = bat == null ? '' : `<span class="bat ${bat < (+this._cfg.battery_low || BATTERY_LOW) ? 'low' : 'ok'}" title="Battery ${Math.round(bat)} %"><i><b style="width:${Math.max(4, Math.min(100, bat))}%"></b></i>${Math.round(bat)}%</span>`;
        return `<div class="valve" title="${esc(title)}"><span class="sd ${cls}${retry ? ' retry' : ''}"${retry ? ` data-retry="${esc(id)}" role="button" tabindex="0"` : ''}></span>${esc(name)}${temp != null ? `<b>${(+temp).toFixed(1)}°</b>` : ''}${set}${batt}${via ? `<span class="via">${via}</span>` : ''}</div>`;
      }).join('');

      const savedTxt = !ent ? 'Not saved yet' : dirty ? 'Unsaved changes' : `Saved ${ent.attributes.updated ? ent.attributes.updated.slice(5, 16).replace('T', ' ') : ''}`;

      const icon = this._cfg.icon || 'mdi:thermometer';
      const rs = this._cfg.temperature_sensor && this._hass?.states[this._cfg.temperature_sensor];
      const room = rs && !isNaN(parseFloat(rs.state)) ? `${parseFloat(rs.state).toFixed(1)}°` : rs ? '—' : null;
      const boost = ent?.attributes.boost;
      const pst = ent?.attributes.presence_state, homeToday = !!ent?.attributes.home_today;
      const pPre = pst?.active && data.presets.find((p) => p.name === pst.preset);
      const nowHtml = boost
        ? `<b style="color:#ff453a">${(+boost.temp).toFixed(1)}°</b><div class="s">Boost until ${boost.kind === 'next' ? 'next change, ' : ''}${untilTxt(boost.until)}</div>`
        : pst?.active
        ? `<b style="color:${pPre?.color || 'var(--txt)'}">${(+pst.temp).toFixed(1)}°</b><div class="s">${esc(pst.preset || '')} · home</div>`
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
          ${ent ? `<button class="btn${homeToday ? ' on' : ''}" data-a="home" title="${homeToday ? 'Home today is on until midnight – click to switch off' : 'Treat the room as occupied until midnight'}">🏠 Home today</button>` : ''}
          ${ent ? (boost ? '<button class="btn hot" data-a="unboost">Cancel boost</button>' : '<button class="btn" data-a="boost">🔥 Boost</button>') : ''}
          <span class="sp"></span>
          ${ent && mode === 'native' && !pc ? '<button class="btn" data-a="resync">Re-sync</button>' : ''}
          ${pc || !ent ? saveBtn : ''}`;
      const secs = {
        head: `
        <div class="head">
          <div class="ic">${icon.includes(':') ? `<ha-icon icon="${esc(icon)}"></ha-icon>` : esc(icon)}</div>
          <div class="ttl"><div class="t">${esc(this._cfg.title)}</div>
            <div class="s"><span class="badge ${mode}">${mode === 'ha' ? 'HA-driven' : 'On-valve schedule'}</span>${this._presenceBadge(pst)} ${savedTxt}</div></div>
          <div class="nowt">
            ${room ? `<div class="room" title="${esc(rs.attributes.friendly_name || this._cfg.temperature_sensor)}"><b>${room}</b><div class="s">Room</div></div>` : ''}
            <div>${nowHtml}</div>
          </div>
        </div>`,
        pre: `<div class="presets">${chips}</div>
        ${ed ? '<div class="hint">Pick a preset, then drag over the grid to paint.</div>' : ''}`,
        grid: `<div class="ruler"><span></span><div class="ticks">${ticks}</div><span></span></div>
        <div class="grid${ed ? ' editing' : ''}">${rows}</div>`,
        tools: `<div class="tools">${tools}
        </div>${boostPanel}
        ${pc && !ed ? '<div class="note">Presets or settings were changed in the card editor. Press <b>Save &amp; program</b> to apply them.</div>' : ''}
        ${invalid ? `<div class="warn">⚠ ${esc(invalid)}</div>` : ''}
        ${this._msg ? `<div class="msg ${this._msg.err ? 'err' : ''}">${esc(this._msg.text)}</div>` : ''}`,
        graph: this._graphHtml(data),
        valves: `<div class="valves">${valves || '<span class="s">No climates configured</span>'}</div>`,
      };
      this._rs = { cur, data, homeToday }; // for the click handler

      /* <ha-card> is created once: a new ha-card has no height until it has rendered its own
         shadow DOM, and a layout read in that moment makes the browser clamp the page's
         scroll position (the dashboard jumps to the top). Only its contents are replaced. */
      if (!this._card) {
        this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card>${SECTIONS.map((k) => `<div class="sec" data-s="${k}"></div>`).join('')}<div class="tip"></div></ha-card>`;
        this._card = this.shadowRoot.querySelector('ha-card');
        this._secEl = Object.fromEntries(SECTIONS.map((k) => [k, this._card.querySelector(`[data-s="${k}"]`)]));
        this._sh = {};
        this._card.addEventListener('click', (e) => this._onClick(e)); // one handler for all buttons
        this._bindGrid(this._secEl.grid);
        const gs = this._secEl.graph;
        gs.addEventListener('pointermove', (e) => {
          const gp = gs.querySelector('.gplot'), r = gp?.getBoundingClientRect();
          if (!r || !r.width || e.clientY < r.top || e.clientY > r.bottom) { this._gHover(null); return; }
          this._gHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
        });
        gs.addEventListener('pointerleave', () => this._gHover(null));
        /* width classes instead of CSS container queries: in WebKit (Safari), replacing the
           content of a container-query element makes a scrolled dashboard jump to the top */
        this._ro = typeof ResizeObserver === 'function' && new ResizeObserver(([e]) => {
          const w = e.contentRect.width, cl = this._card.classList;
          cl.toggle('w300', w >= 300); cl.toggle('w380', w >= 380); cl.toggle('w600', w >= 600);
          const pw = Math.round(w - 2 * 34 - 2 * 6); // graph plot = row minus label/counter columns and gaps
          if (pw > 0 && pw !== this._pw) { this._pw = pw; if (this._graphOn() && !this._hold()) this._render(); }
        });
        if (this._ro && this.isConnected) this._ro.observe(this._card);
      }
      // only the sections whose HTML changed are replaced (a valve temperature only touches the chips)
      const ae = this.shadowRoot.activeElement, refocus = ae && ae.dataset && ae.dataset.a;
      for (const k of SECTIONS) {
        if (secs[k] === this._sh[k]) continue;
        this._sh[k] = secs[k];
        this._secEl[k].innerHTML = secs[k];
        if (k === 'graph' && this._hx != null) this._gHover(this._hx); // keep the crosshair through live updates
      }
      if (refocus && !this.shadowRoot.activeElement) this.shadowRoot.querySelector(`[data-a="${refocus}"]`)?.focus({ preventScroll: true });
    }
    _onClick(e) {
      const el = e.target.closest('[data-a],[data-b],[data-m],[data-retry],[data-gy],.chip.pick');
      if (!el) return;
      const { cur, data, homeToday } = this._rs, ds = el.dataset;
      if (ds.retry) return this._retryValve(ds.retry);
      if (ds.gy) { this._gy = ds.gy === '1'; return this._render(); }
      if (ds.b) { this._bt = Math.max(5, Math.min(30, this._bt + 0.5 * +ds.b)); return this._render(); }
      if (ds.m != null && !ds.a) { this._bm = +ds.m; return this._render(); }
      if (el.classList.contains('chip')) { this._sel = +ds.i; return this._render(); }
      const a = ds.a;
      if (a === 'wd') this._copy(0, [1, 2, 3, 4]);
      else if (a === 'we') this._copy(5, [6]);
      else if (a === 'boost') this._openBoost(cur, data.presets);
      else if (a === 'bclose') { this._bo = false; this._render(); }
      else if (a === 'bstart') this._boostStart();
      else if (a === 'unboost') this._boostCancel();
      else if (a === 'home') this._homeToday(!homeToday);
      else if (a === 'edit') { this._bo = false; this._editing = true; this._sel = Math.min(this._sel, data.presets.length - 1); this._render(); }
      else if (a === 'cancel') { this._draft = null; this._editing = false; this._render(); }
      else if (a === 'resync') this._resync();
      else if (a === 'save') this._save();
    }
  }

  const SECTIONS = ['head', 'pre', 'grid', 'tools', 'graph', 'valves'];
  const CSS = `
  :host{--bg2:var(--secondary-background-color,#2a2a2e);--txt:var(--primary-text-color,#f2f2f4);--mut:var(--secondary-text-color,#8e8e96);--acc:var(--primary-color,#0a84ff);--ln:var(--divider-color,#38383d)}
  ha-card{display:block;padding:16px;position:relative;color:var(--txt);overflow:hidden;background:var(--ha-card-background,var(--card-background-color,#1f1f22));border-radius:var(--ha-card-border-radius,12px)}
  .sec{display:contents}
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
  .btn.on{border-color:#34c759;color:#34c759;font-weight:600}
  .badge.home{background:rgba(52,199,89,.18);color:#34c759}.badge.home.soon{background:transparent;border:1px dashed #34c759}
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
  .w300 .ticks .m3{display:block}
  .w380 .ticks .m3{display:none}.w380 .ticks .m2{display:block}
  .w600 .ticks .hr{display:block}
  .grid{user-select:none}.grid.editing{touch-action:none}
  .row{margin:2px 0}.grid.editing .row{margin:3px 0}
  .dl{font-weight:600;color:var(--mut);font-size:12px}.dl.today{color:var(--acc)}
  .cells{position:relative;display:grid;grid-template-columns:repeat(48,1fr);border-radius:7px;overflow:hidden;outline:2px solid transparent;outline-offset:1px}
  .row.over .cells{outline-color:#ff453a}
  .cell{height:20px}.grid.editing .cell{height:30px;cursor:cell}
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
  .graph{margin-top:14px;padding-top:12px;border-top:1px solid var(--ln)}
  .ghead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--mut)}
  .gt{color:var(--txt);font-weight:600;font-size:13px;margin-right:6px}
  .gh{border:1px solid var(--ln);background:transparent;color:var(--mut);padding:2px 8px;border-radius:7px;cursor:pointer;font:inherit;font-size:11px}
  .gh.on{color:var(--txt);border-color:var(--txt)}
  .lg{display:flex;align-items:center;gap:6px;margin-left:8px}
  .kr,.gtip i{display:inline-block;width:14px;height:2px;border-radius:1px;background:var(--txt)}
  .kt{display:inline-flex;width:15px;height:3px;border-radius:1px;overflow:hidden}.kt b{flex:1}
  .gempty{height:${GH + 18}px;display:grid;place-items:center;color:var(--mut);font-size:12px}
  .gwrap{display:grid;grid-template-columns:34px 1fr 34px;column-gap:6px}
  .gy{position:relative;height:${GH}px;font-size:10px;color:var(--mut)}.gy span{position:absolute;right:0;transform:translateY(-50%)}
  .gplot{position:relative;height:${GH}px;margin-bottom:18px;touch-action:pan-y}
  .gplot svg{width:100%;height:${GH}px;display:block;overflow:visible}
  .gl{stroke:var(--ln);stroke-width:1}
  .eq{opacity:.45}.eq.fut{opacity:.18}
  .gnow{position:absolute;top:0;bottom:0;width:2px;background:var(--txt);opacity:.5;transform:translateX(-1px);pointer-events:none}
  .rl{fill:none;stroke:var(--txt);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .gdot{position:absolute;width:8px;height:8px;border-radius:50%;background:var(--txt);transform:translate(-50%,-50%);box-shadow:0 0 0 2px var(--card-background-color,#fff);pointer-events:none}
  .gdot.hd,.gcross,.gtip{display:none}
  .gplot.hov .gdot.hd,.gplot.hov .gcross{display:block}.gplot.hov .gtip{display:block}
  .gcross{position:absolute;top:0;bottom:0;width:1px;background:var(--mut);opacity:.6;pointer-events:none}
  .gtip{position:absolute;top:4px;transform:translateX(12px);z-index:2;background:var(--card-background-color,#fff);border:1px solid var(--ln);border-radius:8px;padding:6px 9px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap;color:var(--mut);pointer-events:none}
  .gtip.flip{transform:translateX(calc(-100% - 12px))}
  .gtip .tt{font-size:11px;margin-bottom:3px}.gtip b{color:var(--txt);margin:0 3px 0 6px}.gtip i{vertical-align:middle}
  .gx{position:absolute;left:0;right:0;top:${GH + 4}px;height:14px;font-size:10px;color:var(--mut)}
  .valves{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--ln)}
  .valve{display:flex;align-items:center;gap:6px;font-size:12px;background:var(--bg2);padding:5px 10px;border-radius:9px}
  .valve b{font-weight:600}
  .bat{display:inline-flex;align-items:center;gap:4px;color:var(--mut);font-size:11px;padding-left:6px;border-left:1px solid var(--ln)}
  .bat i{position:relative;width:16px;height:8px;border:1px solid currentColor;border-radius:2px;padding:1px;box-sizing:border-box}
  .bat i::after{content:'';position:absolute;right:-3px;top:2px;width:2px;height:2px;background:currentColor;border-radius:0 1px 1px 0}
  .bat b{display:block;height:100%;background:currentColor;border-radius:1px}
  .bat.low{color:#ff453a;font-weight:600}.bat.ok i{color:#34c759}
  .set{color:var(--mut);padding-left:6px;border-left:1px solid var(--ln)}.set.off{color:#e8890c;font-weight:600}
  .via{font-size:9px;font-weight:700;letter-spacing:.3px;padding:1px 4px;border-radius:4px;background:var(--ln);color:var(--mut)}
  .sd{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  .sd.retry{cursor:pointer;box-shadow:0 0 0 3px color-mix(in srgb,#ff453a 25%,transparent)}
  .sd.ok{background:#34c759}.sd.pending{background:#ff9f0a;animation:p 1s infinite alternate}.sd.error,.sd.err{background:#ff453a}.sd.ha{background:#ff9f0a}
  @keyframes p{to{opacity:.3}}
  .tip{position:absolute;z-index:5;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.85);color:#fff;font-size:12px;pointer-events:none;transform:translate(-50%,-150%);display:none;white-space:nowrap}
  @media (max-width:500px){.nowt b{font-size:20px}.nowt{gap:12px}.room{padding-right:12px}}
  `;

  /* ---------- visual editor ---------- */
  const EDITOR_SCHEMA = [
    { name: 'schedule_id', required: true, selector: { text: {} } },
    { name: 'title', selector: { text: {} } },
    { name: 'icon', selector: { icon: { placeholder: 'mdi:thermometer' } } },
    { name: 'climates', selector: { entity: { multiple: true, filter: { domain: 'climate' } } } },
    { name: 'temperature_sensor', selector: { entity: { filter: { domain: 'sensor', device_class: 'temperature' } } } },
    { name: 'show_graph', selector: { boolean: {} } },
    { name: 'battery_low', selector: { number: { min: 5, max: 50, step: 1, mode: 'box', unit_of_measurement: '%' } } },
    { name: 'mode', selector: { select: { mode: 'dropdown', options: [
      { value: 'native', label: 'Native – program the valves' },
      { value: 'ha', label: 'HA – Home Assistant sets the temperature' },
    ] } } },
    { name: 'oper_mode', selector: { number: { min: 0, max: 255, mode: 'box' } } },
    { name: 'presence_persons', selector: { entity: { multiple: true, filter: { domain: 'person' } } } },
    { name: 'presence_replace', selector: { select: { multiple: true, mode: 'list', options: [] } } },
    { name: 'presence_preset', selector: { select: { mode: 'dropdown', options: [] } } },
    { name: 'presence_delay', selector: { number: { min: 0, max: 120, step: 5, mode: 'box', unit_of_measurement: 'min' } } },
    { name: 'nightly_resync', selector: { boolean: {} } },
    { name: 'z2m_base_topic', selector: { text: {} } },
  ];
  const EDITOR_LABELS = {
    schedule_id: ['Schedule ID', 'Unique per room. Changing it starts a new, empty schedule.'],
    title: ['Title'],
    icon: ['Icon', 'Shown next to the title. Leave empty for mdi:thermometer.'],
    climates: ['Valves', 'All valves on this card get the same schedule.'],
    temperature_sensor: ['Room temperature sensor', 'Optional. Shown in the header next to the target temperature.'],
    battery_low: ['Battery warning below', 'The valve battery on the card turns red below this level (default 15 %).'],
    presence_persons: ['Presence: people', 'Home mode while at least one of them is home (the "Home today" button on the card does the same until midnight).'],
    presence_replace: ['Presence: raise these presets', 'Blocks with these presets are raised while someone is home.'],
    presence_preset: ['Presence: raise to', 'Preset used instead. Never lowers a room.'],
    presence_delay: ['Presence: delay', 'A change of who is home must last this long before the valves follow, both ways (default 30 min). Home today is immediate.'],
    show_graph: ['Show temperature history', 'Today (or yesterday) under the schedule: room temperature and the target per half hour. Needs a room temperature sensor.'],
    mode: ['Mode', 'Native keeps running even when HA or Zigbee is down.'],
    oper_mode: ['Operation mode after upload', 'Advanced. programming_operation_mode written after programming (default 1 = schedule).'],
    nightly_resync: ['Re-program valves every night', 'Off: valves are only re-programmed when you save, press Re-sync, or a valve comes back after a battery change.'],
    z2m_base_topic: ['Zigbee2MQTT base topic', 'Only for Zigbee2MQTT valves. Leave empty for the default "zigbee2mqtt".'],
  };
  /* the presence selects list this room's own preset names */
  const editorSchema = (names) => EDITOR_SCHEMA.map((f) => (f.name === 'presence_replace' || f.name === 'presence_preset'
    ? { ...f, selector: { select: { ...f.selector.select, options: names } } } : f));
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
      for (const { name } of this._form.schema) {
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
      const names = this._presets().map((p) => p.name), pc = presenceCfg(this._cfg, this._presets());
      if (JSON.stringify(names) !== this._schemaNames) { this._schemaNames = JSON.stringify(names); this._form.schema = editorSchema(names); }
      this._form.data = { mode: 'native', show_graph: true, battery_low: BATTERY_LOW, presence_replace: pc.replace, presence_preset: pc.preset || undefined, presence_delay: pc.delay, ...this._cfg, climates: (this._cfg.climates || []).map((x) => (typeof x === 'string' ? x : x.entity)) };
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
