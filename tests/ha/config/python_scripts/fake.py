# simulated Danfoss valves + schedule entities (what ZHA and the pyscript backend would publish)
t = dt_util.now()
presets = [
    {"name": "Eco", "temp": 19, "color": "#34c759"},
    {"name": "Night", "temp": 17.5, "color": "#5e5ce6"},
    {"name": "Away", "temp": 15, "color": "#8e8e93"},
    {"name": "Comfort", "temp": 23, "color": "#ff8a3d"},
    {"name": "Warm", "temp": 25, "color": "#ff453a"},
]
wd = "1" * 11 + "4" * 3 + "3" * 3 + "2" * 17 + "3" * 11 + "1" * 3
we = "1" * 16 + "4" * 3 + "3" * 7 + "0" * 4 + "3" * 16 + "1" * 2
for r in range(5):
    vs = []
    for v in range(3):
        eid = "climate.room%d_trv%d" % (r, v)
        vs.append(eid)
        temp = 20 + ((t.second + r * 7 + v * 3) % 30) / 10.0
        hass.states.set(eid, "heat", {"friendly_name": "Room %d TRV %d" % (r, v), "current_temperature": temp, "temperature": 22, "hvac_modes": ["heat"]})
    hass.states.set("sensor.room%d_temperature" % r, str(round(20.5 + (t.second % 20) / 10.0, 1)), {"device_class": "temperature", "unit_of_measurement": "°C", "friendly_name": "Room %d" % r})
    status = {}
    for e in vs:
        status[e] = {"state": "ok", "at": "2026-10-11T08:00:00", "msg": "2 day group(s) via ZHA"}
    hass.states.set("pyscript.climate_schedule_room%d" % r, "ok", {"title": "Room %d" % r, "climates": vs, "presets": presets, "days": [wd, wd, wd, wd, wd, we, we], "mode": "native", "status": status, "updated": "2026-10-11T08:00:00", "nightly_resync": False})
