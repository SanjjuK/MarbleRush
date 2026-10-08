#!/usr/bin/env python3
"""Builds assets/ (favicon, apple-touch icon, Open Graph image) from the design source.

  python3 tools/brand/build-assets.py

Reads design/reference/brand.dc.html (logo symbols, course) and design/tokens.css, resolves every var(--token) to
its value (marble colours come from js/racers.js, the single source of truth), writes assets/*.svg and renders the
PNGs with headless Google Chrome. Chrome is only needed to re-render; the outputs are committed.
"""
import re, subprocess, sys, tempfile, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
brand = (ROOT / 'design/reference/brand.dc.html').read_text()
index = (ROOT / 'index.html').read_text()
tokens = (ROOT / 'design/tokens.css').read_text()
racers = (ROOT / '../js/racers.js').read_text()

vars_ = dict(re.findall(r'--([\w-]+):\s*([^;]+);', tokens.split(':root[data-palette')[0]))
vars_.update(re.findall(r'--(light):\s*([^;]+);', tokens))
for tick, hexv in re.findall(r"ticker: '(\w+)', hex: '(#\w+)'", racers):
    vars_['m-' + tick.lower()] = hexv
vars_['accent'] = '#F4EFE6'
vars_ = {k: v.replace('"', "'") for k, v in vars_.items()}   # font names sit inside style="..." attributes

def flat(s):
    return re.sub(r'var\(--([\w-]+)\)', lambda m: vars_[m.group(1)], s)

def grab(src, pat):
    m = re.search(pat, src, re.S)
    if not m: sys.exit('missing ' + pat)
    return m.group(0)

defs = ''.join(re.findall(r'<(?:radialGradient|linearGradient) id="\w+".*?</(?:radialGradient|linearGradient)>|<clipPath id="cpG">.*?</clipPath>', index, re.S))
defs += ''.join(re.findall(r'<linearGradient id="g[tT][rR]".*?</linearGradient>', brand, re.S))
sym = {k: grab(index, r'<symbol id="%s".*?</symbol>' % k) for k in ('g-d', 'g-cd')}
sym['hyb-d'] = grab(brand, r'<symbol id="hyb-d".*?</symbol>')
# Polish on the design: the glass leader is ~30% larger (26 -> 34) and the two inner marbles move out and up to make room.
for a, b in [('x="15.8" y="17"', 'x="13.8" y="13"'), ('cx="20" cy="30"', 'cx="18" cy="26"'), ('cx="18.5" cy="28.5"', 'cx="16.5" cy="24.5"'),
             ('x="39.8" y="17"', 'x="41.8" y="13"'), ('cx="44" cy="30"', 'cx="46" cy="26"'), ('cx="42.5" cy="28.5"', 'cx="44.5" cy="24.5"'),
             ('x="26" y="22" width="12" height="28"', 'x="26" y="20" width="12" height="30"'), ('x="19" y="37" width="26" height="26"', 'x="15" y="29.5" width="34" height="34"')]:
    assert a in sym['hyb-d'], a
    sym['hyb-d'] = sym['hyb-d'].replace(a, b)
sym['course'] = grab(brand, r'<symbol id="course".*?</symbol>')
defs += ''.join(re.findall(r'<(?:radialGradient|linearGradient) id="\w+".*?</(?:radialGradient|linearGradient)>', sym['hyb-d'] + sym['course'], re.S))
BG = vars_['bg']

def icon_svg(symbol, size, rounded):
    r = f' rx="{size * 0.22:.0f}"' if rounded else ''
    return flat(f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}"><defs>{defs}{sym[symbol]}</defs>'
                f'<rect width="{size}" height="{size}"{r} fill="{BG}"/><use href="#{symbol}" x="{size*.08:.1f}" y="{size*.08:.1f}" width="{size*.84:.1f}" height="{size*.84:.1f}"/></svg>')

(ROOT / 'assets').mkdir(exist_ok=True)
(ROOT / 'assets/favicon.svg').write_text(icon_svg('g-cd', 64, True))
(ROOT / 'assets/icon-180.svg').write_text(icon_svg('g-d', 180, False))     # the page for the PNG; iOS rounds the corners itself

og = flat(f'''<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>:root{{{''.join(f'--{k}:{v};' for k,v in vars_.items())}}}html,body{{margin:0;background:var(--bg)}}</style>
<svg width="0" height="0" style="position:absolute"><defs>{defs}{sym['g-d']}{sym['hyb-d']}{sym['course']}</defs></svg>
<div style="position:relative;width:1200px;height:630px;overflow:hidden;background:var(--bg);font-family:var(--font-ui);color:var(--text-1)">
<div style="position:absolute;inset:0;background:radial-gradient(40% 60% at 78% 60%,var(--celebrate-soft),transparent 70%)"></div>
<svg viewBox="0 0 240 900" preserveAspectRatio="xMidYMin slice" style="position:absolute;right:96px;top:0;width:300px;height:630px"><use href="#course" width="240" height="900"/></svg>
<div style="position:absolute;left:80px;top:72px;bottom:72px;width:680px;display:flex;flex-direction:column;justify-content:space-between">
<div style="display:flex;align-items:center;gap:16px"><svg width="64" height="64"><use href="#hyb-d" width="64" height="64"/></svg><span style="font-family:var(--font-data);font-size:40px;font-weight:600;line-height:1;letter-spacing:-.01em;white-space:nowrap">Marble<span style="font-weight:700;color:var(--celebrate)">Rush</span></span></div>
<div style="display:flex;flex-direction:column;gap:24px"><div style="font-size:88px;font-weight:600;line-height:1.02;letter-spacing:-.02em;text-wrap:balance">Back a marble. Watch it drop.</div>
<div style="font-size:32px;line-height:1.3;color:var(--text-2)">Live marble racing. <span style="color:var(--text-1);font-weight:600">Provably fair on Solana.</span></div></div>
<span style="align-self:flex-start;height:32px;display:flex;align-items:center;padding:0 16px;border:1px solid var(--line-strong);border-radius:999px;font-family:var(--font-data);font-size:16px;font-weight:700;letter-spacing:.14em;color:var(--text-2)">DEVNET PROTOTYPE</span></div></div>''')

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
def shot(html, out, w, h):
    f = pathlib.Path(tempfile.mkdtemp()) / 'p.html'; f.write_text(html)
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--virtual-time-budget=6000',
                    f'--window-size={w},{h}', f'--screenshot={ROOT / out}', f'file://{f}'], check=True, capture_output=True)

page = lambda svg, w, h: f'<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{display:block}}</style>{svg}'
shot(og, 'assets/og.png', 1200, 630)
shot(page((ROOT / 'assets/icon-180.svg').read_text(), 180, 180), 'assets/apple-touch-icon.png', 180, 180)
shot(page(icon_svg('g-cd', 32, True), 32, 32), 'assets/favicon-32.png', 32, 32)
(ROOT / 'assets/icon-180.svg').unlink()
print('ok')
