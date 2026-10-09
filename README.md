# Danfoss Ally week schedule (ZHA + pyscript)

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
  hass_is_global: true      # needed to look up each valve's ZHA IEEE address
```
Copy [`pyscript/climate_schedule.py`](pyscript/climate_schedule.py) to `/config/pyscript/`, restart HA (first time) or reload pyscript.
Schedules are saved to `/config/climate_schedules.json`.

Services: `pyscript.climate_schedule_save`, `pyscript.climate_schedule_push`, `pyscript.climate_schedule_delete`.

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

```yaml
type: custom:danfoss-schedule-card
schedule_id: living_room
title: Living room
climates:
  - climate.living_room_trv_1
  - climate.living_room_trv_2
  # - entity: climate.kids_trv
  #   ieee: "00:15:bc:00:1a:01:23:45"   # only if auto-lookup fails
mode: native            # native = program the valves | ha = HA calls climate.set_temperature
# oper_mode: 1          # programming_operation_mode written after upload (bit0 = schedule)
# presets:              # initial presets (after the first save they live in the schedule)
#   - {name: Comfort, temp: 21.5, color: "#ff8a3d"}
#   - {name: Eco, temp: 19, color: "#34c759"}
#   - {name: Night, temp: 17.5, color: "#5e5ce6"}
#   - {name: Away, temp: 15, color: "#8e8e93"}
```
One card = one schedule. All valves in `climates` get the same schedule (one room).

## Using it
- Click a preset name to pick it as the brush, then drag. The drag fills a **rectangle**: Mon→Fri × 08:00→17:00 in one move.
- `−`/`+` on a preset changes its temperature everywhere it is used.
- The `n/6` counter on each row is the number of temperature blocks that day. Danfoss stores **at most 6 per day**. If any day is over the limit, the row turns red and Save is disabled.
- Two adjacent presets with the same temperature count as one block.
- Valve dots: green = programmed, orange blinking = upload in progress, red = failed or valve unavailable. Hover a dot for details.

## How the valves are kept in sync
- On **Save**: `ClearWeeklySchedule`, then one `SetWeeklySchedule` per group of identical days (e.g. Mon–Fri + Sat–Sun = 2 commands), then `programming_operation_mode = 1`. Each valve is tried up to 3 times.
- The Ally **loses its schedule after a battery change or OTA**, so the schedule is re-pushed automatically:
  - when a valve comes back from `unavailable` (60 s later)
  - every night at 03:15
  - manually with **Re-sync**
- Switching a schedule to `mode: ha`, or deleting it, puts the valves back into plain setpoint mode.

## First test (do this on one valve)
1. Put a single TRV in `climates`, set a block change 5–10 minutes from now, and press Save & program.
2. The dot turns green. In ZHA → device → Manage Zigbee device → Thermostat (0x0201), read `programing_oper_mode`. It should be `1`.
3. At the change time the setpoint should move on its own. `setpoint_change_source` should read `schedule` (0x01).
4. If the change happens at the wrong hour, the valve's clock or time zone is off. Use `mode: ha` until that is fixed.

Optional: keep the schedule entities out of the recorder:
```yaml
recorder:
  exclude:
    entity_globs: [pyscript.climate_schedule_*]
```
