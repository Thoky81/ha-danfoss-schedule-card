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

Services: `pyscript.climate_schedule_save`, `pyscript.climate_schedule_push`, `pyscript.climate_schedule_delete`, `pyscript.climate_schedule_boost`, `pyscript.climate_schedule_boost_cancel`.

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
climates:
  - climate.living_room_trv_1
  - climate.living_room_trv_2
  # - entity: climate.kids_trv
  #   ieee: "00:15:bc:00:1a:01:23:45"   # ZHA, only if auto-detection fails
  # - entity: climate.office_trv
  #   z2m: "Office TRV"                 # Zigbee2MQTT friendly name, only if auto-detection fails
mode: native            # native = program the valves | ha = HA calls climate.set_temperature
# oper_mode: 1          # programming_operation_mode written after upload (bit0 = schedule)
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
- Valve dots: green = programmed, orange blinking = upload in progress, red = failed or valve unavailable. Hover a dot for details.

### Boost
**🔥 Boost** sets all valves of the card to a temperature for 30 min – 3 h, or until the next block change, then returns them to the schedule. While it runs the header shows e.g. *24.0° Boost until 16:30*, and **Cancel boost** ends it early.

You can also just change the setpoint on the valve or in HA: in schedule mode the Ally keeps a manual setpoint **until its next block change** and then follows the schedule again. Boost does the same, but for a fixed time (if a block change falls inside a boost, the boost is re-applied right after it).

Services: `pyscript.climate_schedule_boost` (`schedule_id`, `temperature`, `minutes`, 0 = until next change) and `pyscript.climate_schedule_boost_cancel`, e.g. for an automation or a button.

### Presets
Preset names, temperatures and colors are edited in the **card editor** (dashboard edit mode → edit the card), not on the card itself. The editor shows the presets the schedule uses now; after changing them the card shows a note and **Save & program** applies them. **Undo changes** in the editor goes back to the saved presets.

New presets are added at the end. Only the last preset can be removed, and only when no block uses it (paint it over first), because removing one would shift the others.

## How the valves are kept in sync
- On **Save**: `ClearWeeklySchedule`, then one `SetWeeklySchedule` per group of identical days (e.g. Mon–Fri + Sat–Sun = 2 commands), then `programming_operation_mode = 1`. Each valve is tried up to 3 times, 30 s apart. A red dot shows the Zigbee error (hover it); `NWK_NO_ROUTE` or timeouts mean the valve wasn't reachable: check the mesh, then press **Re-sync**.
- The Ally **loses its schedule after a battery change or OTA**, so the schedule is re-pushed automatically:
  - when a valve comes back from `unavailable` (60 s later)
  - every night at 03:15
  - manually with **Re-sync**
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
