from playwright.sync_api import sync_playwright
import time, sys

URL = 'http://localhost:8765/'
OUT = '/tmp/shots/'
import os; os.makedirs(OUT, exist_ok=True)
errors = []

def sq_center(page, sq):
    box = page.locator('#board').bounding_box()
    orient = page.evaluate('window.__game.color')
    f = ord(sq[0]) - 97; r = int(sq[1]) - 1
    if orient == 'black': f = 7 - f; r = 7 - r
    s = box['width'] / 8
    return box['x'] + s * (f + .5), box['y'] + box['height'] - s * (r + .5)

def tap(page, sq):
    x, y = sq_center(page, sq); page.mouse.click(x, y)

def wait_turn(page):
    page.wait_for_function('window.__game.p && !window.__game.busy && window.__game.step % 2 === 1', timeout=15000)

def play_uci(page, uci):
    tap(page, uci[:2]); time.sleep(.15); tap(page, uci[2:4])
    if len(uci) == 5:
        page.wait_for_selector('#promo:not([hidden])')
        idx = 'qnrb'.index(uci[4])
        page.locator('#promo button').nth(idx).click()

def solve(page):
    wait_turn(page)
    while True:
        g = page.evaluate('({step: window.__game.step, moves: window.__game.p.moves, done: window.__game.done})')
        if g['done']: return
        play_uci(page, g['moves'][g['step']])
        page.wait_for_function('window.__game.done || (!window.__game.busy && window.__game.step % 2 === 1)', timeout=10000)

def state(page):
    return page.evaluate("({r: document.getElementById('rating').textContent, streak: document.getElementById('streak').textContent, title: document.getElementById('statusTitle').textContent, badge: document.getElementById('dueBadge').textContent, badgeHidden: document.getElementById('dueBadge').hidden})")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=False, bypass_csp=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(URL)
    wait_turn(page)
    page.screenshot(path=OUT + '1-puzzle.png')
    print('loaded', state(page), page.evaluate('window.__game.p'))

    # solve 3 puzzles
    for i in range(3):
        solve(page)
        print('solved', state(page))
        if i == 0: page.screenshot(path=OUT + '2-solved.png')
        page.click('#nextBtn')
    # fail one: wrong move
    wait_turn(page)
    g = page.evaluate('window.__game.p')
    legal = page.evaluate("(() => { const m = window.__game; const d = [...window.__cgdests || []]; return null })()")
    # pick a legal move that's not the solution using chess.js via game.chess
    wrong = page.evaluate("""(() => { const g = window.__game; const sol = g.p.moves[g.step];
        for (const m of g.chess.moves({verbose:true})) { const u = m.from+m.to+(m.promotion||''); if (u !== sol) { g.chess.move(m); const mate = g.chess.isCheckmate(); g.chess.undo(); if (!mate && !m.promotion) return u; } } return null })()""")
    print('playing wrong', wrong, 'solution', g['moves'][1])
    play_uci(page, wrong)
    time.sleep(.3)
    page.screenshot(path=OUT + '3-wrong.png')
    time.sleep(1)
    print('after wrong', state(page))
    page.click('#solBtn')
    page.wait_for_function('window.__game.done', timeout=15000)
    print('after solution', state(page))
    page.screenshot(path=OUT + '4-solution.png')

    # persistence
    rating_before = state(page)['r']
    page.reload(); wait_turn(page)
    print('after reload', state(page), 'rating kept:', state(page)['r'] == rating_before)

    # theme sheet + rare theme
    page.click('#themeBtn'); time.sleep(.4)
    page.screenshot(path=OUT + '5-themes.png')
    old = page.evaluate('window.__game.p.id')
    page.locator('.tbtn', has_text='Underpromotion').click()
    page.wait_for_function(f"window.__game.p.id !== '{old}'"); wait_turn(page)
    print('rare theme puzzle themes:', page.evaluate('window.__game.p.themes'))
    solve(page)
    print('solved underpromotion', state(page))
    page.click('#themeBtn'); time.sleep(.3)
    old = page.evaluate('window.__game.p.id')
    page.locator('.tbtn', has_text='Fork').click()
    page.wait_for_function(f"window.__game.p.id !== '{old}'"); wait_turn(page)
    print('fork puzzle themes:', page.evaluate('window.__game.p.themes'))
    page.click('#themeBtn'); time.sleep(.3)
    page.locator('.tbtn', has_text='All puzzles').click()
    wait_turn(page)

    # review mode (the failed puzzle is due tomorrow — force due now)
    page.evaluate("""(async () => { })()""")
    page.locator('.tab', has_text='Review').click(); time.sleep(.6)
    page.screenshot(path=OUT + '6-review-empty.png')
    print('review empty msg:', page.locator('#boardMsg').inner_text())

    # stats + settings
    page.locator('.tab', has_text='Stats').click(); time.sleep(.4)
    page.screenshot(path=OUT + '7-stats.png', full_page=True)
    page.locator('.tab', has_text='Settings').click(); time.sleep(.6)
    page.screenshot(path=OUT + '8-settings.png', full_page=True)
    # board color
    page.locator('.swatch').nth(1).click()
    # partial download then pause
    page.click('#dlBtn'); time.sleep(2.5); page.click('#dlBtn'); time.sleep(1.5)
    print('download info:', page.locator('#dlCount').inner_text(), '|', page.locator('#dlInfo').inner_text())
    # offline mode
    page.click('#setOffline', force=True); time.sleep(.3)
    page.locator('.tab', has_text='Puzzles').click(); time.sleep(.3)
    # count network requests in offline mode
    reqs = []
    page.on('request', lambda r: reqs.append(r.url))
    page.click('#solBtn'); page.wait_for_function('window.__game.done', timeout=15000); page.click('#nextBtn'); wait_turn(page)
    print('offline next puzzle ok; requests made:', [u for u in reqs if 'data/' in u])
    page.screenshot(path=OUT + '9-brown-board.png')
    b.close()

print('ERRORS:', errors)
