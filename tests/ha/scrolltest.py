"""Open the Danfoss sections view in WebKit (Safari's engine), scroll to the bottom, watch for jumps."""
import json, sys, time
from playwright.sync_api import sync_playwright

tok = json.load(open(sys.argv[1]))
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 40
B = "http://127.0.0.1:8125"
tokens = {**tok, "hassUrl": B, "clientId": B + "/", "expires": int(time.time() * 1000) + tok["expires_in"] * 1000}

with sync_playwright() as p:
    br = p.webkit.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 800})
    pg.add_init_script(f"localStorage.setItem('hassTokens', {json.dumps(json.dumps(tokens))});")
    msgs = []
    pg.on("console", lambda m: msgs.append(f"{m.type}: {m.text}"))
    pg.goto(B + "/danfoss-test/test")
    pg.wait_for_timeout(8000)
    info = pg.evaluate("""() => { const se = document.scrollingElement;
        return {cards: document.querySelector('home-assistant')?.shadowRoot ? 'ha' : 'none', scrollH: se.scrollHeight, clientH: se.clientHeight}; }""")
    print("page:", info)
    try:
        pg.get_by_role("button", name="Confirm").click(timeout=3000)
        pg.wait_for_timeout(1500)
    except Exception:
        pass
    pg.mouse.move(760, 400)
    for _ in range(10):
        pg.mouse.wheel(0, 600); pg.wait_for_timeout(100)
    pg.wait_for_timeout(500)
    samples = []
    for i in range(seconds * 2):
        y = pg.evaluate("() => document.scrollingElement.scrollTop")
        samples.append(y)
        pg.wait_for_timeout(500)
    pg.screenshot(path=sys.argv[3] if len(sys.argv) > 3 else "shot.png")
    br.close()
start = samples[0]
jumps = [(i / 2, samples[i - 1], samples[i]) for i in range(1, len(samples)) if samples[i] != samples[i - 1]]
print("start scrollTop:", start, "| jumps:", jumps[:10] or "none")
print("card version:", [m for m in msgs if "DANFOSS" in m][:1])
errs = [m for m in msgs if m.startswith("error")]
print("console errors:", errs[:5] or "none")
