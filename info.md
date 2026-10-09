<img src="https://raw.githubusercontent.com/Thoky81/ha-danfoss-schedule-card/main/images/icon.png" width="96" align="right" alt="">

# Danfoss Schedule Card

Paint-grid week schedule for Danfoss Ally TRVs (ZHA). Schedules are written into the valves, so they keep running even when HA or Zigbee is down.

- Drag to paint a rectangle of days × hours
- Editable presets (name, temperature, color)
- Live 6-blocks-per-day limit check
- Auto re-sync after battery change / OTA
- Visual editor – pick valves and presets without YAML

**Requires the pyscript backend** (`pyscript/climate_schedule.py`) — see the README.
