const toolbar = document.querySelector('.toolbar');
const textToolbar = document.querySelector('.text-toolbar');
const drawingToolbar = document.querySelector('.drawing-toolbar');
const isDrawMode = () => document.body.classList.contains('drawing');

// Put a saved text selection back
function setSelection(range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

// --- Toolbar ---
// ↗️ tucks the toolbar into the corner, ↙️ opens it again. Remembered per browser.
const toolbarToggle = document.getElementById('toolbarToggle');
function setToolbarMinimized(min) {
    toolbar.classList.toggle('minimized', min);
    toolbarToggle.textContent = min ? '↙️' : '↗️';
    toolbarToggle.title = min ? 'Show toolbar' : 'Minimize toolbar';
    toolbarToggle.setAttribute('aria-expanded', String(!min));
    try { localStorage.setItem('faxToolbarMinimized', min ? '1' : '0'); } catch { /* storage blocked */ }
}
toolbarToggle.addEventListener('click', () => setToolbarMinimized(!toolbar.classList.contains('minimized')));
try { if (localStorage.getItem('faxToolbarMinimized') === '1') setToolbarMinimized(true); } catch { /* storage blocked */ }

// Type ⌨️ / draw ✏️ mode
document.querySelector('.input-mode').addEventListener('change', (e) => {
    const draw = e.target.value === 'draw';
    document.body.classList.toggle('drawing', draw);
    drawingToolbar.classList.toggle('hidden', !draw);
    textToolbar.classList.toggle('hidden', draw);
    if (draw) {
        document.activeElement?.blur();
        resizeCanvas();
    }
});

// Show/hide the To/From/Subject block and "Message:" label
document.getElementById('showFields').addEventListener('change', (e) => {
    document.querySelector('.header-fields').classList.toggle('hidden', !e.target.checked);
});

// --- Text formatting ---
const formatButtons = textToolbar.querySelectorAll('[data-cmd]');
const fontSelect = document.getElementById('fontSelect');
const sizeSelect = document.getElementById('sizeSelect');
const normalizeFont = (f) => f.toLowerCase().replace(/["'\s]/g, '');
const elementOf = (node) => (node.nodeType === 1 ? node : node.parentElement);
// The dropdowns take focus, so remember where the text cursor was
let savedRange = null;
let savedEditable = null;

function updateFormatState() {
    const sel = window.getSelection();
    const editable = sel.rangeCount && sel.anchorNode && elementOf(sel.anchorNode)?.closest('[contenteditable="true"]');
    if (!editable) return;
    savedRange = sel.getRangeAt(0).cloneRange();
    savedEditable = editable;
    formatButtons.forEach((btn) => {
        if (btn.dataset.cmd !== 'removeFormat') {
            btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd));
        }
    });
    const font = normalizeFont(document.queryCommandValue('fontName'));
    const match = [...fontSelect.options].find((o) => normalizeFont(o.value) === font);
    fontSelect.value = (match || fontSelect.options[1]).value; // default: sans-serif
    // Size at the cursor in points (blank if it isn't one of the listed sizes)
    const px = parseFloat(getComputedStyle(elementOf(savedRange.startContainer)).fontSize);
    sizeSelect.value = String(Math.round(px * 0.75 * 10) / 10);
}
document.addEventListener('selectionchange', updateFormatState);

// Return focus and the selection to the text before applying a dropdown choice
function restoreTextSelection() {
    if (!savedRange) return false;
    savedEditable.focus();
    setSelection(savedRange);
    return true;
}

formatButtons.forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    btn.addEventListener('click', () => {
        document.execCommand(btn.dataset.cmd);
        if (btn.dataset.cmd === 'removeFormat') {
            // removeFormat leaves underline/strikethrough alone in some browsers
            ['bold', 'italic', 'underline', 'strikeThrough'].forEach((c) => {
                if (document.queryCommandState(c)) document.execCommand(c);
            });
        }
        updateFormatState();
    });
});

fontSelect.addEventListener('change', () => {
    if (!restoreTextSelection()) return;
    document.execCommand('styleWithCSS', false, true); // <span style="font-family"> instead of <font>
    document.execCommand('fontName', false, fontSelect.value);
    document.execCommand('styleWithCSS', false, false);
    updateFormatState();
});

sizeSelect.addEventListener('change', () => {
    if (!restoreTextSelection()) return;
    const sizedSpan = () => {
        const span = document.createElement('span');
        span.style.fontSize = `${sizeSelect.value}pt`;
        return span;
    };

    if (savedRange.collapsed) {
        // Nothing selected: start a sized span at the cursor for the next typed text.
        // A zero-width space keeps the caret inside it.
        const span = sizedSpan();
        span.textContent = '​';
        savedRange.insertNode(span);
        const r = document.createRange();
        r.setStart(span.firstChild, 1);
        setSelection(r);
    } else {
        // execCommand only knows the 7 legacy HTML sizes, so mark the selection with
        // size 7 and then swap those <font> tags for spans with the real point size.
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontSize', false, '7');
        const spans = [...savedEditable.querySelectorAll('font[size="7"]')].map((font) => {
            const span = sizedSpan();
            span.append(...font.childNodes);
            // Drop older sizes inside, or they would override the new one
            span.querySelectorAll('[style*="font-size"]').forEach((c) => c.style.removeProperty('font-size'));
            span.querySelectorAll('font[size]').forEach((c) => c.removeAttribute('size'));
            font.replaceWith(span);
            return span;
        });
        if (spans.length) {
            const r = document.createRange();
            r.setStartBefore(spans[0]);
            r.setEndAfter(spans[spans.length - 1]);
            setSelection(r);
        }
    }
    updateFormatState();
});

// --- Drawing ---
// The drawing is stored as a list of operations in page CSS pixels: pen/eraser strokes
// as point lists, lines/rectangles/circles as geometry, fills as small bitmaps of the
// area that was filled, and Clear as a marker. The on-screen canvas is only a rendering
// of that list. Undo drops the last operation and redraws, and printing/saving render the
// list again straight onto the fax dot grid, so nothing is resampled twice.
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');
// Live preview of a line/rect/circle while dragging, so the drawing underneath
// doesn't have to be redrawn on every move
const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');
const sizeInput = document.getElementById('drawSize');
const SHAPE_TOOLS = ['line', 'rect', 'circle'];
const BRUSH_TOOLS = ['pen', 'eraser'];
const ops = [];
let current = null; // operation being drawn right now
let tool = 'pen';
let color = '#000000';

const swatches = drawingToolbar.querySelectorAll('.swatch');
swatches.forEach((sw) => sw.addEventListener('click', () => {
    color = sw.dataset.color;
    swatches.forEach((s) => s.classList.toggle('active', s === sw));
}));

const toolButtons = drawingToolbar.querySelectorAll('[data-tool]');
function selectTool(name) {
    tool = name;
    toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    document.body.classList.toggle('brush', BRUSH_TOOLS.includes(name)); // hides the cursor
}
toolButtons.forEach((btn) => btn.addEventListener('click', () => selectTool(btn.dataset.tool)));
selectTool(tool);

// Stroke width in CSS px for the current tool (the eraser is 3× wider)
const brushWidth = () => sizeInput.value * (tool === 'eraser' ? 3 : 1);

// Screen pixels per CSS pixel of the drawing canvas
const screenScale = () => canvas.width / (canvas.getBoundingClientRect().width || 1);

function clearCanvas(c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
}

// Make the context draw in page CSS pixels
function useScreenScale(c) {
    const s = screenScale();
    c.setTransform(s, 0, 0, s, 0, 0);
}

function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (!w || !h || (w === canvas.width && h === canvas.height)) return;
    canvas.width = previewCanvas.width = w;
    canvas.height = previewCanvas.height = h;
    redraw(); // re-render from the operations: always sharp, never stretched
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('load', resizeCanvas);
resizeCanvas();

// Pointer position in page CSS pixels, with pen pressure as a width multiplier
function point(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure * 2 : 1;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, p };
}

// --- Rendering operations ---
function applyStyle(c, op) {
    c.globalCompositeOperation = op.mode === 'eraser' ? 'destination-out' : 'source-over';
    c.strokeStyle = op.color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
}

function segment(c, op, a, b) {
    c.lineWidth = op.width * b.p;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
}

// Draw one operation onto a context whose transform maps page CSS px to its pixels
function drawOp(c, op) {
    c.save();
    applyStyle(c, op);
    const { x0, y0, x1, y1 } = op;
    switch (op.type) {
        case 'stroke':
            segment(c, op, op.points[0], op.points[0]); // the dot where the stroke started
            for (let i = 1; i < op.points.length; i++) segment(c, op, op.points[i - 1], op.points[i]);
            break;
        case 'line':
        case 'rect':
        case 'circle':
            c.lineWidth = op.width;
            c.beginPath();
            if (op.type === 'line') {
                c.moveTo(x0, y0);
                c.lineTo(x1, y1);
            } else if (op.type === 'rect') {
                c.rect(x0, y0, x1 - x0, y1 - y0);
            } else {
                c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
            }
            c.stroke();
            break;
        case 'fill':
            c.imageSmoothingEnabled = true;
            c.imageSmoothingQuality = 'high';
            c.drawImage(op.bitmap, op.x, op.y, op.w, op.h);
            break;
        case 'clear':
            clearCanvas(c);
            break;
    }
    c.restore();
}

// Render the operation list (only what's after the last Clear matters)
function renderOps(c) {
    for (let i = ops.findLastIndex((op) => op.type === 'clear') + 1; i < ops.length; i++) drawOp(c, ops[i]);
}

function redraw() {
    clearCanvas(ctx);
    useScreenScale(ctx);
    renderOps(ctx);
}

// Add a finished operation and draw it on screen
function commit(op) {
    ops.push(op);
    useScreenScale(ctx);
    drawOp(ctx, op);
}

// End point of a shape; with Shift, lines snap to 45° and rect/circle become square/round
function shapeEnd(type, x0, y0, b, constrain) {
    let dx = b.x - x0;
    let dy = b.y - y0;
    if (constrain && type === 'line') {
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        dx = Math.cos(angle) * len;
        dy = Math.sin(angle) * len;
    } else if (constrain) {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * side;
        dy = Math.sign(dy || 1) * side;
    }
    return { x1: x0 + dx, y1: y0 + dy };
}

// --- Fill ---
// Flood-fills on the on-screen pixels (what you see is what gets filled), then stores
// just the filled area as a small bitmap so it can be redrawn at any resolution.
// Only sees what's drawn on the canvas, not the page's own text and lines.
function fillOp(at) {
    const s = screenScale();
    const { width: w, height: h } = canvas;
    const x0 = Math.floor(at.x * s);
    const y0 = Math.floor(at.y * s);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return null;
    const d = ctx.getImageData(0, 0, w, h).data;
    const v = parseInt(color.slice(1, 3), 16); // greyscale: R = G = B
    const i0 = (y0 * w + x0) * 4;
    const [tr, tg, tb, ta] = d.subarray(i0, i0 + 4);
    if (ta === 255 && tr === v && tg === v && tb === v) return null; // already this grey

    const TOLERANCE = 64; // lets the fill creep into anti-aliased stroke edges
    const filled = new Uint8Array(w * h);
    const d32 = new Uint32Array(d.buffer);
    const target32 = d32[y0 * w + x0];
    // Not filled yet and close enough to the clicked colour. Most pixels in an area are
    // exactly that colour, so one 32-bit compare settles them before the per-channel check.
    const open = (p) => {
        if (filled[p]) return false;
        if (d32[p] === target32) return true;
        const i = p << 2;
        return Math.abs(d[i] - tr) <= TOLERANCE && Math.abs(d[i + 1] - tg) <= TOLERANCE &&
            Math.abs(d[i + 2] - tb) <= TOLERANCE && Math.abs(d[i + 3] - ta) <= TOLERANCE;
    };

    // Scanline flood fill: fill a whole horizontal run at once, then queue one seed per
    // run of open pixels in the rows above and below.
    let minX = x0, maxX = x0, minY = y0, maxY = y0;
    const stack = [x0, y0];
    const seedRow = (y, lx, rx) => {
        if (y < 0 || y >= h) return;
        let inRun = false;
        for (let x = lx; x <= rx; x++) {
            const o = open(y * w + x);
            if (o && !inRun) stack.push(x, y);
            inRun = o;
        }
    };
    while (stack.length) {
        const y = stack.pop();
        const x = stack.pop();
        const row = y * w;
        if (!open(row + x)) continue;
        let lx = x;
        let rx = x;
        while (lx > 0 && open(row + lx - 1)) lx--;
        while (rx < w - 1 && open(row + rx + 1)) rx++;
        filled.fill(1, row + lx, row + rx + 1);
        minX = Math.min(minX, lx);
        maxX = Math.max(maxX, rx);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        seedRow(y - 1, lx, rx);
        seedRow(y + 1, lx, rx);
    }

    // Bitmap of the region plus a 1px border (so no light halo is left against the
    // outline). Only the bounding box is visited, not the whole canvas.
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1);
    maxY = Math.min(h - 1, maxY + 1);
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bitmap = document.createElement('canvas');
    bitmap.width = bw;
    bitmap.height = bh;
    const bctx = bitmap.getContext('2d');
    const img = bctx.createImageData(bw, bh);
    const out = new Uint32Array(img.data.buffer);
    const pixel = ((255 << 24) | (v << 16) | (v << 8) | v) >>> 0; // opaque grey (RGBA bytes)
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const p = y * w + x;
            if (filled[p] ||
                (x > 0 && filled[p - 1]) || (x < w - 1 && filled[p + 1]) ||
                (y > 0 && filled[p - w]) || (y < h - 1 && filled[p + w])) {
                out[(y - minY) * bw + (x - minX)] = pixel;
            }
        }
    }
    bctx.putImageData(img, 0, 0);
    return { type: 'fill', color, bitmap, x: minX / s, y: minY / s, w: bw / s, h: bh / s };
}

// --- Pointer input ---
// iPad: stop Apple Pencil Scribble (handwriting-to-text) and other touch gestures from
// taking over quick strokes. Scribble kicks in because the page has editable text.
['touchstart', 'touchmove'].forEach((type) => canvas.addEventListener(type, (e) => {
    if (isDrawMode()) e.preventDefault();
}, { passive: false }));

// Draw part of the live stroke straight onto the screen canvas
function drawLive(fn) {
    useScreenScale(ctx);
    ctx.save();
    applyStyle(ctx, current);
    fn();
    ctx.restore();
}

canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = point(e);
    if (tool === 'fill') {
        const op = fillOp(p);
        if (op) commit(op);
        return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (SHAPE_TOOLS.includes(tool)) {
        current = { type: tool, color, width: brushWidth(), x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
    }
    current = { type: 'stroke', mode: tool, color, width: brushWidth(), points: [p] };
    ops.push(current);
    drawLive(() => segment(ctx, current, p, p)); // dot on click
});

canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    if (current.type !== 'stroke') {
        Object.assign(current, shapeEnd(current.type, current.x0, current.y0, point(e), e.shiftKey));
        clearCanvas(previewCtx);
        useScreenScale(previewCtx);
        drawOp(previewCtx, current);
        return;
    }
    // Fast pen movement gets merged into one event per frame; the in-between points
    // are kept in getCoalescedEvents(), so draw through all of them.
    const events = e.getCoalescedEvents?.() || [];
    drawLive(() => {
        for (const ev of events.length ? events : [e]) {
            const p = point(ev);
            segment(ctx, current, current.points.at(-1), p);
            current.points.push(p);
        }
    });
});

function stopDrawing() {
    if (current && current.type !== 'stroke') {
        clearCanvas(previewCtx);
        // A click without a drag draws nothing, so don't add an empty undo step
        if (current.x1 !== current.x0 || current.y1 !== current.y0) commit(current);
    }
    current = null;
}
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointercancel', stopDrawing);

// --- Stroke preview under the cursor (pen and eraser) ---
const brushPreview = document.getElementById('brushPreview');
function updateBrushPreview(e) {
    const show = BRUSH_TOOLS.includes(tool) && e.pointerType !== 'touch';
    brushPreview.classList.toggle('hidden', !show);
    if (!show) return;
    Object.assign(brushPreview.style, {
        width: `${brushWidth()}px`, // same size as the stroke
        height: `${brushWidth()}px`,
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        background: color,
    });
    brushPreview.classList.toggle('eraser', tool === 'eraser');
}
canvas.addEventListener('pointerenter', updateBrushPreview);
canvas.addEventListener('pointermove', updateBrushPreview);
canvas.addEventListener('pointerleave', () => brushPreview.classList.add('hidden'));

// --- Undo / Clear ---
function undo() {
    if (current) return; // not in the middle of a stroke
    const op = ops.pop();
    if (!op) return;
    if (op.bitmap) op.bitmap.width = 0; // free a fill's bitmap right away (Safari)
    redraw();
}
document.getElementById('drawUndo').addEventListener('click', undo);

document.getElementById('drawClear').addEventListener('click', () => {
    if (!ops.length || ops.at(-1).type === 'clear') return;
    ops.push({ type: 'clear' }); // an operation, so Clear can be undone
    redraw();
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && isDrawMode()) {
        e.preventDefault();
        undo();
    }
});

// --- Print: dither the drawing to 1-bit at fax resolution ---
// Group 3 fax is always 204 dpi across; the chosen quality sets the lines per inch down:
// normal 98, fine 196, superfine 391.
const FAX_DPI_X = 204;
const CSS_DPI = 96;
const printCanvas = document.getElementById('printCanvas');
const faxQuality = document.getElementById('faxQuality');
// Ordered (Bayer 4×4) dithering: every grey always becomes the same regular pattern
// (grey = checkerboard, dark/light grey = 75%/25% black), tiled on a fixed page grid so
// neighbouring shapes line up, instead of the noisy texture of error diffusion.
const BAYER = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
];
const LEVELS = 4; // 5 greys: 0, 1/4, 1/2, 3/4, 1

function renderFaxCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * FAX_DPI_X / CSS_DPI));
    const h = Math.max(1, Math.round(rect.height * Number(faxQuality.value) / CSS_DPI));
    printCanvas.width = w;
    printCanvas.height = h;
    const pctx = printCanvas.getContext('2d');
    // Render the drawing straight onto the fax dot grid. The scale differs across and
    // down because fax dots aren't square, so circles still come out round on paper.
    pctx.setTransform(w / rect.width, 0, 0, h / rect.height, 0, 0);
    renderOps(pctx);

    const img = pctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i += 4) {
            // Luminance as if over white paper (0 = black, 1 = white), snapped to a palette level
            const a = d[i + 3] / 255;
            const lum = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255) * a + (1 - a);
            const level = Math.round(lum * LEVELS) / LEVELS;
            const white = level > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
            // Black dots are opaque; white dots only where something was drawn (e.g. the
            // white swatch), so the page's own text still shows through elsewhere
            d[i + 3] = !white || d[i + 3] >= 128 ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = white ? 255 : 0;
        }
    }
    pctx.putImageData(img, 0, 0);
}
window.addEventListener('beforeprint', renderFaxCanvas);

// Take focus out of the text while printing so no caret or selection ends up on paper,
// then put the cursor back where it was.
let printFocus = null;
window.addEventListener('beforeprint', () => {
    const el = document.activeElement;
    if (!el?.isContentEditable) return;
    const sel = window.getSelection();
    printFocus = { el, range: sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
    el.blur();
    sel.removeAllRanges();
});
window.addEventListener('afterprint', () => {
    if (!printFocus) return;
    printFocus.el.focus();
    if (printFocus.range) setSelection(printFocus.range);
    printFocus = null;
});

// --- Save as image ---
// Renders the page as it would print (toolbar hidden), lays the dithered drawing over
// it, and saves the result as a PNG. html2canvas is only fetched on first use.
const HTML2CANVAS = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const IMAGE_SCALE = 4; // output pixels per CSS pixel (384 dpi)
const saveButton = document.getElementById('saveImage');

function loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Couldn't load ${src}`));
        document.head.append(s);
    });
}

async function renderPageImage() {
    await loadScript(HTML2CANVAS);
    renderFaxCanvas();
    // Page text and lines, without the drawing
    const shot = await html2canvas(document.querySelector('.page'), {
        scale: IMAGE_SCALE,
        backgroundColor: '#ffffff',
        onclone: (doc) => doc.body.classList.add('exporting'),
    });
    // The dithered drawing on top, enlarged with nearest-neighbour so the fax dots
    // stay crisp (transparent where nothing was drawn, so the page shows through)
    const out = shot.getContext('2d');
    out.setTransform(1, 0, 0, 1, 0, 0); // html2canvas leaves its scale applied
    out.imageSmoothingEnabled = false;
    out.drawImage(printCanvas, 0, 0, shot.width, shot.height);
    return new Promise((resolve, reject) => shot.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('the image could not be encoded'))),
        'image/png',
    ));
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

saveButton.addEventListener('click', async () => {
    const label = saveButton.textContent;
    saveButton.disabled = true;
    saveButton.textContent = '…';
    try {
        const blob = await renderPageImage();
        const name = `fax-${new Date().toISOString().slice(0, 10)}.png`;
        const file = new File([blob], name, { type: 'image/png' });
        // Phones/tablets: open the share sheet, which has "Save Image" (to Photos).
        // Elsewhere, or if sharing isn't allowed, download the file.
        if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
            try {
                await navigator.share({ files: [file] });
                return;
            } catch (err) {
                if (err.name === 'AbortError') return; // closed the share sheet
                // e.g. NotAllowedError when rendering took too long after the tap
            }
        }
        downloadBlob(blob, name);
    } catch (err) {
        alert(`Couldn't save the image: ${err.message}`);
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = label;
    }
});
