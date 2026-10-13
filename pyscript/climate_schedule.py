"""
Climate week schedule backend for `custom:danfoss-schedule-card`
Danfoss Ally (eTRV0100 / 014G2461) via ZHA and/or Zigbee2MQTT.

- Master copy of every schedule lives in /config/climate_schedules.json
  and is mirrored to `pyscript.climate_schedule_<id>` for the card.
- mode "native": schedule is written INTO the valves (ZCL Thermostat
  SetWeeklySchedule) -> valves run on their own, even without HA/Zigbee.
  Each valve is detected as ZHA (zha.issue_zigbee_cluster_command) or
  Zigbee2MQTT (mqtt.publish to <base_topic>/<ieee>/set), so one schedule
  can mix both.
  Re-pushed automatically when a valve comes back from `unavailable`
  (the Ally loses its schedule after a battery change / OTA), and every
  night at 03:15 only if the schedule has nightly_resync enabled.
- mode "ha": HA sets climate.set_temperature at each block change
  (fallback if the on-valve schedule misbehaves).
- clock: ZHA does not set the Danfoss clock, so the valves can run in UTC or
  without daylight saving time and switch blocks hours late. Before every
  programming and once a day the backend writes the valve's Time cluster the
  way Zigbee2MQTT does (UTC time, zone offset, DST start/end/shift).
- presence: while one of the chosen persons is home (or "Home today" is on),
  blocks of the chosen presets (e.g. Away) are raised to another preset
  (e.g. Comfort) - only ever raised, a boost has priority.
- boost: all valves of a schedule get a temporary setpoint for N minutes
  (or until the next block change), then go back to the schedule.

pyscript config (configuration.yaml):
  pyscript:
    allow_all_imports: true
    hass_is_global: true
"""
import json
import os
import re
from datetime import datetime, timedelta

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

STORE = "/config/climate_schedules.json"
ENTITY_PREFIX = "pyscript.climate_schedule_"
ENDPOINT = 1                 # Danfoss Ally thermostat endpoint
THERMOSTAT = 513             # 0x0201
TIME_CLUSTER = 10            # 0x000A, the valve's own clock
# write order: zone and DST rules first, the time itself last
TIME_ATTRS = [("time_zone", 2), ("dst_start", 3), ("dst_end", 4), ("dst_shift", 5), ("time_status", 1), ("time", 0)]
TIME_SYNC = "cron(5 3 * * *)"   # daily clock sync for ZHA valves (Z2M does its own)
CMD_SET_WEEKLY = 1           # SetWeeklySchedule
CMD_CLEAR_WEEKLY = 3         # ClearWeeklySchedule
ATTR_PROG_MODE = 0x0025      # programming_operation_mode, bit0 = schedule
SLOTS = 48                   # 30-minute cells
SLOT_MIN = 30
MAX_BLOCKS = 6               # Danfoss: 6 transitions per day
DAY_BITS = [2, 4, 8, 16, 32, 64, 1]  # Mon..Sun -> ZCL SeqDayOfWeek (Sun = bit0)
RETRIES = 3
STARTUP_GRACE = 600         # s after start in which "valve came back" is a restart, not a battery change
RETRY_LATER = [15, 60, 180]  # min: a valve that failed all attempts is tried again later (sleepy valves on weak links)
RETRY_WAIT = 30              # s between attempts, gives the mesh time to find a route again
DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
Z2M_DEFAULT_BASE = "zigbee2mqtt"
Z2M_OPER_MODES = {0: "setpoint", 1: "schedule", 3: "schedule_with_preheat", 4: "eco"}
Z2M_GAP = 12                 # s per message: longer than Z2M's 10 s command timeout, so a failure is reported before the next one
Z2M_CONFIRM_TRIES = 8        # x 5 s waiting for the valve to report the new programming_operation_mode
NIGHTLY_RESYNC = "cron(15 3 * * *)"

SCHEDULES = {}
STARTED_AT = None
AVAIL_TRIGGERS = {}
LOG_TRIGGERS = {}
PERSON_TRIGGERS = {}
Z2M_ERRORS = {}              # ieee / friendly name -> last failure Z2M reported on <base>/bridge/logging
HA_LAST = {}


# ---------------------------------------------------------------- storage
@pyscript_compile
def _read_store(path):
    import json, os
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@pyscript_compile
def _write_store(path, data):
    import json, os
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


@pyscript_compile
def _zigbee_time(tzname):
    """ZCL Time cluster values for the local zone, like zigbee-herdsman's getTimeClusterAttributes."""
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(tzname)
    epoch = datetime(2000, 1, 1, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)

    def off(dt):
        return dt.astimezone(tz).utcoffset()

    def change(a, b):  # first second in (a, b] with a different offset than a
        oa = off(a)
        while b - a > timedelta(seconds=1):
            m = a + (b - a) / 2
            if off(m) == oa:
                a = m
            else:
                b = m
        return b

    def zsec(dt):
        return int((dt - epoch).total_seconds())

    y = now.year
    jan, jul, dec = (datetime(y, 1, 1, tzinfo=timezone.utc), datetime(y, 7, 1, tzinfo=timezone.utc),
                     datetime(y, 12, 31, 23, 59, tzinfo=timezone.utc))
    std, dst = min(off(jan), off(jul)), max(off(jan), off(jul))
    out = {"time": zsec(now), "time_status": 0x02, "time_zone": int(std.total_seconds()),
           "dst_start": 0xFFFFFFFF, "dst_end": 0xFFFFFFFF, "dst_shift": 0}
    if std != dst:
        if off(jan) == std:  # northern hemisphere: summer time inside the year
            start, end = change(jan, jul), change(jul, dec)
        elif now < change(jan, jul):  # southern, still in the summer that began last year
            start, end = change(datetime(y - 1, 7, 1, tzinfo=timezone.utc), datetime(y - 1, 12, 31, 23, 59, tzinfo=timezone.utc)), change(jan, jul)
        else:
            start, end = change(jul, dec), change(datetime(y + 1, 1, 1, tzinfo=timezone.utc), datetime(y + 1, 7, 1, tzinfo=timezone.utc))
        out.update(dst_start=zsec(start), dst_end=zsec(end) - 1, dst_shift=int((dst - std).total_seconds()))
    return out


def save_store():
    task.executor(_write_store, STORE, SCHEDULES)


# ---------------------------------------------------------------- helpers
def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def ent_id(c):
    return c["entity"] if isinstance(c, dict) else c


def day_blocks(day, presets, lo=None, hi=None):
    """'000022..' (48 chars) -> [(start_minute, temp), ...] merged by temperature.
    lo/hi: the valve's own setpoint limits; blocks that become equal after limiting merge."""
    out = []
    for i in range(SLOTS):
        t = float(presets[int(day[i])]["temp"])
        if hi is not None:
            t = min(t, hi)
        if lo is not None:
            t = max(t, lo)
        if not out or out[-1][1] != t:
            out.append((i * SLOT_MIN, t))
    return out


def validate(presets, days):
    if not isinstance(presets, list) or not presets:
        return "presets must be a non-empty list"
    if not isinstance(days, list) or len(days) != 7:
        return "days must be a list of 7 strings (Mon..Sun)"
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for d in range(7):
        day = days[d]
        if not isinstance(day, str) or len(day) != SLOTS:
            return f"{names[d]}: expected {SLOTS} slots"
        for ch in day:
            if not ch.isdigit() or int(ch) >= len(presets):
                return f"{names[d]}: unknown preset '{ch}'"
        n = len(day_blocks(day, presets))
        if n > MAX_BLOCKS:
            return f"{names[d]} has {n} blocks, Danfoss allows max {MAX_BLOCKS}"
    return None


def resolve_target(c):
    """-> ("zha", ieee) | ("z2m", ieee or friendly name) | (None, reason)"""
    if isinstance(c, dict) and c.get("ieee"):
        return "zha", c["ieee"]
    if isinstance(c, dict) and c.get("z2m"):
        return "z2m", c["z2m"]
    ent = er.async_get(hass).async_get(ent_id(c))
    if ent is None or ent.device_id is None:
        return None, "entity has no device"
    dev = dr.async_get(hass).async_get(ent.device_id)
    if dev is None:
        return None, "device not found"
    for ident in dev.identifiers:
        if ident[0] == "zha":
            return "zha", ident[1]
        if ident[0] == "mqtt" and str(ident[1]).startswith("zigbee2mqtt_0x"):
            return "z2m", ident[1][len("zigbee2mqtt_"):]  # Z2M accepts the IEEE address as topic name
    return None, "not a ZHA or Zigbee2MQTT device"


def day_groups(s, lo=None, hi=None):
    """identical days -> one command: {json(blocks): [day indexes]}"""
    groups = {}
    for d in range(7):
        key = json.dumps(day_blocks(s["days"][d], s["presets"], lo, hi))
        groups.setdefault(key, []).append(d)
    return groups


def publish(sid):
    s = SCHEDULES[sid]
    status = s.get("status", {})
    if s.get("mode") == "ha":
        overall = "ha"
    elif any([v.get("state") == "error" for v in status.values()]):
        overall = "error"
    elif any([v.get("state") == "pending" for v in status.values()]):
        overall = "pending"
    elif status:
        overall = "ok"
    else:
        overall = "unknown"
    # deep copy: SCHEDULES is mutated in place later, and HA diffs new vs old attributes
    # before pushing them to the frontend; a shared dict would make every update look unchanged
    attrs = json.loads(json.dumps({
        "friendly_name": f"Climate schedule {s.get('title', sid)}",
        "icon": "mdi:calendar-clock",
        "title": s.get("title", sid),
        "climates": s["climates"],
        "presets": s["presets"],
        "days": s["days"],
        "mode": s.get("mode", "native"),
        "oper_mode": s.get("oper_mode", 1),
        "z2m_base_topic": s.get("z2m_base_topic", Z2M_DEFAULT_BASE),
        "nightly_resync": bool(s.get("nightly_resync")),
        "status": status,
        "updated": s.get("updated"),
        "boost": s.get("boost"),
        "presence": s.get("presence") or {},
        "presence_state": s.get("presence_state") or {},
        "home_today": s.get("home_today") == datetime.now().date().isoformat(),
    }))
    state.set(ENTITY_PREFIX + sid, overall, new_attributes=attrs)


def set_status(sid, eid, st, msg="", nxt=None):
    entry = {"state": st, "at": now_iso(), "msg": msg}
    if nxt:
        entry["next"] = nxt  # kept out of msg so alerts don't treat every retry as a new problem
    SCHEDULES[sid].setdefault("status", {})[eid] = entry
    publish(sid)


def is_unavailable(eid):
    try:
        return state.get(eid) == "unavailable"
    except NameError:
        return True


# ---------------------------------------------------------------- ZHA
def zha_cmd(ieee, command, params=None):
    # ZHA requires `params` (or `args`) even for commands without fields, e.g. ClearWeeklySchedule
    service.call(
        "zha", "issue_zigbee_cluster_command", blocking=True,
        ieee=ieee, endpoint_id=ENDPOINT, cluster_id=THERMOSTAT, cluster_type="in",
        command=command, command_type="server", params=params or {},
    )


def sync_time_zha(ieee):
    vals = _zigbee_time(str(hass.config.time_zone))
    for name, attr in TIME_ATTRS:
        service.call(
            "zha", "set_zigbee_cluster_attribute", blocking=True,
            ieee=ieee, endpoint_id=ENDPOINT, cluster_id=TIME_CLUSTER,
            cluster_type="in", attribute=attr, value=vals[name],
        )


def program_zha(s, ieee, groups):
    sync_time_zha(ieee)  # a wrong valve clock makes a correct schedule switch at the wrong hour
    zha_cmd(ieee, CMD_CLEAR_WEEKLY)
    task.sleep(1)
    for key, days in groups.items():
        blocks = json.loads(key)
        values = []
        for b in blocks:
            values.append(int(b[0]))                 # minutes after midnight
            values.append(int(round(b[1] * 100)))    # setpoint, 0.01 °C
        bits = 0
        for d in days:
            bits |= DAY_BITS[d]
        zha_cmd(ieee, CMD_SET_WEEKLY, {
            "num_transitions_for_sequence": len(blocks),
            "day_of_week_for_sequence": bits,
            "mode_for_sequence": 1,                  # heat
            "values": values,
        })
        task.sleep(1)
    service.call(
        "zha", "set_zigbee_cluster_attribute", blocking=True,
        ieee=ieee, endpoint_id=ENDPOINT, cluster_id=THERMOSTAT,
        cluster_type="in", attribute=ATTR_PROG_MODE,
        value=int(s.get("oper_mode", 1)),
    )


# ---------------------------------------------------------------- Zigbee2MQTT
def z2m_set(s, device, payload):
    base = s.get("z2m_base_topic") or Z2M_DEFAULT_BASE
    service.call("mqtt", "publish", blocking=True, topic=f"{base}/{device}/set", payload=json.dumps(payload))


def z2m_oper_mode(value):
    return Z2M_OPER_MODES.get(int(value), "schedule")


def z2m_get(s, device, key):
    base = s.get("z2m_base_topic") or Z2M_DEFAULT_BASE
    service.call("mqtt", "publish", blocking=True, topic=f"{base}/{device}/get", payload=json.dumps({key: ""}))


def mode_entity(eid):
    """The select/sensor Z2M creates for programming_operation_mode on the same device."""
    reg = er.async_get(hass)
    ent = reg.async_get(eid)
    if ent is None or ent.device_id is None:
        return None
    for e in er.async_entries_for_device(reg, ent.device_id):
        if "programming_operation_mode" in e.entity_id or str(e.unique_id).endswith("_programming_operation_mode_zigbee2mqtt"):
            return e.entity_id
    return None


def z2m_confirm(s, device, eid, want):
    """True = valve reports `want`, None = nothing to check against. Raises if the valve stays in another mode."""
    me = mode_entity(eid)
    if me is None:
        return None
    got = None
    for i in range(Z2M_CONFIRM_TRIES):
        task.sleep(5)
        if i == 2:
            z2m_get(s, device, "programming_operation_mode")  # ask the valve in case Z2M did not publish it
        try:
            got = state.get(me)
        except NameError:
            return None
        if got == want:
            return True
    raise RuntimeError(f"valve stayed in '{got}' mode (expected '{want}'), see the Zigbee2MQTT log")


def make_log_trigger(base):
    """Z2M reports failed commands only in its log, which it also publishes on <base>/bridge/logging."""
    @mqtt_trigger(f"{base}/bridge/logging")
    def _z2m_log(payload_obj=None, **kwargs):
        if not isinstance(payload_obj, dict) or payload_obj.get("level") != "error":
            return
        msg = str(payload_obj.get("message", ""))
        if "failed" not in msg:
            return
        m = re.search(r"(0x[0-9a-fA-F]{16})", msg)
        if m:
            Z2M_ERRORS[m.group(1).lower()] = msg
        m = re.search(r"to '([^']+)' failed", msg)
        if m:
            Z2M_ERRORS[m.group(1).lower()] = msg
    return _z2m_log


def z2m_error_cause(msg):
    m = re.search(r"failed \((.+)\)'?\s*$", msg)
    return (m.group(1) if m else msg)[-160:]


def z2m_step(s, device, payload):
    """Send one set message and wait out Z2M's command timeout; raise if Z2M logged a failure."""
    key = str(device).lower()
    Z2M_ERRORS.pop(key, None)
    z2m_set(s, device, payload)
    task.sleep(Z2M_GAP)
    err = Z2M_ERRORS.pop(key, None)
    if err:
        raise RuntimeError(f"Zigbee error on {list(payload)[0]}: {z2m_error_cause(err)}")


def program_z2m(s, device, groups, eid):
    # one message at a time: Z2M does not queue them, and the Ally refuses
    # schedule mode until the weekly schedule is stored
    z2m_step(s, device, {"clear_weekly_schedule": ""})
    for key, days in groups.items():
        transitions = []
        for b in json.loads(key):
            transitions.append({"transitionTime": int(b[0]), "heatSetpoint": float(b[1])})
        z2m_step(s, device, {"weekly_schedule": {"dayofweek": [DAY_NAMES[d] for d in days], "transitions": transitions}})
    want = z2m_oper_mode(s.get("oper_mode", 1))
    z2m_step(s, device, {"programming_operation_mode": want})
    return z2m_confirm(s, device, eid, want)


def retry_later(sid, eid, later):
    task.unique(f"climate_schedule_retry_{sid}_{eid}")
    task.sleep(RETRY_LATER[later] * 60)
    st = SCHEDULES.get(sid, {}).get("status", {}).get(eid)
    if not st or st.get("state") != "error":
        return  # programmed meanwhile (Re-sync, valve came back, ...)
    log.info(f"climate_schedule {sid}: retrying {eid} ({later + 1}/{len(RETRY_LATER)})")
    for c in SCHEDULES[sid]["climates"]:
        if ent_id(c) == eid:
            set_status(sid, eid, "pending")
            push_valve(sid, c, later + 1)
            save_store()


def push_valve(sid, c, later=0):
    s = SCHEDULES[sid]
    eid = ent_id(c)
    kind, target = resolve_target(c)
    if kind is None:
        set_status(sid, eid, "error", f"{target} (set ieee or z2m in card config)")
        return False
    if is_unavailable(eid):
        set_status(sid, eid, "error", "valve unavailable, will retry when it is back")
        return False
    lo, hi = valve_limits(eid)
    groups = day_groups(s, lo, hi)
    top = max([float(p["temp"]) for p in s["presets"]])
    note = f", limited to {hi:g}°" if hi < top else ""

    last_err = ""
    for attempt in range(RETRIES):
        try:
            if kind == "zha":
                program_zha(s, target, groups)
                set_status(sid, eid, "ok", f"{len(groups)} day group(s) via ZHA{note}")
            else:
                confirmed = program_z2m(s, target, groups, eid)
                set_status(sid, eid, "ok", f"{len(groups)} day group(s) via Z2M{note}" + ("" if confirmed else ", mode not confirmed"))
            log.info(f"climate_schedule {sid}: programmed {eid} ({kind} {target})")
            return True
        except Exception as e:
            # some errors (timeouts) have no message: always name the type
            last_err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            log.warning(f"climate_schedule {sid}: {eid} attempt {attempt + 1} failed: {last_err}")
            task.sleep(RETRY_WAIT)
    if later < len(RETRY_LATER):
        nxt = (datetime.now() + timedelta(minutes=RETRY_LATER[later])).isoformat(timespec="seconds")
        set_status(sid, eid, "error", last_err[:200], nxt)
        task.create(retry_later, sid, eid, later)
    else:
        set_status(sid, eid, "error", last_err[:200])
    return False


def push_schedule(sid):
    task.unique(f"climate_schedule_push_{sid}")
    s = SCHEDULES.get(sid)
    if not s or s.get("mode") != "native":
        return
    for c in s["climates"]:
        SCHEDULES[sid].setdefault("status", {})[ent_id(c)] = {"state": "pending", "at": now_iso(), "msg": ""}
    publish(sid)
    # all valves in parallel: one unreachable valve (retries, timeouts) must not hold up the others
    tasks = set()
    for c in s["climates"]:
        tasks.add(task.create(push_valve, sid, c))
    task.wait(tasks)
    save_store()


def set_valves_manual(sid):
    """Switch valves back to plain setpoint mode (schedule bit off)."""
    s = SCHEDULES[sid]
    for c in s["climates"]:
        kind, target = resolve_target(c)
        try:
            if kind == "zha":
                service.call(
                    "zha", "set_zigbee_cluster_attribute", blocking=True,
                    ieee=target, endpoint_id=ENDPOINT, cluster_id=THERMOSTAT,
                    cluster_type="in", attribute=ATTR_PROG_MODE, value=0,
                )
            elif kind == "z2m":
                z2m_set(s, target, {"programming_operation_mode": z2m_oper_mode(0)})
        except Exception as e:
            log.warning(f"climate_schedule {sid}: could not reset {ent_id(c)}: {e}")


# ---------------------------------------------------------------- HA-driven mode
def current_temp(s, now):
    slot = (now.hour * 60 + now.minute) // SLOT_MIN
    return float(s["presets"][int(s["days"][now.weekday()][slot])]["temp"])


def next_change(s, now):
    """datetime of the next block with a different temperature, None if the week is flat"""
    day = now.weekday()
    slot = (now.hour * 60 + now.minute) // SLOT_MIN
    cur = float(s["presets"][int(s["days"][day][slot])]["temp"])
    for k in range(1, SLOTS * 7 + 1):
        n = slot + k
        d = (day + n // SLOTS) % 7
        if float(s["presets"][int(s["days"][d][n % SLOTS])]["temp"]) != cur:
            return now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(minutes=n * SLOT_MIN)
    return None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def valve_limits(eid):
    """(min, max) setpoint the valve accepts: the climate entity's min/max_temp (ZHA reads the valve's
    min/max_heat_setpoint_limit), tightened by Z2M's number entities for the same limits if present."""
    lo, hi = 5.0, 35.0
    try:
        st = state.getattr(eid) or {}
    except NameError:
        st = {}
    if num(st.get("min_temp")) is not None:
        lo = max(lo, num(st.get("min_temp")))
    if num(st.get("max_temp")) is not None:
        hi = min(hi, num(st.get("max_temp")))
    reg = er.async_get(hass)
    ent = reg.async_get(eid)
    if ent is not None and ent.device_id is not None:
        for e in er.async_entries_for_device(reg, ent.device_id):
            if not e.entity_id.startswith("number."):
                continue
            try:
                v = num(state.get(e.entity_id))
            except NameError:
                v = None
            if v is None:
                continue
            if e.entity_id.endswith("max_heat_setpoint_limit"):
                hi = min(hi, v)
            elif e.entity_id.endswith("min_heat_setpoint_limit"):
                lo = max(lo, v)
    return lo, hi


def set_all(sid, t):
    for c in SCHEDULES[sid]["climates"]:
        lo, hi = valve_limits(ent_id(c))
        try:
            service.call("climate", "set_temperature", entity_id=ent_id(c), temperature=min(hi, max(lo, t)))
        except Exception as e:
            log.warning(f"climate_schedule {sid}: set_temperature {ent_id(c)} failed: {e}")


def base_temp(s, now):
    """what the room should be at without a boost: presence override, else the schedule"""
    ps = s.get("presence_state") or {}
    return float(ps["temp"]) if ps.get("active") else current_temp(s, now)


def preset_now(s, now):
    slot = (now.hour * 60 + now.minute) // SLOT_MIN
    return s["presets"][int(s["days"][now.weekday()][slot])]


def person_home(p):
    try:
        return state.get(p) == "home"
    except NameError:
        return False


def presence_eval(sid, force=False):
    """decide whether presence raises the current block, and apply a change to the valves"""
    s = SCHEDULES.get(sid)
    if not s:
        return
    cfg = s.get("presence") or {}
    now = datetime.now()
    who = [p for p in (cfg.get("persons") or []) if person_home(p)]
    manual = s.get("home_today") == now.date().isoformat()
    cur = preset_now(s, now)
    target = None
    for p in s["presets"]:
        if p.get("name") == cfg.get("preset"):
            target = p
    sched_t = float(cur["temp"])
    active = bool((who or manual) and target is not None and cur.get("name") in (cfg.get("replace") or [])
                  and float(target["temp"]) > sched_t)  # only ever raises
    prev = s.get("presence_state") or {}
    s["presence_state"] = {"active": active, "temp": float(target["temp"]) if active else None,
                           "preset": target.get("name") if target else None, "who": who, "manual": manual, "sched": sched_t}
    publish(sid)
    if s.get("boost"):
        return  # the boost owns the setpoint; end_boost restores to base_temp
    changed = active != bool(prev.get("active")) or (active and (s["presence_state"]["temp"] != prev.get("temp") or sched_t != prev.get("sched")))
    if not (changed or force):
        return
    if s.get("mode") == "ha":
        apply_ha(sid, force=True)
    elif active:
        log.info(f"climate_schedule {sid}: presence ({', '.join(who) or 'home today'}) -> {target.get('name')} {float(target['temp']):g}°")
        set_all(sid, float(target["temp"]))  # re-applied after the valve's own block change too (sched changed)
    elif prev.get("active") and prev.get("temp") != sched_t:  # the block may already be at that temperature
        log.info(f"climate_schedule {sid}: presence over -> schedule {sched_t:g}°")
        set_all(sid, sched_t)


def presence_eval_all():
    for sid in list(SCHEDULES):
        if (SCHEDULES[sid].get("presence") or {}).get("persons") or SCHEDULES[sid].get("home_today") or (SCHEDULES[sid].get("presence_state") or {}).get("active"):
            presence_eval(sid)


@time_trigger("cron(1,31 * * * *)")
def climate_schedule_presence_tick():
    # 1 minute after each block boundary (the valve switched by itself); 00:01 also ends "Home today"
    presence_eval_all()


def make_person_trigger(person):
    @state_trigger(f"{person}")
    def _person_changed(**kwargs):
        for sid in list(SCHEDULES):
            if person in ((SCHEDULES[sid].get("presence") or {}).get("persons") or []):
                presence_eval(sid)
    return _person_changed


def apply_ha(sid, force=False):
    s = SCHEDULES[sid]
    if s.get("boost"):
        return  # the boost owns the setpoint until it ends
    t = base_temp(s, datetime.now())
    if not force and HA_LAST.get(sid) == t:
        return
    HA_LAST[sid] = t
    set_all(sid, t)


# ---------------------------------------------------------------- boost
def end_boost(sid, restore):
    s = SCHEDULES.get(sid)
    if not s or not s.get("boost"):
        return
    s.pop("boost", None)
    publish(sid)
    save_store()
    if not restore:
        return
    if s.get("mode") == "ha":
        apply_ha(sid, force=True)
    else:
        set_all(sid, base_temp(s, datetime.now()))  # back to the schedule (or presence); the valve follows its schedule at the next block


def boost_timer(sid, token):
    task.unique(f"climate_schedule_boost_{sid}")
    while True:
        s = SCHEDULES.get(sid)
        b = s.get("boost") if s else None
        if not b or b.get("token") != token:
            return
        now = datetime.now()
        end = datetime.fromisoformat(b["until"])
        if now >= end:
            break
        nxt = next_change(s, now) if s.get("mode") != "ha" else None
        if b["kind"] == "timed" and nxt is not None and nxt < end:
            # the valve drops a manual setpoint at its next block change: put the boost back right after it
            task.sleep((nxt - now).total_seconds() + 60)
            b = SCHEDULES.get(sid, {}).get("boost")
            if b and b.get("token") == token:
                set_all(sid, b["temp"])
        else:
            task.sleep(max(1, (end - now).total_seconds()))
    # "until next change": the valve (or the HA tick) already moved on, only HA mode needs a push
    end_boost(sid, restore=b["kind"] == "timed" or SCHEDULES[sid].get("mode") == "ha")


@time_trigger("cron(0,30 * * * *)")
def climate_schedule_ha_tick():
    for sid in list(SCHEDULES):
        if SCHEDULES[sid].get("mode") == "ha":
            apply_ha(sid)


# ---------------------------------------------------------------- triggers
def push_one(sid, eid):
    s = SCHEDULES.get(sid)
    if not s or s.get("mode") != "native":
        return
    for c in s["climates"]:
        if ent_id(c) == eid:
            set_status(sid, eid, "pending")
            push_valve(sid, c)
            save_store()


def make_avail_trigger(sid, eid):
    @state_trigger(f"{eid} != 'unavailable' and {eid}.old == 'unavailable'")
    def _came_back(**kwargs):
        if STARTED_AT is None or (datetime.now() - STARTED_AT).total_seconds() < STARTUP_GRACE:
            return  # HA / Zigbee restart: every valve "comes back", nothing was lost
        task.unique(f"climate_schedule_back_{sid}_{eid}")  # a flapping valve collapses into one push
        task.sleep(60)
        log.info(f"climate_schedule {sid}: {eid} is back, re-pushing it")
        push_one(sid, eid)  # only this valve: the others still have their schedule
    return _came_back


def setup_triggers():
    global AVAIL_TRIGGERS, LOG_TRIGGERS, PERSON_TRIGGERS
    trig = {}
    logs = {}
    persons = {}
    for sid, s in SCHEDULES.items():
        for p in (s.get("presence") or {}).get("persons") or []:
            persons[p] = PERSON_TRIGGERS.get(p) or make_person_trigger(p)
    PERSON_TRIGGERS = persons
    for sid, s in SCHEDULES.items():
        if s.get("mode") == "native":
            for c in s["climates"]:
                eid = ent_id(c)
                trig[f"{sid}|{eid}"] = make_avail_trigger(sid, eid)
                if resolve_target(c)[0] == "z2m":
                    base = s.get("z2m_base_topic") or Z2M_DEFAULT_BASE
                    if base not in logs:
                        logs[base] = LOG_TRIGGERS.get(base) or make_log_trigger(base)
    AVAIL_TRIGGERS = trig
    LOG_TRIGGERS = logs


@time_trigger("startup")
def climate_schedule_startup():
    global SCHEDULES, STARTED_AT
    STARTED_AT = datetime.now()
    try:
        SCHEDULES = task.executor(_read_store, STORE) or {}
    except Exception as e:
        log.error(f"climate_schedule: cannot read {STORE}: {e}")
        SCHEDULES = {}
    for sid in SCHEDULES:
        publish(sid)
        if SCHEDULES[sid].get("boost"):
            task.create(boost_timer, sid, SCHEDULES[sid]["boost"]["token"])  # resumes, or ends an expired boost
    setup_triggers()
    presence_eval_all()
    log.info(f"climate_schedule: loaded {len(SCHEDULES)} schedule(s)")


def zha_valves(schedule_id=None):
    ids = [slug(schedule_id)] if schedule_id else list(SCHEDULES)
    out = {}
    for sid in ids:
        s = SCHEDULES.get(sid)
        if not s or s.get("mode") != "native":
            continue
        for c in s["climates"]:
            kind, target = resolve_target(c)
            if kind == "zha":
                out[ent_id(c)] = target
    return out


def sync_time_one(eid, ieee):
    try:
        sync_time_zha(ieee)
        log.info(f"climate_schedule: clock set on {eid}")
    except Exception as e:
        log.warning(f"climate_schedule: clock sync failed on {eid}: {type(e).__name__} {e}")


def sync_time_all(schedule_id=None):
    tasks = set()
    for eid, ieee in zha_valves(schedule_id).items():
        if not is_unavailable(eid):
            tasks.add(task.create(sync_time_one, eid, ieee))
    if tasks:
        task.wait(tasks)


@time_trigger(TIME_SYNC)
def climate_schedule_time_sync():
    sync_time_all()


@time_trigger(NIGHTLY_RESYNC)
def climate_schedule_nightly():
    for sid in list(SCHEDULES):
        # off by default: re-writing an unchanged schedule only adds Zigbee traffic, and a
        # dropped link between Clear and Set would leave the valve without a schedule
        if SCHEDULES[sid].get("mode") == "native" and SCHEDULES[sid].get("nightly_resync"):
            push_schedule(sid)


# ---------------------------------------------------------------- services
@service
def climate_schedule_save(schedule_id=None, title=None, climates=None, presets=None,
                          days=None, mode="native", oper_mode=1, z2m_base_topic=None,
                          nightly_resync=False):
    """yaml
name: Save climate schedule
description: Store a week schedule and program the valves (called by danfoss-schedule-card).
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
  title:
    description: Display name
    example: Living room
    selector:
      text:
  climates:
    description: "Climate entities, or {entity, ieee} / {entity, z2m} objects"
    required: true
    selector:
      object:
  presets:
    description: "List of {name, temp, color}"
    required: true
    selector:
      object:
  days:
    description: "7 strings (Mon..Sun) of 48 preset indexes"
    required: true
    selector:
      object:
  mode:
    description: "native = on-valve schedule, ha = HA sets the temperature"
    example: native
    selector:
      select:
        options: [native, ha]
  oper_mode:
    description: "Value for programming_operation_mode (1 = schedule)"
    example: 1
    selector:
      number:
        min: 0
        max: 255
  z2m_base_topic:
    description: "Zigbee2MQTT base topic (only for Z2M valves)"
    example: zigbee2mqtt
    selector:
      text:
  nightly_resync:
    description: "Re-program the valves every night at 03:15"
    example: false
    selector:
      boolean:
"""
    if not schedule_id or not climates:
        raise ValueError("schedule_id and climates are required")
    err = validate(presets, days)
    if err:
        raise ValueError(err)
    sid = slug(schedule_id)
    old = SCHEDULES.get(sid, {})
    if old.get("mode") == "native" and mode == "ha":
        set_valves_manual(sid)
    SCHEDULES[sid] = {
        "title": title or old.get("title") or schedule_id,
        "climates": climates,
        "presets": [{"name": p.get("name", f"P{i}"), "temp": float(p["temp"]),
                     "color": p.get("color", "#888")} for i, p in enumerate(presets)],
        "days": days,
        "mode": mode if mode in ("native", "ha") else "native",
        "oper_mode": int(oper_mode),
        "z2m_base_topic": z2m_base_topic or old.get("z2m_base_topic") or Z2M_DEFAULT_BASE,
        "nightly_resync": str(nightly_resync).lower() in ("true", "1", "yes", "on"),
        "status": {},
        "updated": now_iso(),
    }
    for k in ("boost", "presence", "home_today"):  # survive editing the schedule
        if old.get(k):
            SCHEDULES[sid][k] = old[k]
    save_store()
    publish(sid)
    setup_triggers()
    if SCHEDULES[sid]["mode"] == "native":
        task.create(push_schedule, sid)
    else:
        apply_ha(sid, force=True)


@service
def climate_schedule_push(schedule_id=None, valve=None):
    """yaml
name: Re-push climate schedule
description: Program the valves again (all schedules if no id; only one valve if given).
fields:
  schedule_id:
    description: "Schedule id (empty = all)"
    example: living_room
    selector:
      text:
  valve:
    description: "Only this climate entity of the schedule"
    example: climate.danfoss_pracovna_right
    selector:
      entity:
        domain: climate
"""
    if schedule_id and valve:
        task.create(push_one, slug(schedule_id), valve)
        return
    ids = [slug(schedule_id)] if schedule_id else list(SCHEDULES)
    for sid in ids:
        if sid in SCHEDULES:
            task.create(push_schedule, sid)


@service
def climate_schedule_boost(schedule_id=None, temperature=None, minutes=60):
    """yaml
name: Boost climate schedule
description: Set all valves of a schedule to a temperature for a while, then return to the schedule.
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
  temperature:
    description: Boost temperature
    required: true
    example: 23
    selector:
      number:
        min: 5
        max: 30
        step: 0.5
  minutes:
    description: "Duration in minutes, 0 = until the next block change"
    example: 60
    selector:
      number:
        min: 0
        max: 720
"""
    sid = slug(schedule_id)
    s = SCHEDULES.get(sid)
    if not s:
        raise ValueError(f"unknown schedule {schedule_id}")
    t = max(5.0, min(30.0, float(temperature)))
    now = datetime.now()
    if int(minutes or 0) > 0:
        kind, end = "timed", now + timedelta(minutes=int(minutes))
    else:
        kind, end = "next", next_change(s, now)
        if end is None:
            raise ValueError("the schedule has no next change, give a duration")
    token = str(now.timestamp())
    s["boost"] = {"temp": t, "until": end.isoformat(timespec="seconds"), "kind": kind, "token": token}
    publish(sid)
    save_store()
    set_all(sid, t)
    task.create(boost_timer, sid, token)


@service
def climate_schedule_settings(schedule_id=None, presence_persons=None, presence_replace=None, presence_preset=None):
    """yaml
name: Climate schedule settings
description: Presence settings of a schedule (set by the card; does not re-program the valves).
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
  presence_persons:
    description: "Persons: home mode while at least one of them is home"
    selector:
      entity:
        domain: person
        multiple: true
  presence_replace:
    description: "Preset names raised while someone is home, e.g. [Away]"
    selector:
      object:
  presence_preset:
    description: "Preset name to raise them to, e.g. Comfort"
    selector:
      text:
"""
    sid = slug(schedule_id)
    s = SCHEDULES.get(sid)
    if not s:
        raise ValueError(f"unknown schedule {schedule_id}")
    persons = presence_persons or []
    if isinstance(persons, str):
        persons = [persons]
    replace = presence_replace or []
    if isinstance(replace, str):
        replace = [replace]
    s["presence"] = {"persons": list(persons), "replace": list(replace), "preset": presence_preset or None}
    save_store()
    setup_triggers()
    presence_eval(sid)


@service
def climate_schedule_home_today(schedule_id=None, enable=True):
    """yaml
name: Home today
description: Treat the room as occupied (home mode) until midnight, or switch that off again.
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
  enable:
    description: On or off
    example: true
    selector:
      boolean:
"""
    sid = slug(schedule_id)
    s = SCHEDULES.get(sid)
    if not s:
        raise ValueError(f"unknown schedule {schedule_id}")
    s["home_today"] = datetime.now().date().isoformat() if str(enable).lower() in ("true", "1", "yes", "on") else None
    save_store()
    presence_eval(sid)


@service
def climate_schedule_sync_time(schedule_id=None):
    """yaml
name: Sync valve clocks
description: Write the current local time, zone and DST rules into the ZHA valves (all schedules if no id).
fields:
  schedule_id:
    description: "Schedule id (empty = all)"
    example: living_room
    selector:
      text:
"""
    sync_time_all(schedule_id)


@service
def climate_schedule_boost_cancel(schedule_id=None):
    """yaml
name: Cancel climate schedule boost
description: End a running boost and return the valves to the schedule.
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
"""
    end_boost(slug(schedule_id), restore=True)


@service
def climate_schedule_delete(schedule_id=None):
    """yaml
name: Delete climate schedule
description: Remove a schedule and switch its valves back to manual setpoint mode.
fields:
  schedule_id:
    description: Schedule id
    required: true
    example: living_room
    selector:
      text:
"""
    sid = slug(schedule_id)
    if sid not in SCHEDULES:
        return
    if SCHEDULES[sid].get("mode") == "native":
        set_valves_manual(sid)
    del SCHEDULES[sid]
    HA_LAST.pop(sid, None)
    save_store()
    state.delete(ENTITY_PREFIX + sid)
    setup_triggers()
