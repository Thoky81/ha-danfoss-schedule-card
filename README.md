<img src="https://raw.githubusercontent.com/Thoky81/ha-danfoss-schedule-card/main/images/icon.png" width="96" align="right" alt="">

# Danfoss Ally week schedule (ZHA / Zigbee2MQTT + pyscript)

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)

Paint-grid week schedule card. Schedules are stored in HA (master copy) and written **into the valves**
(ZCL Thermostat `SetWeeklySchedule`), so the TRVs keep following the schedule even when HA or Zigbee is down.

## Files
| File | Goes to |
|---|---|
| `dist/danfoss-schedule-card.js` | installed by HACS (or `/config/www/danfoss-schedule-card.js` manually) |
| `pyscript/climate_schedule.py` | `/config/pyscript/climate_schedule.py` (always manual — HACS installs only the card) |
| `preview.html` | local preview with a simulated HA (not needed in HA) |

## 1. pyscript
Install pyscript (HACS), then in `configuration.yaml`:
```yaml
pyscript:
  allow_all_imports: true   # json/os/re + HA registry helpers
  hass_is_global: true      # needed to look up each valve's device (ZHA or Zigbee2MQTT)
```
Copy [`pyscript/climate_schedule.py`](pyscript/climate_schedule.py) to `/config/pyscript/`, restart HA (first time) or reload pyscript.
Schedules are saved to `/config/climate_schedules.json`.

Services: `pyscript.climate_schedule_save`, `pyscript.climate_schedule_push`, `pyscript.climate_schedule_delete`, `pyscript.climate_schedule_boost`, `pyscript.climate_schedule_boost_cancel`, `pyscript.climate_schedule_sync_time`, `pyscript.climate_schedule_settings`, `pyscript.climate_schedule_home_today`.

## 2. Card

### HACS (recommended)
1. In HACS → ⋮ → **Custom repositories**
2. Add `https://github.com/Thoky81/ha-danfoss-schedule-card`, type **Dashboard** (older HACS: **Lovelace**)
3. Install **Danfoss Schedule Card**
4. Refresh your browser (HACS adds the dashboard resource automatically)

### Manual
1. Download `dist/danfoss-schedule-card.js` to `/config/www/danfoss-schedule-card.js`
2. Settings → Dashboards → ⋮ Resources → add `/local/danfoss-schedule-card.js?v=1` (JavaScript module)

### Configuration
Add the card from the dashboard card picker (**Danfoss Schedule Card**) and set it up in the visual editor:

- **Schedule ID** – unique per room (e.g. `living_room`). Changing it starts a new, empty schedule.
- **Valves** – pick the `climate.*` entities of your Danfoss Ally TRVs. All valves on one card get the same schedule.
- **Mode** – *Native* programs the valves, *HA* lets Home Assistant set the temperature.
- **Presets** – name, temperature and color of each preset. Applied with **Save & program** on the card.

YAML equivalent:

```yaml
type: custom:danfoss-schedule-card
schedule_id: living_room
title: Living room
icon: mdi:thermometer    # any mdi: icon, or an emoji
temperature_sensor: sensor.living_room_temperature   # optional, room temperature in the header
show_graph: true         # today's room temperature + target under the schedule (needs temperature_sensor)
battery_low: 15          # %, valve battery shown red below this
presence_persons: [person.tomas, person.zuzana]   # optional home mode, see Presence
presence_replace: [Away]  # presets raised while someone is home (default Away)
presence_preset: Comfort  # …to this preset (default Comfort)
climates:
  - climate.living_room_trv_1
  - climate.living_room_trv_2
  # - entity: climate.kids_trv
  #   ieee: "00:15:bc:00:1a:01:23:45"   # ZHA, only if auto-detection fails
  # - entity: climate.office_trv
  #   z2m: "Office TRV"                 # Zigbee2MQTT friendly name, only if auto-detection fails
mode: native            # native = program the valves | ha = HA calls climate.set_temperature
# oper_mode: 1          # programming_operation_mode written after upload (bit0 = schedule)
# nightly_resync: false        # re-program the valves every night at 03:15
# z2m_base_topic: zigbee2mqtt   # only for Zigbee2MQTT valves with a non-default base topic
# presets:              # edited in the card editor; defaults:
#   - {name: Eco, temp: 19, color: "#34c759"}
#   - {name: Night, temp: 17.5, color: "#5e5ce6"}
#   - {name: Away, temp: 15, color: "#8e8e93"}
#   - {name: Comfort, temp: 23, color: "#ff8a3d"}
#   - {name: Warm, temp: 25, color: "#ff453a"}
```
One card = one schedule. All valves in `climates` get the same schedule (one room).

### ZHA and Zigbee2MQTT
Each valve is detected automatically from its device in HA, so one card can mix ZHA and Zigbee2MQTT valves. The valve chips at the bottom of the card show a **ZHA** / **Z2M** tag.

| | ZHA | Zigbee2MQTT |
|---|---|---|
| Sent with | `zha.issue_zigbee_cluster_command` | `mqtt.publish` to `<base_topic>/<ieee>/set` |
| Green dot means | the valve acknowledged every command | the valve reports `programming_operation_mode = schedule` (read back from Z2M's entity) |
| Errors | reported by ZHA | read from Z2M's `<base_topic>/bridge/logging` (e.g. `NWK_NO_ROUTE`), shown on the red dot |
| Needs | ZHA integration | MQTT integration; Z2M's base topic in `z2m_base_topic` if it isn't `zigbee2mqtt` |

`mode: ha` works with any climate entity, regardless of integration.

## Using it
The card is **view-only** by default, so a stray tap (or a swipe on mobile) can't change anything.

- Press **✎ Edit schedule** to change it. Pick a preset, then drag over the grid. The drag fills a **rectangle**: Mon→Fri × 08:00→17:00 in one move.
- **Copy Mon → Tue–Fri** copies Monday's day onto Tuesday–Friday; **Copy Sat → Sun** copies Saturday onto Sunday. Paint one day, copy it to the rest.
- **Save & program** sends the schedule to the valves and locks the card again; **Cancel** drops the changes.
- The `n/6` counter on each row is the number of temperature blocks that day. Danfoss stores **at most 6 per day**. If any day is over the limit, the row turns red and Save is disabled.
- Two adjacent presets with the same temperature count as one block.
- Each valve chip shows the measured temperature and what the valve is **set** to. If the setpoint differs from the schedule (or a running boost) it turns amber with ⚠ – the valve was changed by hand, or the schedule wasn't applied. No warning in the first 10 minutes after a block change, while the valve reports its new setpoint.
- Each chip also shows the valve's **battery** (green, red under 15 %, adjustable in the editor as *Battery warning below*), found automatically through the valve's device.
- **Valves with their own limits** (e.g. max 20° in one room valve): the backend fits each valve's copy of the schedule and any boost into that valve's min/max (ZHA: the climate entity's min/max temperature; Z2M: also the *Max/Min heat setpoint limit* entities), so the other valves still get the full temperatures. The chip then shows *set 20.0° (max)* instead of a warning.
- Valve dots: green = programmed, orange blinking = programming in progress, red = programming failed **or** the valve is `unavailable` in HA right now. Hover a dot for the reason.

### Temperature history
With a room temperature sensor set, the bottom of the card shows **today** (or **yesterday**) laid out exactly like the schedule rows above: one column per half hour, in the colour and height of that half hour's target, with the room temperature as a line over it. So each column sits right under its cell in the grid. The rest of today is faded (planned), a line marks *now*. The scale is fixed at 5–35° (the Ally's range) on every card, so cards compare at a glance. Hover for exact values. The data comes from Home Assistant's history (recorder). Turn it off with *Show temperature history* in the editor.

### Valve alerts (optional)
[`extras/danfoss_alerts.yaml`](extras/danfoss_alerts.yaml) is a Home Assistant package, independent of the card, that sends a phone notification for each **new** valve problem and an "all OK" when they're solved:
error codes (ZHA `sensor.danfoss_*_software_error`, Z2M `sensor.danfoss_*_system_status_code`), a valve without contact for 30 min, battery under 20 %, and valves the schedule couldn't program. Put it in `/config/packages/`, set your `notify.mobile_app_…` action in it, and enable packages in `configuration.yaml` (`homeassistant: packages: !include_dir_named packages`). Valves are matched by entity ids starting with `danfoss_`.

### Presence (home mode)
Pick one or more **people** in the card editor (*Presence: people*). While **at least one of them is home**, blocks of the presets in *Presence: raise these presets* (default **Away**) are raised to *Presence: raise to* (default **Comfort**) – e.g. working from home on a weekday. One person home is enough. A change of who is home only counts after it lasted **30 min** (both ways, *Presence: delay*), so short trips or tracking glitches don't move the valves; the header shows a pending change (*🏠 from 10:30*, *🏠 Home · until 14:30*). The header shows **🏠 Home** and the raised target; it never lowers a room, and a Boost takes priority. **🏠 Home today** on the card does the same by hand until midnight.

It runs in the backend, so it works without the card open: valves stay in schedule mode, the temperature is set temporarily and re-applied after the valve's own block changes, and when nobody is home anymore the room goes straight back to the schedule. The card sends these settings to the backend by itself (no Save & program needed). Services: `pyscript.climate_schedule_settings`, `pyscript.climate_schedule_home_today`.

### Boost
**🔥 Boost** sets all valves of the card to a temperature for 30 min – 3 h, or until the next block change, then returns them to the schedule. While it runs the header shows e.g. *24.0° Boost until 16:30*, and **Cancel boost** ends it early.

You can also just change the setpoint on the valve or in HA: in schedule mode the Ally keeps a manual setpoint **until its next block change** and then follows the schedule again. Boost does the same, but for a fixed time (if a block change falls inside a boost, the boost is re-applied right after it).

Services: `pyscript.climate_schedule_boost` (`schedule_id`, `temperature`, `minutes`, 0 = until next change) and `pyscript.climate_schedule_boost_cancel`, e.g. for an automation or a button.

### Presets
Preset names, temperatures and colors are edited in the **card editor** (dashboard edit mode → edit the card), not on the card itself. The editor shows the presets the schedule uses now; after changing them the card shows a note and **Save & program** applies them. **Undo changes** in the editor goes back to the saved presets.

New presets are added at the end. Only the last preset can be removed, and only when no block uses it (paint it over first), because removing one would shift the others.

## How the valves are kept in sync
- On **Save**: `ClearWeeklySchedule`, then one `SetWeeklySchedule` per group of identical days (e.g. Mon–Fri + Sat–Sun = 2 commands), then `programming_operation_mode = 1`. Each valve is tried up to 3 times, 30 s apart; if all fail, that valve alone is tried again after 15 min, 1 h and 3 h (the tooltip shows the next try, and clicking the red dot retries it right away). A red dot shows the Zigbee error (hover it); `NWK_NO_ROUTE` or timeouts mean the valve wasn't reachable: check the mesh, then press **Re-sync**.
- The Ally **loses its schedule after a battery change or OTA**, so the schedule is re-pushed automatically:
  - when a valve comes back from `unavailable` (60 s later, only that valve; ignored in the first 10 min after HA/pyscript starts, since a restart doesn't erase schedules)
  - every night at 03:15, **only if** *Re-program valves every night* (`nightly_resync: true`) is on. Off by default: once the schedule is final nothing needs to touch the valves, and re-writing it adds Zigbee traffic for no gain.
  - manually with **Re-sync**
- **Valve clocks (ZHA):** ZHA doesn't set the Danfoss clock, so valves can run in UTC or without summer time and switch blocks hours late (the card's ⚠ tooltip then says *"the valve clock is probably 2 h behind"*). The backend writes the valve clock – UTC time, time zone and daylight-saving rules, like Zigbee2MQTT does – before every programming and once a day at 03:05 (only the clock, not the schedule). `pyscript.climate_schedule_sync_time` does it on demand. Zigbee2MQTT sets the clock itself.
- Switching a schedule to `mode: ha`, or deleting it, puts the valves back into plain setpoint mode.

## First test (do this on one valve)
1. Put a single TRV in `climates`, set a block change 5–10 minutes from now, and press Save & program.
2. The dot turns green.
   - ZHA: device → Manage Zigbee device → Thermostat (0x0201), read `programing_oper_mode`. It should be `1`.
   - Zigbee2MQTT: in the Z2M frontend → device → Exposes, `programming_operation_mode` should be `schedule`. Check the Z2M log for `weekly_schedule` errors.
3. At the change time the setpoint should move on its own. `setpoint_change_source` should read `schedule` (0x01).
4. If the change happens at the wrong hour, the valve's clock or time zone is off. Use `mode: ha` until that is fixed.

Optional: keep the schedule entities out of the recorder:
```yaml
recorder:
  exclude:
    entity_globs: [pyscript.climate_schedule_*]
```
