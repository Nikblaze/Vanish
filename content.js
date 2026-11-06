// Isolated world: creates the detector iframe lazily (content-script iframes aren't blocked by Teams CSP).
// inject.js (MAIN) asks via window.postMessage({type:'tlfx:need-detector'}).
if (window === top) {
  addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'tlfx:need-detector' || document.getElementById('tlfx-detector')) return;
    const f = document.createElement('iframe');
    f.id = 'tlfx-detector';
    f.src = chrome.runtime.getURL('detector.html');
    f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;border:0';
    (document.body || document.documentElement).appendChild(f);
    console.info('[TLFX] detector iframe created');
  });
}
