// Regression tests for dist/danfoss-schedule-card.js – run with `npm test`.
// jsdom has no layout, so the scroll-jump fix is covered by checking that <ha-card> survives re-renders.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const SRC = fs.readFileSync(new URL('../dist/danfoss-schedule-card.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
// objects from inside jsdom have other prototypes; compare their JSON
const plain = (o) => JSON.parse(JSON.stringify(o));

function env() {
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window;
  w.setInterval = () => 0;
  w.console.info = () => {};
  w.eval(`customElements.define('ha-form', class extends HTMLElement {})`);
  w.eval(SRC);
  return w;
}

const P = [
  { name: 'Comfort', temp: 22, color: '#ff8a3d' },
  { name: 'Away', temp: 15, color: '#8e8e93' },
  { name: 'Warm', temp: 23, color: '#ff453a' },
];
function saved(extra = {}) {
  return { state: 'ok', attributes: { presets: P, days: Array(7).fill('1'.repeat(16) + '0'.repeat(32)), climates: ['climate.a'], status: { 'climate.a': { state: 'ok' } }, ...extra } };
}
function hassWith(ent, more = {}) {
  const calls = [];
  return {
    calls,
    hass: {
      states: { 'pyscript.climate_schedule_obyvak': ent, 'climate.a': { state: 'heat', attributes: { friendly_name: 'TRV A', current_temperature: 21 } }, ...more },
      entities: { 'climate.a': { platform: 'zha' } },
      callService: async (...a) => calls.push(a),
    },
  };
}
function mount(w, cfg, hass) {
  const c = w.document.createElement('danfoss-schedule-card');
  w.document.body.appendChild(c);
  c.setConfig({ schedule_id: 'obyvak', climates: ['climate.a'], ...cfg });
  c.hass = hass;
  const R = c.shadowRoot;
  return { c, R, q: (x) => R.querySelector(x), btns: () => [...R.querySelectorAll('.tools .btn')].map((b) => b.textContent.trim() + (b.disabled ? '(off)' : '')) };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('view mode: locked grid, no -/+ buttons, taps do not paint', () => {
  const w = env(); const { hass } = hassWith(saved());
  const { c, q, R, btns } = mount(w, {}, hass);
  assert.deepEqual(btns(), ['✎ Edit schedule', '🔥 Boost', 'Re-sync']);
  assert.equal(R.querySelectorAll('.chip .tb').length, 0);
  q('.cell[data-d="0"][data-c="20"]').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  assert.equal(c._draft, null);
});

test('edit mode: buttons, painting enables Save, Cancel drops the draft', () => {
  const w = env(); const { hass } = hassWith(saved());
  const { c, q, R, btns } = mount(w, {}, hass);
  q('[data-a=edit]').click();
  assert.deepEqual(btns(), ['Copy Mon → Tue–Fri', 'Copy Sat → Sun', 'Cancel', 'Save & program(off)']);
  assert.ok(q('.grid').classList.contains('editing'));
  R.querySelectorAll('.chip')[2].click();
  c._edit().days[0] = '2'.repeat(48); c._render();
  assert.equal(btns().at(-1), 'Save & program');
  q('[data-a=cancel]').click();
  assert.equal(c._draft, null);
  assert.equal(btns()[0], '✎ Edit schedule');
});

test('<ha-card> is created once and no-op updates do not touch the DOM', () => {
  const w = env(); const { hass } = hassWith(saved());
  const { c, q } = mount(w, {}, hass);
  const card = q('ha-card'), head = q('.head');
  c.hass = { ...hass, states: { ...hass.states, 'sensor.unrelated': { state: '1' } } };
  assert.equal(q('ha-card'), card);
  assert.equal(q('.head'), head, 'unchanged content must not be rebuilt');
  c.hass = { ...hass, states: { ...hass.states, 'climate.a': { state: 'heat', attributes: { friendly_name: 'TRV A', current_temperature: 22.5 } } } };
  assert.equal(q('ha-card'), card, 'ha-card survives a real update');
  assert.match(q('.valves').textContent, /22\.5°/);
});

test('presets changed in the editor show a note and are saved', async () => {
  const w = env(); const { hass, calls } = hassWith(saved());
  const { q, btns } = mount(w, { presets: [{ ...P[0], temp: 21 }, P[1], P[2]] }, hass);
  assert.ok(q('.note'));
  assert.ok(btns().includes('Save & program'));
  q('[data-a=save]').click(); await tick();
  assert.equal(calls[0][2].presets[0].temp, 21);
});

test('nightly_resync toggle counts as a change and is sent', async () => {
  const w = env(); const { hass, calls } = hassWith(saved({ nightly_resync: false }));
  const { q } = mount(w, { nightly_resync: true }, hass);
  assert.ok(q('.note'));
  q('[data-a=save]').click(); await tick();
  assert.equal(calls[0][2].nightly_resync, true);
});

test('boost: panel defaults, service call, header and cancel', async () => {
  const w = env(); const { hass, calls } = hassWith(saved());
  const { c, q, btns } = mount(w, {}, hass);
  q('[data-a=boost]').click();
  assert.equal(q('.bt').textContent, '24.0°'); // warmest preset 23 vs current + 2 = 24
  assert.equal(q('.dur.on').textContent, '1 h');
  q('[data-b="1"]').click(); q('[data-m="120"]').click(); q('[data-a=bstart]').click(); await tick();
  assert.deepEqual(calls[0].slice(0, 2), ['pyscript', 'climate_schedule_boost']);
  assert.deepEqual(plain(calls[0][2]), { schedule_id: 'obyvak', temperature: 24.5, minutes: 120 });
  c.hass = hassWith(saved({ boost: { temp: 24.5, until: '2030-01-01T16:30:00', kind: 'timed' } })).hass;
  assert.match(q('.nowt').textContent, /24\.5°/);
  assert.ok(btns().includes('Cancel boost'));
  c._hass.callService = hass.callService;
  q('[data-a=unboost]').click(); await tick();
  assert.equal(calls[1][1], 'climate_schedule_boost_cancel');
});

test('room temperature sensor and unavailable tooltip', () => {
  const w = env();
  const { hass } = hassWith(saved(), { 'sensor.t': { state: '21.43', attributes: {} }, 'climate.a': { state: 'unavailable', attributes: {} } });
  const { q } = mount(w, { temperature_sensor: 'sensor.t' }, hass);
  assert.equal(q('.room b').textContent, '21.4°');
  assert.match(q('.valve').title, /unavailable in Home Assistant/);
});

test('icon option: default, mdi and emoji', () => {
  const w = env(); const { hass } = hassWith(saved());
  assert.equal(mount(w, {}, hass).q('.ic ha-icon').getAttribute('icon'), 'mdi:thermometer');
  assert.equal(mount(w, { icon: 'mdi:sofa' }, hass).q('.ic ha-icon').getAttribute('icon'), 'mdi:sofa');
  assert.equal(mount(w, { icon: '🔥' }, hass).q('.ic').textContent, '🔥');
});

test('new card uses the default presets and a valid default week', () => {
  const w = env();
  const { c, R } = mount(w, { schedule_id: 'fresh' }, { states: {}, entities: {} });
  assert.deepEqual([...R.querySelectorAll('.chip .nm')].map((n) => n.textContent), ['Eco', 'Night', 'Away', 'Comfort', 'Warm']);
  assert.equal(c._invalid(c._data()), null);
});

test('editor: shows saved presets, undo, only last unused preset removable', () => {
  const w = env(); const { hass } = hassWith(saved());
  const ed = w.document.createElement('danfoss-schedule-card-editor'); w.document.body.appendChild(ed);
  const evs = []; ed.addEventListener('config-changed', (e) => { evs.push(e.detail.config); ed.setConfig(e.detail.config); });
  ed.hass = hass; ed.setConfig({ schedule_id: 'obyvak', climates: ['climate.a'] });
  const E = ed.shadowRoot;
  assert.deepEqual([...E.querySelectorAll('input[data-k=name]')].map((i) => i.value), ['Comfort', 'Away', 'Warm']);
  assert.equal(E.querySelectorAll('.del').length, 1);
  assert.equal(E.querySelector('.del').disabled, false);
  const t = E.querySelector('.pr[data-i="0"] input[data-k=temp]'); t.value = '21.5'; t.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(E.querySelector('.pr[data-i="0"] input[data-k=temp]'), t, 'typing keeps the same input (focus)');
  E.querySelector('.undo').click();
  assert.equal('presets' in evs.at(-1), false);
  ed.hass = hassWith(saved({ days: Array(7).fill('2'.repeat(48)) })).hass;
  assert.equal(E.querySelector('.del').disabled, true, 'last preset in use');
  assert.deepEqual(plain(E.querySelector('ha-form').schema.map((x) => x.name)),
    ['schedule_id', 'title', 'icon', 'climates', 'temperature_sensor', 'show_graph', 'battery_low', 'mode', 'oper_mode', 'nightly_resync', 'z2m_base_topic']);
});

test('history graph: one day aligned with the rows, 48 preset-coloured bars, yesterday/today, hover', async () => {
  const w = env(); const { hass } = hassWith(saved(), { 'sensor.t': { state: '21.4', attributes: {}, last_updated: new Date().toISOString() } });
  const now = Date.now() / 1000, asked = [];
  hass.callWS = async (msg) => { asked.push(msg); return { 'sensor.t': [0, 1, 2, 3, 4, 5].map((i) => ({ s: String(19 + i / 2), lu: now - (40 - i * 7) * 3600 })) }; };
  const { c, q, R } = mount(w, { temperature_sensor: 'sensor.t' }, hass);
  await tick(); await tick();
  assert.equal(asked[0].type, 'history/history_during_period');
  const y0 = new Date(); y0.setHours(0, 0, 0, 0); y0.setDate(y0.getDate() - 1);
  assert.equal(Date.parse(asked[0].start_time), y0.getTime(), 'history starts yesterday 00:00');
  const bars = [...R.querySelectorAll('rect.eq')];
  assert.equal(bars.length, 48, 'one bar per half-hour cell');
  const today = (new Date().getDay() + 6) % 7, row = saved().attributes.days[today];
  bars.forEach((b, i) => assert.equal(b.style.fill, P[+row[i]].color, `bar ${i} has the colour of cell ${i}`));
  assert.equal(q('.gwrap').children.length, 3, 'same three columns as a schedule row');
  assert.ok(q('.gnow'), 'now line on today');
  assert.equal(q('.gh.on').textContent, 'Today');
  q('[data-gy="1"]').click();
  assert.equal(q('.gh.on').textContent, 'Yesterday');
  assert.equal(q('.gnow'), null, 'no now line on yesterday');
  assert.equal(R.querySelectorAll('rect.eq.fut').length, 0, 'yesterday has no planned part');
  c._gHover(0.5);
  assert.ok(q('.gplot').classList.contains('hov'));
  assert.match(q('.gtip').textContent, /Room/);
  c._gHover(null);
  assert.equal(asked.length, 1, 'history fetched once for both days');
});

test('graph off without sensor or with show_graph: false; compact rows class untouched in view', () => {
  const w = env(); const { hass } = hassWith(saved(), { 'sensor.t': { state: '21', attributes: {} } });
  assert.equal(mount(w, {}, hass).q('.graph'), null);
  assert.equal(mount(w, { temperature_sensor: 'sensor.t', show_graph: false }, hass).q('.graph'), null);
  assert.match(SRC, /\.cell\{height:20px\}\.grid\.editing \.cell\{height:30px/);
});

test('valve chips show the set temperature and flag a mismatch with the schedule / boost', () => {
  const w = env();
  const flat = saved({ days: Array(7).fill('0'.repeat(48)) }); // Comfort 22° all week: no block change, no grace
  const valve = (sp) => ({ state: 'heat', attributes: { friendly_name: 'TRV', current_temperature: 21, temperature: sp } });
  let { q } = mount(w, {}, hassWith(flat, { 'climate.a': valve(22) }).hass);
  assert.match(q('.set').textContent, /set 22\.0°/);
  assert.ok(!q('.set').classList.contains('off'));
  ({ q } = mount(w, {}, hassWith(flat, { 'climate.a': valve(17) }).hass));
  assert.ok(q('.set').classList.contains('off'));
  assert.match(q('.set').title, /set to 17\.0°, the schedule says 22\.0°/);
  const boosted = saved({ days: Array(7).fill('0'.repeat(48)), boost: { temp: 24.5, until: '2030-01-01T00:00:00', kind: 'timed' } });
  ({ q } = mount(w, {}, hassWith(boosted, { 'climate.a': valve(24.5) }).hass));
  assert.ok(!q('.set').classList.contains('off'), 'boost is the expected value');
  ({ q } = mount(w, {}, hassWith(flat, { 'climate.a': { state: 'unavailable', attributes: { temperature: 22 } } }).hass));
  assert.equal(q('.set'), null, 'no setpoint for an unavailable valve');
});

test('mismatch tooltip spots a valve clock that is hours behind', () => {
  const w = env();
  const now = new Date(), c = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
  const two = new Date(Date.now() - 2 * 3600e3), c2 = Math.floor((two.getHours() * 60 + two.getMinutes()) / 30);
  const day = (now.getDay() + 6) % 7, day2 = (two.getDay() + 6) % 7;
  const days = Array.from({ length: 7 }, () => '1'.repeat(48).split(''));
  for (let k = Math.max(0, c - 3); k <= c; k++) days[day][k] = '0'; // Comfort 22° for the last 1.5–2 h, Away 15° before
  days[day2][c2] = '1';
  if (c < 4) return; // too close to midnight for this layout
  const sched = saved({ days: days.map((d) => d.join('')) });
  const { q } = mount(w, {}, hassWith(sched, { 'climate.a': { state: 'heat', attributes: { friendly_name: 'TRV', current_temperature: 21, temperature: 15 } } }).hass);
  if (now.getMinutes() % 30 >= 10) {          // outside the 10-minute grace after a block change
    assert.ok(q('.set').classList.contains('off'));
    assert.match(q('.set').title, /clock is probably 2 h behind/);
  }
});

test('valve chips: battery from the device, limited valve shows (max) without a warning', () => {
  const w = env();
  const flat = saved({ days: Array(7).fill('0'.repeat(48)) }); // Comfort 22° all week
  const { hass } = hassWith(flat, {
    'climate.a': { state: 'heat', attributes: { friendly_name: 'TRV', current_temperature: 21, temperature: 20, min_temp: 5, max_temp: 20 } },
    'sensor.trv_a_battery': { state: '14', attributes: { device_class: 'battery' } },
  });
  hass.entities = { 'climate.a': { platform: 'zha', device_id: 'dev1' }, 'sensor.trv_a_battery': { device_id: 'dev1' } };
  const { q } = mount(w, {}, hass);
  assert.match(q('.bat').textContent, /14%/);
  assert.ok(q('.bat').classList.contains('low'), 'under 15 % is red');
  assert.ok(!q('.set').classList.contains('off'), 'set 20° on a max-20° valve is not a mismatch');
  assert.match(q('.set').textContent, /set 20\.0° \(max\)/);
  assert.match(q('.set').title, /limited to max 20\.0°/);
});

test('Z2M max_heat_setpoint_limit number tightens the limit', () => {
  const w = env();
  const flat = saved({ days: Array(7).fill('0'.repeat(48)) });
  const { hass } = hassWith(flat, {
    'climate.a': { state: 'heat', attributes: { friendly_name: 'TRV', current_temperature: 21, temperature: 19, min_temp: 5, max_temp: 35 } },
    'number.trv_a_max_heat_setpoint_limit': { state: '19', attributes: {} },
  });
  hass.entities = { 'climate.a': { platform: 'mqtt', device_id: 'dev2' }, 'number.trv_a_max_heat_setpoint_limit': { device_id: 'dev2' } };
  const { q } = mount(w, {}, hass);
  assert.ok(!q('.set').classList.contains('off'));
  assert.match(q('.set').textContent, /\(max\)/);
});

test('boost mismatch tooltip talks about the boost; a Z2M limit below the boost is not a mismatch', () => {
  const w = env();
  const boosted = saved({ days: Array(7).fill('0'.repeat(48)), boost: { temp: 27, until: '2030-01-01T00:00:00', kind: 'timed' } });
  const v = (sp) => ({ state: 'heat', attributes: { friendly_name: 'TRV', current_temperature: 22, temperature: sp, min_temp: 5, max_temp: 35 } });
  let { hass } = hassWith(boosted, { 'climate.a': v(21) });
  let { q } = mount(w, {}, hass);
  assert.match(q('.set').title, /or the boost wasn't applied/);
  ({ hass } = hassWith(boosted, { 'climate.a': v(25), 'number.kupelna_max_heat_setpoint_limit': { state: '25', attributes: {} } }));
  hass.entities = { 'climate.a': { platform: 'mqtt', device_id: 'k' }, 'number.kupelna_max_heat_setpoint_limit': { device_id: 'k' } };
  ({ q } = mount(w, {}, hass));
  assert.ok(!q('.set').classList.contains('off'));
  assert.match(q('.set').textContent, /set 25\.0° \(max\)/);
  assert.match(q('.set').title, /The boost says 27\.0°, but this valve is limited to max 25\.0°/);
});

test('battery turns red only below 15 %', () => {
  const w = env();
  const chip = (pct) => {
    const { hass } = hassWith(saved(), { 'sensor.b': { state: String(pct), attributes: { device_class: 'battery' } } });
    hass.entities = { 'climate.a': { platform: 'zha', device_id: 'd' }, 'sensor.b': { device_id: 'd' } };
    return mount(w, {}, hass).q('.bat');
  };
  assert.ok(!chip(15).classList.contains('low'));
  assert.ok(chip(15).classList.contains('ok'), 'green from the threshold up');
  assert.ok(!chip(18).classList.contains('low'));
  assert.ok(chip(14).classList.contains('low'));
});

test('battery_low option moves the threshold', () => {
  const w = env();
  const { hass } = hassWith(saved(), { 'sensor.b': { state: '22', attributes: { device_class: 'battery' } } });
  hass.entities = { 'climate.a': { platform: 'zha', device_id: 'd' }, 'sensor.b': { device_id: 'd' } };
  assert.ok(!mount(w, {}, hass).q('.bat').classList.contains('low'));
  assert.ok(mount(w, { battery_low: 25 }, hass).q('.bat').classList.contains('low'));
});

test('failed valve: next try in tooltip, click the red dot to retry just that valve', async () => {
  const w = env();
  const { hass, calls } = hassWith(saved({ status: { 'climate.a': { state: 'error', at: '2026-10-13T08:00:00', msg: 'TimeoutError', next: '2026-10-13T08:15:00' } } }));
  const { q } = mount(w, {}, hass);
  assert.match(q('.valve').title, /TimeoutError · next try 08:15\. Click the red dot/);
  q('.sd.retry').click(); await tick();
  assert.deepEqual(plain(calls[0]), ['pyscript', 'climate_schedule_push', { schedule_id: 'obyvak', valve: 'climate.a' }]);
});

test('graph: glitch readings are dropped, unavailable leaves a "no data" gap', async () => {
  const w = env(); const { hass } = hassWith(saved(), { 'sensor.t': { state: '21', attributes: {} } });
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const at = (h) => d0.getTime() / 1000 + h * 3600;
  hass.callWS = async () => ({ 'sensor.t': [
    { s: '20.0', lu: at(0.5) }, { s: '655.35', lu: at(1) }, { s: '20.2', lu: at(1.5) },
    { s: 'unavailable', lu: at(2) }, { s: '20.4', lu: at(3) } ] });
  const { c, q } = mount(w, { temperature_sensor: 'sensor.t' }, hass);
  await tick(); await tick();
  if (new Date().getHours() < 4) return; // needs the test points to be in the past
  const d = q('.rl').getAttribute('d');
  assert.equal((d.match(/M/g) || []).length, 2, 'one gap (unavailable), no break for the glitch');
  assert.ok(!c._gm.room.some((p) => p.v > 60), 'glitch value dropped');
  c._gHover(2.5 / 24);
  assert.match(q('.gtip').textContent, /no data/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
