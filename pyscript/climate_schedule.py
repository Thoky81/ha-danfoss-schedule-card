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
  and every night at 03:15 (the Ally loses its schedule after a
  battery change / OTA).
- mode "ha": HA sets climate.set_temperature at each block change
  (fallback if the on-valve schedule misbehaves).

pyscript config (configuration.yaml):
  pyscript:
    allow_all_imports: true
    hass_is_global: true
"""
import json
import os
import re
from datetime import datetime

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

STORE = "/config/climate_schedules.json"
ENTITY_PREFIX = "pyscript.climate_schedule_"
ENDPOINT = 1                 # Danfoss Ally thermostat endpoint
THERMOSTAT = 513             # 0x0201
CMD_SET_WEEKLY = 1           # SetWeeklySchedule
CMD_CLEAR_WEEKLY = 3         # ClearWeeklySchedule
ATTR_PROG_MODE = 0x0025      # programming_operation_mode, bit0 = schedule
SLOTS = 48                   # 30-minute cells
SLOT_MIN = 30
MAX_BLOCKS = 6               # Danfoss: 6 transitions per day
DAY_BITS = [2, 4, 8, 16, 32, 64, 1]  # Mon..Sun -> ZCL SeqDayOfWeek (Sun = bit0)
RETRIES = 3
DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
Z2M_DEFAULT_BASE = "zigbee2mqtt"
Z2M_OPER_MODES = {0: "setpoint", 1: "schedule", 3: "schedule_with_preheat", 4: "eco"}
NIGHTLY_RESYNC = "cron(15 3 * * *)"

SCHEDULES = {}
AVAIL_TRIGGERS = {}
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


def save_store():
    task.executor(_write_store, STORE, SCHEDULES)


# ---------------------------------------------------------------- helpers
def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def ent_id(c):
    return c["entity"] if isinstance(c, dict) else c


def day_blocks(day, presets):
    """'000022..' (48 chars) -> [(start_minute, temp), ...] merged by temperature."""
    out = []
    for i in range(SLOTS):
        t = float(presets[int(day[i])]["temp"])
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


def day_groups(s):
    """identical days -> one command: {json(blocks): [day indexes]}"""
    groups = {}
    for d in range(7):
        key = json.dumps(day_blocks(s["days"][d], s["presets"]))
        groups.setdefault(key, []).append(d)
    return groups


def publish(sid):
    s = SCHEDULES[sid]
    status = s.get("status", {})
    if s.get("mode") == "ha":
        overall = "ha"
    elif any(v.get("state") == "error" for v in status.values()):
        overall = "error"
    elif any(v.get("state") == "pending" for v in status.values()):
        overall = "pending"
    elif status:
        overall = "ok"
    else:
        overall = "unknown"
    state.set(
        ENTITY_PREFIX + sid,
        overall,
        new_attributes={
            "friendly_name": f"Climate schedule {s.get('title', sid)}",
            "icon": "mdi:calendar-clock",
            "title": s.get("title", sid),
            "climates": s["climates"],
            "presets": s["presets"],
            "days": s["days"],
            "mode": s.get("mode", "native"),
            "oper_mode": s.get("oper_mode", 1),
            "z2m_base_topic": s.get("z2m_base_topic", Z2M_DEFAULT_BASE),
            "status": status,
            "updated": s.get("updated"),
        },
    )


def set_status(sid, eid, st, msg=""):
    SCHEDULES[sid].setdefault("status", {})[eid] = {"state": st, "at": now_iso(), "msg": msg}
    publish(sid)


def is_unavailable(eid):
    try:
        return state.get(eid) == "unavailable"
    except NameError:
        return True


# ---------------------------------------------------------------- ZHA
def zha_cmd(ieee, command, params=None):
    kw = {
        "ieee": ieee,
        "endpoint_id": ENDPOINT,
        "cluster_id": THERMOSTAT,
        "cluster_type": "in",
        "command": command,
        "command_type": "server",
    }
    if params is not None:
        kw["params"] = params
    service.call("zha", "issue_zigbee_cluster_command", blocking=True, **kw)


def program_zha(s, ieee, groups):
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


def program_z2m(s, device, groups):
    z2m_set(s, device, {"clear_weekly_schedule": ""})
    task.sleep(1)
    for key, days in groups.items():
        transitions = []
        for b in json.loads(key):
            transitions.append({"transitionTime": int(b[0]), "heatSetpoint": float(b[1])})
        z2m_set(s, device, {"weekly_schedule": {"dayofweek": [DAY_NAMES[d] for d in days], "transitions": transitions}})
        task.sleep(1)
    z2m_set(s, device, {"programming_operation_mode": z2m_oper_mode(s.get("oper_mode", 1))})


def push_valve(sid, c):
    s = SCHEDULES[sid]
    eid = ent_id(c)
    kind, target = resolve_target(c)
    if kind is None:
        set_status(sid, eid, "error", f"{target} (set ieee or z2m in card config)")
        return False
    if is_unavailable(eid):
        set_status(sid, eid, "error", "valve unavailable, will retry when it is back")
        return False
    groups = day_groups(s)

    last_err = ""
    for attempt in range(RETRIES):
        try:
            if kind == "zha":
                program_zha(s, target, groups)
                set_status(sid, eid, "ok", f"{len(groups)} day group(s) via ZHA")
            else:
                program_z2m(s, target, groups)
                set_status(sid, eid, "ok", f"{len(groups)} day group(s) sent via Z2M")
            log.info(f"climate_schedule {sid}: programmed {eid} ({kind} {target})")
            return True
        except Exception as e:
            last_err = str(e)
            log.warning(f"climate_schedule {sid}: {eid} attempt {attempt + 1} failed: {e}")
            task.sleep(10)
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
    for c in s["climates"]:
        push_valve(sid, c)
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


def apply_ha(sid, force=False):
    s = SCHEDULES[sid]
    t = current_temp(s, datetime.now())
    if not force and HA_LAST.get(sid) == t:
        return
    HA_LAST[sid] = t
    for c in s["climates"]:
        try:
            service.call("climate", "set_temperature", entity_id=ent_id(c), temperature=t)
        except Exception as e:
            log.warning(f"climate_schedule {sid}: set_temperature {ent_id(c)} failed: {e}")


@time_trigger("cron(0,30 * * * *)")
def climate_schedule_ha_tick():
    for sid in list(SCHEDULES):
        if SCHEDULES[sid].get("mode") == "ha":
            apply_ha(sid)


# ---------------------------------------------------------------- triggers
def make_avail_trigger(sid, eid):
    @state_trigger(f"{eid} != 'unavailable' and {eid}.old == 'unavailable'")
    def _came_back(**kwargs):
        task.sleep(60)
        log.info(f"climate_schedule {sid}: {eid} is back, re-pushing schedule")
        push_schedule(sid)
    return _came_back


def setup_triggers():
    global AVAIL_TRIGGERS
    trig = {}
    for sid, s in SCHEDULES.items():
        if s.get("mode") == "native":
            for c in s["climates"]:
                eid = ent_id(c)
                trig[f"{sid}|{eid}"] = make_avail_trigger(sid, eid)
    AVAIL_TRIGGERS = trig


@time_trigger("startup")
def climate_schedule_startup():
    global SCHEDULES
    try:
        SCHEDULES = task.executor(_read_store, STORE) or {}
    except Exception as e:
        log.error(f"climate_schedule: cannot read {STORE}: {e}")
        SCHEDULES = {}
    for sid in SCHEDULES:
        publish(sid)
    setup_triggers()
    log.info(f"climate_schedule: loaded {len(SCHEDULES)} schedule(s)")


@time_trigger(NIGHTLY_RESYNC)
def climate_schedule_nightly():
    for sid in list(SCHEDULES):
        if SCHEDULES[sid].get("mode") == "native":
            push_schedule(sid)


# ---------------------------------------------------------------- services
@service
def climate_schedule_save(schedule_id=None, title=None, climates=None, presets=None,
                          days=None, mode="native", oper_mode=1, z2m_base_topic=None):
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
        "status": {},
        "updated": now_iso(),
    }
    save_store()
    publish(sid)
    setup_triggers()
    if SCHEDULES[sid]["mode"] == "native":
        task.create(push_schedule, sid)
    else:
        apply_ha(sid, force=True)


@service
def climate_schedule_push(schedule_id=None):
    """yaml
name: Re-push climate schedule
description: Program the valves again (all schedules if no id).
fields:
  schedule_id:
    description: "Schedule id (empty = all)"
    example: living_room
    selector:
      text:
"""
    ids = [slug(schedule_id)] if schedule_id else list(SCHEDULES)
    for sid in ids:
        if sid in SCHEDULES:
            task.create(push_schedule, sid)


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
