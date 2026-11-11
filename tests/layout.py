"""Places the panel on a page laid out like real OnlineTestPad (side ad columns, top banners,
ad row under the question) at laptop, 1080p and 1440p sizes. Checks that the card sits on an ad
and never covers the question or the Далее/Завершить buttons, and saves screenshots
(including one mid-solve, showing the progress bar).   python3 tests/layout.py [shots-dir]"""
import json, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
shots = Path(sys.argv[1]) if len(sys.argv) > 1 else None
tmp = Path(tempfile.mkdtemp(prefix='tpp-layout-')); ext = tmp / 'ext'
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns('.git', 'tests', 'node_modules'))
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', 'API_302_KEY': 'sk-x', 'VAULT_PASSWORD': 'layout-password'}, check=True, capture_output=True)
form = re.search(r'<form id="testform".*?</form>', (ROOT / 'tests/fixtures/onlinetestpad.html').read_text(), re.S).group(0)
tile = lambda t, h: f'<div class="tile" style="height:{h}px"><small>РЕКЛАМА</small><b>{t}</b></div>'
form = form.replace('<div data-r-a-19558548-2', '<div class="row">' + tile('iPhone 18 Pro Max', 300) + tile('Apple iPhone 17', 300) + tile('Эндосферотерапия', 300) + '</div><div data-r-a-19558548-2')
html = f'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
body{{margin:0;background:#eceff1;font:15px Arial,sans-serif}} .wrap{{display:flex;gap:16px;justify-content:center;padding:12px}}
.adleft,.adright{{width:340px;flex:none}} .center{{flex:1;max-width:1240px;min-width:0}}
.tile{{background:linear-gradient(135deg,#d9e4f5,#f6d7e4);border-radius:10px;padding:10px;margin-bottom:12px;box-sizing:border-box;flex:1}}
.tile small{{display:block;color:#888;font-size:10px}} .tile b{{display:block;margin-top:8px}}
.top{{display:flex;gap:12px}} .top .tile{{height:140px}} form{{background:#fff;border:1px solid #ccc;margin-top:4px}}
.otp-item-view-title{{background:#eee;margin:0;padding:14px 26px;font-weight:400;font-size:32px}} .otp-item-view-question{{padding:12px 16px}}
.row{{display:flex;gap:10px}} .otp-ad-content{{padding:0}} label{{padding:10px 20px}}
@media (max-width:1500px){{.adleft,.adright{{display:none}}}}
</style></head><body><div class="wrap"><div class="adleft">{tile("Чехол UNIQ",200)}{tile("Чехол MagSafe",200)}{tile("Зарядная станция",200)}</div>
<div class="center"><div class="top">{tile("Учеба в Нидерландах",140)}{tile("Apple Mac mini M6",140)}</div>{form}</div>
<div class="adright">{tile("NIKE SB",160)}{tile("STUSSY",160)}{tile("FRED PERRY",160)}</div></div></body></html>'''

held = []
def api(route): held.append(route)  # answered later from the main flow, so the page can be seen mid-solve
def answer_held():
    route = held.pop()
    answer = json.dumps({'work': 'ИТ — совокупность методов и средств обработки информации.', 'answer': '2) совокупность методов…', 'values': ['2']}, ensure_ascii=False)
    route.fulfill(status=200, body='data: ' + json.dumps({'choices': [{'delta': {'content': answer}}]}) + '\n\ndata: [DONE]\n\n', headers={'content-type': 'text/event-stream'})

def rect_js(sel): return f"(()=>{{const r=document.querySelector('{sel}').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]}})()"
CARD = "(()=>{const h=[...document.documentElement.children].find(e=>e.tagName==='DIV');if(!h)return null;const r=h.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()"
overlap = lambda a, b: a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(tmp / 'prof'), channel='chromium', headless=True, device_scale_factor=3,
        args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
    ctx.route('https://onlinetestpad.com/**', lambda r: r.fulfill(body=html, content_type='text/html; charset=utf-8'))
    ctx.route('https://api.302.ai/**', api)
    w = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    eid = w.url.split('/')[2]
    pop = ctx.new_page(); pop.goto(f'chrome-extension://{eid}/extension/popup.html')
    pop.fill('#pass', 'layout-password'); pop.click('#go'); pop.wait_for_selector('#ready', state='visible'); pop.close()
    for name, (wd, ht) in {'laptop-1366x768': (1366, 768), 'fullhd-1920x1080': (1920, 1080), 'qhd-2560x1440': (2560, 1440)}.items():
        page = ctx.new_page(); page.set_viewport_size({'width': wd, 'height': ht})
        page.goto('https://onlinetestpad.com/ru/test/layout'); page.wait_for_timeout(600)
        page.evaluate("document.querySelector('#t_ans_6406831').checked=false")
        page.keyboard.press('Control+Shift+9')
        for _ in range(50):
            if held: break
            page.wait_for_timeout(100)
        page.wait_for_timeout(2500)
        assert not page.evaluate("document.querySelector('#t_ans_6406831').checked"), 'still solving'
        if shots:
            page.screenshot(path=str(shots / f'{name}-solving.png'))
            page.screenshot(path=str(shots / f'{name}-solving-zoom.png'), clip={'x': page.evaluate(CARD)[0] - 10, 'y': page.evaluate(CARD)[1] - 10, 'width': 220, 'height': 50}, scale='device')
        answer_held()
        page.wait_for_function("document.querySelector('#t_ans_6406831').checked", timeout=10000); page.wait_for_timeout(400)
        card = page.evaluate(CARD)
        ads = [page.evaluate(rect_js(s)) for s in ['.otp-ad-content'] ]
        q, btns = page.evaluate(rect_js('.qcontainer')), page.evaluate(rect_js('.otp-item-view-buttons'))
        on_ad = any(c[0] >= a[0] and c[1] >= a[1] - 1 and c[0] < a[0] + 20 for a in ads for c in [card])
        visible_ads = page.evaluate("""[...document.querySelectorAll('.otp-ad-content,.adleft,.adright')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.bottom>0&&r.top<innerHeight}).map(e=>e.className)""")
        print(f'{name}: card={[round(x) for x in card]} on-ad-row={on_ad} covers-question={overlap(card, q)} covers-buttons={overlap(card, btns)} ads-on-screen={visible_ads}')
        assert not overlap(card, q) and not overlap(card, btns), name
        if shots: page.screenshot(path=str(shots / f'{name}.png'))
        page.close()
    ctx.close()
shutil.rmtree(tmp, ignore_errors=True)
print('LAYOUT OK')
