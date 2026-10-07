/* Palette: Ivory (default) or Champagne. Only the accent tokens differ (css/tokens.css).
 *
 * This is a plain, blocking script in <head>, not a module and not inline: the server sends
 * script-src 'self', so an inline script would be blocked. It runs before the stylesheet
 * paints, so there is no flash of the wrong palette.
 *
 * Order: ?palette=ivory|champagne in the URL (also remembered), then localStorage mr.palette,
 * then ivory. Every storage access is wrapped, the page works without it. */
(function () {
  var KEY = 'mr.palette', NAMES = ['ivory', 'champagne'], root = document.documentElement;
  function valid(v) { return NAMES.indexOf(v) >= 0; }
  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private window, blocked storage */ } }

  var fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get('palette'); } catch (e) { /* old browser */ }
  var stored = read();
  var cur = valid(fromUrl) ? fromUrl : valid(stored) ? stored : 'ivory';
  if (valid(fromUrl)) write(fromUrl);
  root.setAttribute('data-palette', cur);

  window.mrPalette = {
    names: NAMES,
    get: function () { return root.getAttribute('data-palette') || 'ivory'; },
    set: function (v) {
      if (!valid(v)) return;
      root.setAttribute('data-palette', v);
      write(v);
      document.dispatchEvent(new CustomEvent('palettechange', { detail: v }));
    },
  };
})();
