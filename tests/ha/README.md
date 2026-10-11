# Real Home Assistant + WebKit scroll test

Runs the card in a real Home Assistant (Sections view, 5 cards, 15 simulated valves updating every 3 s)
and checks in WebKit – Safari's engine – that a scrolled dashboard doesn't jump.

```sh
cd tests/ha
python3 -m venv venv && ./venv/bin/pip install homeassistant playwright && ./venv/bin/python -m playwright install webkit
mkdir -p config/www && cp ../../dist/danfoss-schedule-card.js config/www/
./venv/bin/hass -c config &          # wait until http://127.0.0.1:8125 answers
./onboard.sh > tokens.json           # first run only
./venv/bin/python scrolltest.py tokens.json 60 shot.png
```

Expected: `jumps: none`. Copy the card into `config/www/` again after every change (a fresh WebKit has no cache).
