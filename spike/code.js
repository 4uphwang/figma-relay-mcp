figma.showUI(__html__, { width: 360, height: 260 });
(async () => {
  const r = {};
  try {
    r.newFunction = await new Function('figma', 'return (async () => figma.root.name)()')(figma);
  } catch (e) { r.newFunction = 'ERR ' + e; }
  try { r.eval = (0, eval)('1 + 1'); } catch (e) { r.eval = 'ERR ' + e; }
  try {
    const f = figma.createFrame();
    f.resize(200, 100);
    f.name = 'spike';
    const bytes = await f.exportAsync({ format: 'PDF' });
    r.pdfBytes = bytes.length;
    r.pdfHead = String.fromCharCode(...bytes.slice(0, 5));
    f.remove();
  } catch (e) { r.pdf = 'ERR ' + e; }
  figma.ui.postMessage({ type: 'results', r });
})();
