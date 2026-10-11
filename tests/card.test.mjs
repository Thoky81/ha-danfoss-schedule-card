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
    ['schedule_id', 'title', 'icon', 'climates', 'temperature_sensor', 'mode', 'oper_mode', 'nightly_resync', 'z2m_base_topic']);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
