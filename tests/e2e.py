"""Loads the real extension in Chromium against the OnlineTestPad fixture.
302.ai is stubbed; no key or network needed.   python3 tests/e2e.py"""
import json, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PASSWORD = 'e2e-password-long'
POLZA_PASSWORD = 'e2e-polza-password'
NAMED_PASSWORD = 'e2e-named-password'
RACE_PASSWORD = 'e2e-race-password'
tmp = Path(tempfile.mkdtemp(prefix='tpp-e2e-'))
ext = tmp / 'ext'
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns('.git', 'tests', 'node_modules'))
(ext / 'extension/vault.json').unlink(missing_ok=True)  # start from an empty vault, not the real one
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', 'API_302_KEY': 'sk-e2e', 'VAULT_PASSWORD': PASSWORD},
               check=True, capture_output=True)
seal_env = {'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', 'API_KEY': 'pz-e2e'}
same = subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--provider', 'polza', '--no-check', '--out', str(ext / 'extension/vault.json')],
                      env={**seal_env, 'VAULT_PASSWORD': PASSWORD}, capture_output=True, text=True)
assert same.returncode == 1 and 'уже открывает' in same.stderr, 'seal refuses a password that opens the other key'
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--provider', 'polza', '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={**seal_env, 'VAULT_PASSWORD': POLZA_PASSWORD}, check=True, capture_output=True)
assert [e['provider'] for e in json.loads((ext / 'extension/vault.json').read_text())] == ['302', 'polza']
# A named account is a third entry; the browser below unlocks Polza.ai through it.
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--provider', 'polza', '--name', 'E2E', '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={**seal_env, 'API_KEY': 'pz-named', 'VAULT_PASSWORD': NAMED_PASSWORD}, check=True, capture_output=True)
listed = subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--list', '--out', str(ext / 'extension/vault.json')],
                        capture_output=True, text=True, check=True).stdout
assert '(без имени) — Polza.ai' in listed and 'E2E — Polza.ai' in listed and 'хранилище: 3' in listed, listed
# An account with two keys: 302.ai, and Polza.ai added with --race. Every solve goes to both.
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--name', 'Race', '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={**seal_env, 'API_KEY': 'sk-race', 'VAULT_PASSWORD': RACE_PASSWORD}, check=True, capture_output=True)
subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--race', 'polza', '--no-check', '--out', str(ext / 'extension/vault.json')],
               env={**seal_env, 'RACE_KEY': 'pz-race', 'VAULT_PASSWORD': RACE_PASSWORD}, check=True, capture_output=True)
listed = subprocess.run(['node', str(ROOT / 'tools/seal.mjs'), '--list', '--out', str(ext / 'extension/vault.json')],
                        capture_output=True, text=True, check=True).stdout
assert 'Race — 302.ai + Polza.ai (гонка)' in listed and '(без имени) — 302.ai\n' in listed, listed
# Its own settings, like the real main account: GPT-6.2 Sol at medium on both providers.
SOL = {'302': {'model': 'gpt-6.2-sol', 'effort': 'medium'}, 'polza': {'model': 'openai/gpt-6.2-sol', 'effort': 'medium'}}
vault = json.loads((ext / 'extension/vault.json').read_text())
for e in vault:
    if e.get('name') == 'Race': e['prefs'] = SOL
(ext / 'extension/vault.json').write_text(json.dumps(vault, indent=2))
# Secrets typed into the seal tool never reach the screen: not when pasted, and not when the line is
# edited (Backspace used to redraw prompt + line, key included).
import os, pty, select
def typed_secrets_shown(answers):
    out = tmp / 'pty-vault.json'
    pid, fd = pty.fork()
    if pid == 0: os.execvp('node', ['node', str(ROOT / 'tools/seal.mjs'), '--no-check', '--out', str(out)])
    seen = b''
    def drain(t):
        nonlocal seen
        end = time.time() + t
        while time.time() < end:
            if select.select([fd], [], [], 0.05)[0]:
                try: seen += os.read(fd, 4096)
                except OSError: return
    for a in answers:
        drain(0.8); os.write(fd, (a + 'x').encode()); time.sleep(0.1); os.write(fd, b'\x7f\r')  # paste, typo, Backspace
    drain(4); os.waitpid(pid, 0)
    assert out.exists(), seen
    return [a for a in answers if a.encode() in seen]
assert typed_secrets_shown(['sk-pasted-secret-1', 'pasted password 12', 'pasted password 12']) == [], 'seal tool echoes secrets'
print('seal prompt hides typed and pasted secrets: ok')
html = (ROOT / 'tests/fixtures/onlinetestpad.html').read_text()
requests, mode = [], {'v': 'ok', 'api.302ai.cn': 'ok', 'api.302.ai': 'ok', 'api.polza.ai': 'ok'}
# Race tests: a host listed in lag answers after that many seconds, with its own values. Handlers run on
# this thread, so a sleep would hold the other host too: replies wait in `held` and pump() sends them.
lag, reply_values, held = {}, {}, []
GATEWAY_401 = '{"error":{"err_code":-10001,"message":"Missing 302 Apikey"}}'
LANDING = '<html>' + 'x' * 24000 + '</html>'

def api(route):
    """Both 302.ai hosts. Per host: ok | down (connection reset) | throttled (hangs, like a Russian ISP
    freezing a big transfer) | nokey (the host doesn't know the key)."""
    req = route.request
    host = req.url.split('/')[2]
    state = mode[host]
    if state == 'throttled': return  # never answered
    if state == 'down': return route.abort('connectionreset')
    auth = req.headers.get('authorization')
    if not auth:  # the route probe: landing page down, junk body up, no key sent
        if req.method == 'GET': return route.fulfill(body=LANDING, content_type='text/html')
        assert len(req.post_data_buffer) > 90000, 'probe uploads a real-sized body'
        return route.fulfill(status=401, body=GATEWAY_401, content_type='application/json')
    body = json.loads(req.post_data)
    requests.append({'auth': auth, 'body': body, 'host': host})
    if mode['v'] == 'unauthorized' or state == 'nokey':
        return route.fulfill(status=401, body='{"error":{"message":"invalid key"}}', content_type='application/json')
    if mode['v'] == 'param' and 'reasoning_effort' in body:
        return route.fulfill(status=400, body='{"error":{"err_code":-10003,"message":"Parameter error"}}', content_type='application/json')
    who = 'polza' if host == 'api.polza.ai' else '302'
    answer = json.dumps({'work': f'ИТ — методы и средства обработки информации ({who}).', 'answer': 'совокупность методов…',
                         'values': reply_values.get(host, ['2'])}, ensure_ascii=False)
    chunks = [answer[i:i + 20] for i in range(0, len(answer), 20)]
    sse = ''.join('data: ' + json.dumps({'choices': [{'delta': {'content': c}}]}) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
    if host in lag: return held.append((time.time() + lag[host], route, sse))
    time.sleep(1.2)
    route.fulfill(status=200, body=sse, headers={'content-type': 'text/event-stream'})

def pump():
    for item in [h for h in held if h[0] <= time.time()]:
        held.remove(item)
        try: item[1].fulfill(status=200, body=item[2], headers={'content-type': 'text/event-stream'})
        except Exception: pass  # the request was cancelled meanwhile

def launch(p, profile):
    ctx = p.chromium.launch_persistent_context(str(profile), channel='chromium', headless=True,
        args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
    ctx.route('https://onlinetestpad.com/**', lambda r: r.fulfill(body=html, content_type='text/html; charset=utf-8'))
    ctx.route('https://api.302.ai/**', api)
    ctx.route('https://api.302ai.cn/**', api)
    ctx.route('https://api.polza.ai/**', api)
    worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
    return ctx, worker.url.split('/')[2]

def panel(page):
    """Text of the closed-shadow panel, or None when it is not in the DOM (reads via CDP like DevTools)."""
    cdp = page.context.new_cdp_session(page)
    root = cdp.send('DOM.getDocument', {'pierce': True, 'depth': -1})['root']
    found = []
    def walk(n, inside=False):
        if n.get('shadowRootType') == 'closed': inside = True
        if inside and n.get('nodeType') == 3: found.append(n['nodeValue'])
        for c in n.get('children', []) + n.get('shadowRoots', []): walk(c, inside)
    walk(root)
    cdp.detach()
    text = ' '.join(t for t in found if not t.lstrip().startswith(':host'))
    return text if found else None

def click_in_panel(page, cls):
    cdp = page.context.new_cdp_session(page)
    root = cdp.send('DOM.getDocument', {'pierce': True, 'depth': -1})['root']
    def walk(n):
        attrs = n.get('attributes', [])
        if 'class' in attrs and cls in attrs[attrs.index('class') + 1].split(): return n['nodeId']
        for c in n.get('children', []) + n.get('shadowRoots', []):
            x = walk(c)
            if x: return x
    q = cdp.send('DOM.getBoxModel', {'nodeId': walk(root)})['model']['border']
    cdp.detach()
    page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2)

def node(page, cls):
    """(class attribute, border box) of the closed-shadow element with this class."""
    cdp = page.context.new_cdp_session(page)
    root = cdp.send('DOM.getDocument', {'pierce': True, 'depth': -1})['root']
    def walk(n):
        attrs = n.get('attributes', [])
        if 'class' in attrs and cls in attrs[attrs.index('class') + 1].split(): return n
        for c in n.get('children', []) + n.get('shadowRoots', []):
            x = walk(c)
            if x: return x
    n = walk(root)
    box = cdp.send('DOM.getBoxModel', {'nodeId': n['nodeId']})['model']['border']
    cdp.detach()
    return n['attributes'][n['attributes'].index('class') + 1], [round(v) for v in box]

def done(page):
    try: return 'dot' in node(page, 'eye')[0]
    except Exception: return False

def open_answer(page):
    """Answers arrive folded with a dot on the eye; one click opens them. Returns the panel text."""
    wait(lambda: done(page), 'dot on the eye')
    assert 'Ответ' not in panel(page), 'answer must not pop open by itself'
    click_in_panel(page, 'eye')
    time.sleep(0.15)
    return panel(page)

def wait(cond, what, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        pump()
        if cond(): return
        time.sleep(0.1)
    raise AssertionError('timed out: ' + what)

with sync_playwright() as p:
    profile = tmp / 'profile'
    ctx, ext_id = launch(p, profile)
    popup = ctx.new_page(); popup.goto(f'chrome-extension://{ext_id}/extension/popup.html')
    popup.fill('#pass', 'wrong-password-xx'); popup.click('#go')
    wait(lambda: 'Неверный' in popup.text_content('#msg'), 'wrong password message')
    popup.fill('#pass', PASSWORD); popup.click('#go')
    wait(lambda: popup.is_visible('#ready'), 'unlocked view')
    assert 'Ctrl' in popup.text_content('#k-solve') or 'Control' in popup.text_content('#k-solve') or '⌃' in popup.text_content('#k-solve'), popup.text_content('#k-solve')
    if len(sys.argv) > 1:
        popup.set_viewport_size({'width': 280, 'height': 260}); popup.screenshot(path=sys.argv[1] + '/popup.png')
    popup.close()  # closing the auth window must not matter

    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('https://onlinetestpad.com/ru/test/qa')
    wait(lambda: panel(page) is not None and '?' in panel(page) and 'Решить' not in panel(page), 'panel visible with ? button')
    click_in_panel(page, 'go')  # the '?' button
    wait(lambda: page.is_checked('#t_ans_6406831'), 'correct radio checked')
    assert 'Ответ: совокупность' in open_answer(page), 'answer shown after clicking the eye'
    req = requests[-1]
    assert req['auth'] == 'Bearer sk-e2e', req['auth']
    assert req['body']['model'] == 'gemini-3.8-flash' and req['body']['reasoning_effort'] == 'high'
    user = req['body']['messages'][1]['content']
    assert 'Информационные технологии' in user[0]['text'] and 'Реклама' not in user[0]['text'] and 'Рекламный' not in user[0]['text']
    assert user[1]['image_url']['url'].startswith('data:image/jpeg;base64,/9j/'), 'formula attached'
    assert not page.is_checked('#ad-check') and not page.is_checked('#ad-radio')
    print('solve + fill: ok')

    # Sits on top of the ad block; the eye folds the answer away and back.
    page.set_viewport_size({'width': 1100, 'height': 760})
    page.add_style_tag(content='.otp-ad-content{height:260px;background:#e9eef5}')
    def inside_ad():
        return page.evaluate("""() => { const h=[...document.documentElement.children].find(e=>e.tagName==='DIV'), a=document.querySelector('.otp-ad-content').getBoundingClientRect(), r=h.getBoundingClientRect();
          return r.left>=a.left && r.top>=a.top-1 && r.left<a.left+20 && r.top<a.top+20; }""")
    wait(inside_ad, 'panel placed on the ad')
    click_in_panel(page, 'eye')
    wait(lambda: 'Ответ' not in (panel(page) or 'Ответ') and '?' in panel(page), 'eye folds the answer')
    page.reload(); wait(lambda: panel(page) is not None, 'panel after reload')
    page.add_style_tag(content='.otp-ad-content{height:260px;background:#e9eef5}')
    wait(inside_ad, 'panel placed on the ad after reload')
    page.keyboard.press('Control+Shift+9')
    wait(lambda: page.is_checked('#t_ans_6406831'), 'fills while folded')
    wait(lambda: done(page), 'green dot')
    if len(sys.argv) > 1: page.screenshot(path=sys.argv[1] + '/folded.png')
    eye_before, go_before = node(page, 'eye')[1], node(page, 'go')[1]
    assert 'Ответ: совокупность' in open_answer(page)
    if len(sys.argv) > 1: page.screenshot(path=sys.argv[1] + '/open.png')
    assert node(page, 'eye')[1] == eye_before and node(page, 'go')[1] == go_before, 'eye and ? must not move when the answer opens'
    click_in_panel(page, 'eye'); time.sleep(0.15)
    assert node(page, 'eye')[1] == eye_before, 'nor when it folds'
    print('ad placement + eye (folded by default, buttons stay put): ok')

    page.keyboard.press('Control+Shift+8')
    wait(lambda: panel(page) is None, 'panel gone after hide')
    other = ctx.new_page(); other.goto('https://onlinetestpad.com/ru/test/qa2')
    time.sleep(0.6); assert panel(other) is None, 'hidden state shared with new tabs'
    other.close()
    # Stealth solve while hidden: fills the answer, shows nothing.
    page.evaluate("document.querySelector('#t_ans_6406831').checked = false")
    n = len(requests)
    page.keyboard.press('Control+Shift+9')
    wait(lambda: page.is_checked('#t_ans_6406831'), 'hidden solve fills')
    assert len(requests) == n + 1 and panel(page) is None
    page.keyboard.press('Control+Shift+8')
    wait(lambda: panel(page) is not None, 'shown again')
    assert 'Ответ: совокупность' in open_answer(page), 'result survives hide/show'
    print('hide/show + stealth solve: ok')

    # A picture that never loads must not freeze the solve (it used to wait forever).
    ctx.route('https://onlinetestpad.com/never.png', lambda r: None)  # never answered
    page.evaluate("""document.querySelector('.qtext').insertAdjacentHTML('beforeend', '<img src="https://onlinetestpad.com/never.png" width="200" height="100" style="display:block">')""")
    page.evaluate("document.querySelector('#t_ans_6406831').checked = false")
    t0 = time.time(); page.keyboard.press('Control+Shift+9')
    wait(lambda: page.is_checked('#t_ans_6406831'), 'solves despite a stuck picture', timeout=12)
    assert 'рисунков: 1' in open_answer(page), 'reports the unreadable picture'
    print(f'stuck picture: ok ({time.time() - t0:.1f}s)')

    mode['v'] = 'param'
    page.evaluate("document.querySelector('.qtext').textContent = 'Второй вопрос'")
    wait(lambda: 'Ответ' not in (panel(page) or 'x'), 'panel clears for a new question')
    page.keyboard.press('Control+Shift+9')
    assert 'Ответ: совокупность' in open_answer(page), 'param-error retry'
    assert 'reasoning_effort' not in requests[-1]['body'] and 'reasoning_effort' in requests[-2]['body']
    mode['v'] = 'unauthorized'
    page.evaluate("document.querySelector('.qtext').textContent = 'Третий вопрос'")
    time.sleep(0.3); page.keyboard.press('Control+Shift+9')
    wait(lambda: 'err' in node(page, 'eye')[0], 'red dot on error')
    assert 'Ключ 302.ai не принят' in open_answer(page), 'auth error shown'
    print('errors: ok')

    # Picking the 302.ai address. sw() is the extension's service worker.
    sw = lambda: ctx.service_workers[-1]
    def set_route(host): sw().evaluate(f"chrome.storage.session.set({{route: {{host: {json.dumps(host)}, ms: 1, at: Date.now()}}}})")
    def clear_route(): sw().evaluate("chrome.storage.session.remove('route')")
    def stored_route(): return sw().evaluate("chrome.storage.session.get('route').then(r => r.route?.host ?? null)")
    qn = [0]
    def solve_new(expect='Ответ: совокупность'):
        qn[0] += 1; n = len(requests)
        page.evaluate(f"document.querySelector('.qtext').textContent = 'Маршрут {qn[0]}'")
        wait(lambda: 'Ответ' not in (panel(page) or 'x') and 'err' not in node(page, 'eye')[0], 'panel clears')
        page.keyboard.press('Control+Shift+9')
        wait(lambda: 'dot' in node(page, 'eye')[0], 'solve finished', timeout=20)
        assert expect in open_answer(page), (expect, panel(page))
        return [r['host'] for r in requests[n:]]
    def both(cn, main): mode['api.302ai.cn'], mode['api.302.ai'] = cn, main
    mode['v'] = 'ok'

    # Russia without VPN: api.302.ai freezes big transfers -> the probe picks the mirror, nothing waits on Azure.
    both('ok', 'throttled'); clear_route()
    t0 = time.time()
    assert solve_new() == ['api.302ai.cn'], requests[-3:]
    assert time.time() - t0 < 8, f'took {time.time() - t0:.1f}s'
    assert stored_route() == 'https://api.302ai.cn'
    # On VPN with the mirror unreachable -> the probe picks api.302.ai, no request wasted on the mirror.
    both('down', 'ok'); clear_route()
    assert solve_new() == ['api.302.ai']
    assert stored_route() == 'https://api.302.ai'
    # Stale choice: the remembered host now resets -> same solve falls back, and the choice is updated.
    both('down', 'ok'); set_route('https://api.302ai.cn')
    assert solve_new() == ['api.302.ai']
    assert stored_route() == 'https://api.302.ai'
    # The mirror doesn't know the key -> api.302.ai answers, and is used first from then on.
    both('nokey', 'ok'); set_route('https://api.302ai.cn')
    assert solve_new() == ['api.302ai.cn', 'api.302.ai']
    assert stored_route() == 'https://api.302.ai'
    assert solve_new() == ['api.302.ai']
    # Nothing reachable -> a clear error, and nothing cached.
    both('down', 'down'); clear_route()
    solve_new(expect='Нет связи с 302.ai (оба адреса)')
    assert stored_route() is None
    # Popup shows the chosen server; "проверить" re-probes.
    both('ok', 'throttled'); clear_route()
    pop = ctx.new_page(); pop.goto(f'chrome-extension://{ext_id}/extension/popup.html')
    wait(lambda: 'api.302ai.cn' in pop.text_content('#route'), 'popup shows the mirror', timeout=15)
    both('down', 'ok'); pop.click('summary'); pop.click('#reroute')
    wait(lambda: pop.text_content('#route').startswith('api.302.ai'), 'popup re-probes', timeout=15)
    print('popup server line:', pop.text_content('#route'))
    pop.close()
    both('ok', 'ok')
    print('host routing: ok')
    assert not errors, errors
    ctx.close()

    # Browser restart: the unlock must survive.
    ctx, ext_id = launch(p, profile)
    mode['v'] = 'ok'
    page = ctx.new_page(); page.goto('https://onlinetestpad.com/ru/test/qa')
    wait(lambda: panel(page) is not None, 'panel visible after restart')
    page.keyboard.press('Control+Shift+9')
    wait(lambda: page.is_checked('#t_ans_6406831'), 'still unlocked after restart')
    popup = ctx.new_page(); popup.goto(f'chrome-extension://{ext_id}/extension/popup.html')
    wait(lambda: popup.is_visible('#ready'), 'popup shows unlocked')
    popup.click('summary'); popup.click('#lock')
    wait(lambda: popup.is_visible('#unlock'), 'locked again')
    page.evaluate("document.querySelector('.qtext').textContent = 'После выхода'")
    time.sleep(0.3); page.keyboard.press('Control+Shift+9')
    assert 'заблокировано' in open_answer(page).lower(), 'locked message'
    print('restart persistence + sign-out: ok')

    # A named account's password opens its Polza.ai key: same panel, requests go to Polza.ai only.
    popup.fill('#pass', NAMED_PASSWORD); popup.click('#go')
    wait(lambda: popup.is_visible('#ready'), 'unlocked with the Polza.ai password')
    wait(lambda: popup.text_content('#route').startswith('api.polza.ai'), 'popup shows Polza.ai')
    assert popup.text_content('#model-label') == 'Модель Polza.ai' and popup.get_attribute('#model', 'placeholder') == 'google/gemini-3.8-flash'
    n = len(requests)
    page.evaluate("document.querySelector('.qtext').textContent = 'Через Polza'")
    time.sleep(0.3); page.keyboard.press('Control+Shift+9')
    assert 'Ответ: совокупность' in open_answer(page), 'Polza.ai solve'
    assert [r['host'] for r in requests[n:]] == ['api.polza.ai'], requests[n:]
    assert requests[-1]['auth'] == 'Bearer pz-named' and requests[-1]['body']['model'] == 'google/gemini-3.8-flash'
    mode['v'] = 'unauthorized'
    page.evaluate("document.querySelector('.qtext').textContent = 'Через Polza 2'")
    time.sleep(0.3); page.keyboard.press('Control+Shift+9')
    assert 'Ключ Polza.ai не принят' in open_answer(page), 'Polza.ai auth error named'
    mode['v'] = 'ok'
    popup.click('#lock')  # «Дополнительно» is still open from the sign-out above
    wait(lambda: popup.is_visible('#unlock'), 'locked again')
    print('second password -> Polza.ai: ok')

    # Two providers on one account: both get every question, the first answer is filled in and shown,
    # the other lights up in a small switch with ✓ (same fill values) or ✗ (different).
    # This computer had its own choices; the account's settings replace them when it is unlocked.
    ctx.service_workers[-1].evaluate("chrome.storage.local.set({model: 'gemini-3.8-flash', effort: 'high'})")
    popup.fill('#pass', RACE_PASSWORD); popup.click('#go')
    wait(lambda: popup.is_visible('#ready'), 'unlocked the two-key account')
    wait(lambda: popup.input_value('#effort') == 'medium', 'account depth shown')
    assert popup.input_value('#model') == '' and popup.get_attribute('#model', 'placeholder') == 'gpt-6.2-sol'
    assert 'Polza.ai: openai/gpt-6.2-sol' in popup.text_content('#race-help'), popup.text_content('#race-help')
    wait(lambda: popup.text_content('#route').endswith('+ api.polza.ai'), 'popup shows both servers', timeout=15)
    assert popup.is_visible('#race-row') and popup.is_checked('#race'), 'race switch shown and on'
    assert popup.text_content('#race-label') == 'Сразу два: 302.ai и Polza.ai', popup.text_content('#race-label')
    print('popup server line:', popup.text_content('#route'))
    radio = lambda n: page.is_checked(['#t_ans_6406832', '#t_ans_6406831', '#t_ans_6406830'][n - 1])
    cls = lambda c: node(page, c)[0].split()
    def race_solve(text, lags, values):
        lag.clear(); lag.update(lags); reply_values.clear(); reply_values.update(values)
        page.evaluate("document.querySelectorAll('input[type=radio]').forEach(r => r.checked = false)")
        page.evaluate(f"document.querySelector('.qtext').textContent = {json.dumps(text)}")
        time.sleep(0.3); n = len(requests)
        page.keyboard.press('Control+Shift+9')
        wait(lambda: done(page), 'first answer', timeout=15)
        return n

    # Polza.ai answers first; 302.ai agrees later (other words, same fill values) -> ✓.
    n = race_solve('Гонка 1', {'api.302ai.cn': 3, 'api.302.ai': 3, 'api.polza.ai': 0.3}, {})
    assert radio(2), 'first answer filled in'
    text = open_answer(page)
    assert 'Polza.ai' in text and '302.ai' in text and '(polza)' in text and '(302)' not in text, text
    assert 'wait' in cls('t1') and 'on' in cls('t0'), 'second tab faded while it thinks'
    wait(lambda: '✓' in panel(page), 'second answer lights up with a tick', timeout=10)
    assert 'Ответ' in panel(page), 'the open answer stays open when the second one arrives'
    assert 'lit' in cls('t1') and 'wait' not in cls('t1')
    if len(sys.argv) > 1: page.screenshot(path=sys.argv[1] + '/race-match.png')
    hits = requests[n:]
    assert sorted(r['host'] for r in hits) in (['api.302ai.cn', 'api.polza.ai'], ['api.302.ai', 'api.polza.ai']), hits
    pz = next(r for r in hits if r['host'] == 'api.polza.ai'); m3 = next(r for r in hits if r['host'] != 'api.polza.ai')
    assert pz['auth'] == 'Bearer pz-race' and pz['body']['model'] == 'openai/gpt-6.2-sol' and pz['body']['reasoning_effort'] == 'medium', pz['body']['model']
    assert m3['auth'] == 'Bearer sk-race' and m3['body']['model'] == 'gpt-6.2-sol' and m3['body']['reasoning_effort'] == 'medium', m3['body']['model']
    assert pz['body']['messages'] == m3['body']['messages'], 'both get the same question'
    click_in_panel(page, 't1'); time.sleep(0.15)
    text = panel(page)
    assert '(302)' in text and '(polza)' not in text and 'для сверки' in text and 'on' in cls('t1'), text
    click_in_panel(page, 'eye'); click_in_panel(page, 'eye'); time.sleep(0.15)
    assert '(polza)' in panel(page), 'opening the eye again starts on the first answer'
    click_in_panel(page, 'eye')
    print('race, Polza.ai first, answers agree: ok')

    # 302.ai first; Polza.ai picks another option -> ✗. Arrives while folded: lights up when opened.
    race_solve('Гонка 2', {'api.302ai.cn': 0.3, 'api.302.ai': 0.3, 'api.polza.ai': 2}, {'api.polza.ai': ['3']})
    assert radio(2) and not radio(3), 'the first answer is the one filled in'
    wait(lambda: not held, 'second reply sent', timeout=10)
    time.sleep(0.5)
    assert 'Ответ' not in panel(page), 'still folded'
    text = open_answer(page)
    assert '302.ai' in text and '✗' in text and '(302)' in text, text
    assert 'lit' in cls('t1'), 'lights up the first time it is seen'
    if len(sys.argv) > 1: page.screenshot(path=sys.argv[1] + '/race-differ.png')
    assert radio(2) and not radio(3), 'the second answer is not filled in'
    click_in_panel(page, 'eye')
    print('race, 302.ai first, answers differ: ok')

    # Polza.ai rejects its key: 302.ai's answer still comes, the switch shows "!" and the error.
    mode['api.polza.ai'] = 'nokey'
    race_solve('Гонка 3', {}, {})
    assert radio(2)
    text = open_answer(page)
    wait(lambda: '!' in panel(page), 'failed second provider marked', timeout=10)
    click_in_panel(page, 't1'); time.sleep(0.15)
    assert 'Ключ Polza.ai не принят' in panel(page), panel(page)
    click_in_panel(page, 'eye')
    # Both fail: one error naming each provider.
    mode['v'] = 'unauthorized'
    race_solve('Гонка 4', {}, {})
    wait(lambda: 'err' in cls('eye'), 'red dot')
    text = open_answer(page)
    assert '302.ai: Ключ 302.ai не принят' in text and 'Polza.ai: Ключ Polza.ai не принят' in text, text
    click_in_panel(page, 'eye')
    mode['v'] = 'ok'; mode['api.polza.ai'] = 'ok'
    print('race errors: ok')

    # Turned off in the popup: one provider again, no switch.
    if not popup.is_visible('#race'): popup.click('summary')  # «Дополнительно» may still be open
    popup.uncheck('#race')
    wait(lambda: not popup.text_content('#route').endswith('api.polza.ai'), 'popup drops the second server', timeout=15)
    n = race_solve('Гонка выкл', {}, {})
    assert 'Ответ' in open_answer(page) and 'Polza.ai' not in panel(page)
    assert [r['host'] for r in requests[n:]] in (['api.302ai.cn'], ['api.302.ai']), requests[n:]
    popup.check('#race'); popup.click('#lock')
    wait(lambda: popup.is_visible('#unlock'), 'locked again')
    lag.clear(); reply_values.clear()
    print('race switch in the popup: ok')

    # Updates: the popup reports a newer GitHub version, and new files on disk make the extension reload itself.
    # (Here the extension is loaded from the command line, which Chromium disables on reload; a "Load unpacked"
    #  install reloads from disk. So this checks that the reload is triggered, not what happens after.)
    ctx.route('https://raw.githubusercontent.com/**', lambda r: r.fulfill(body='{"version":"2.99.0"}', content_type='application/json'))
    popup = ctx.new_page(); popup.goto(f'chrome-extension://{ext_id}/extension/popup.html')
    wait(lambda: 'Есть версия 2.99.0' in popup.text_content('#ver'), 'newer version notice')
    popup.close()
    worker = ctx.service_workers[0]
    manifest = json.loads((ext / 'manifest.json').read_text()); manifest['version'] = '9.9.9'
    (ext / 'manifest.json').write_text(json.dumps(manifest))
    with worker.expect_event('close', timeout=15000):
        popup = ctx.new_page()
        try: popup.goto(f'chrome-extension://{ext_id}/extension/popup.html', timeout=4000)
        except Exception: pass
    print('update notice + self-reload trigger: ok')
    ctx.close()
shutil.rmtree(tmp, ignore_errors=True)
print('E2E PASSED')
