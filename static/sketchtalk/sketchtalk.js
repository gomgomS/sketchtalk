/* =========================================================================
 * SketchTalk — Voice to Minimalist Line Art (continuous mode)
 * =========================================================================
 * Pipeline: interim speech is sent to the Visual Director while the
 * speaker is still talking (debounced), so the canvas keeps sketching in
 * real time. Stale responses are dropped via a sequence number. Final
 * results are the authoritative commit.
 *
 * Icons come from the hand-authored library in sketchtalk-icons.js
 * (no network fetch — available instantly).
 * ========================================================================= */
(function () {
    'use strict';

    var GEO = window.SK_ICONS_LIB || null;

    // ------------------------------------------------------------------
    // 0. DOM & config
    // ------------------------------------------------------------------
    var CFG = window.SK_CONFIG || {};
    var stage = document.getElementById('sk-stage');
    var canvas = document.getElementById('sk-canvas');
    var ctx = canvas.getContext('2d');
    var emptyHint = document.getElementById('sk-empty');
    var interimEl = document.getElementById('sk-interim');
    var inputEl = document.getElementById('sk-input');
    var formEl = document.getElementById('sk-form');
    var micBtn = document.getElementById('sk-mic');
    var sendBtn = document.getElementById('sk-send');
    var langBtn = document.getElementById('sk-lang');
    var topicBar = document.getElementById('sk-topicbar');
    var topicEl = document.getElementById('sk-topic');
    var layoutEl = document.getElementById('sk-layout');
    var timeEl = document.getElementById('sk-time');
    var pausedEl = document.getElementById('sk-paused');
    var toastEl = document.getElementById('sk-toast');
    var engineEl = document.getElementById('sk-engine');

    var INK = '#111111';
    var INK_SOFT = '#3f3f46';
    var INK_MUTE = '#71717a';

    // Frameless doodle slots: no boxes — glyph + optional stat + label,
    // content-aware centered, with living ambient animation.
    var ICON_SIZE = 120;
    var LABEL_MAXW = 208;

    var dpr = 1;
    var viewW = 0;
    var viewH = 0;

    // Fixed slide-style camera: no user panning or zooming. The camera
    // simply fits the current scene (like a PowerPoint slide re-layout)
    // and tweens smoothly when the layout changes.
    var cam = { x: 0, y: 0, zoom: 1, tx: 0, ty: 0, tzoom: 1 };

    var state = {
        topic: '',
        layout: 'single',
        nodes: [],
        edges: [],
        dying: [],
        dividerAlpha: 0,
        paused: false,
        lastEngine: null,
        timeContext: 'none',
        sceneDesc: '',
        beat: 'scene',
        headline: '',
        kicker: '',
        heroStat: '',
        typeBorn: 0
    };

    var TIME_LABELS = { past: 'Masa Lalu', present: 'Sekarang', future: 'Masa Depan' };
    var BEAT_LABELS = { poster: 'tulisan', stat: 'angka', duo: 'teks + gambar' };

    function renderTopicBar() {
        if (state.topic !== '' || state.nodes.length > 0 || state.headline !== '' || state.heroStat !== '') {
            topicBar.style.display = 'flex';
            topicEl.textContent = state.topic;
            var beatName = BEAT_LABELS[state.beat] || '';
            layoutEl.textContent = beatName !== '' ? beatName : state.layout.replace('_', ' ');
            topicBar.title = state.headline || state.sceneDesc || '';
            if (TIME_LABELS[state.timeContext]) {
                timeEl.textContent = TIME_LABELS[state.timeContext];
                timeEl.style.display = 'inline-block';
            } else {
                timeEl.style.display = 'none';
            }
        } else {
            topicBar.style.display = 'none';
        }
    }

    var undoStack = [];
    var currentLang = 'id-ID';
    var isListening = false;
    var recognition = null;
    var showGrid = true;

    // Continuous pipeline state
    var SOURCE_ID = 'src-' + Math.random().toString(36).slice(2, 10);
    var lastRoomSeq = 0;
    var seqCounter = 0;
    var latestAppliedSeq = 0;
    var lastPreviewAt = 0;
    var lastPreviewText = '';
    var lastAppliedPreviewText = '';
    var inFlight = 0;

    function resize() {
        var rect = stage.getBoundingClientRect();
        dpr = window.devicePixelRatio || 1;
        viewW = rect.width;
        viewH = rect.height;
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        autofit();
    }
    window.addEventListener('resize', resize);

    // ------------------------------------------------------------------
    // 1. Helpers
    // ------------------------------------------------------------------
    function easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    var toastTimer = null;
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('show');
        }, 2400);
    }

    function setEngineBadge(engine) {
        state.lastEngine = engine;
        var label;
        if (engine === 'claude' || engine === 'deepseek') {
            label = engine + ' · ' + (CFG.aiModel || '');
        } else if (engine === 'command') {
            label = 'perintah suara';
        } else {
            label = 'aturan offline';
        }
        engineEl.textContent = 'engine: ' + label;
    }

    function updateEmptyState() {
        if (state.nodes.length > 0 || state.dying.length > 0 || state.headline !== '' || state.heroStat !== '') {
            emptyHint.style.opacity = '0';
        } else {
            emptyHint.style.opacity = '1';
        }
    }

    // ------------------------------------------------------------------
    // 2. Icon drawing (progressive stroke reveal)
    // ------------------------------------------------------------------
    function drawIcon(geo, size, progress) {
        if (!geo || geo.total <= 0) {
            return;
        }
        var scale = size / 24;
        var budget = geo.total * easeOutCubic(Math.max(0, Math.min(1, progress)));
        ctx.save();
        ctx.scale(scale, scale);
        ctx.lineWidth = 2; // 24-space units -> proportional screen stroke
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (var i = 0; i < geo.paths.length; i++) {
            var sub = geo.paths[i];
            if (budget <= 0) {
                break;
            }
            var pts = sub.pts;
            if (budget >= sub.len) {
                ctx.beginPath();
                ctx.moveTo(pts[0], pts[1]);
                for (var j = 2; j + 1 < pts.length; j += 2) {
                    ctx.lineTo(pts[j], pts[j + 1]);
                }
                ctx.stroke();
                budget -= sub.len;
            } else {
                var need = budget;
                ctx.beginPath();
                ctx.moveTo(pts[0], pts[1]);
                var acc = 0;
                for (var j2 = 2; j2 + 1 < pts.length; j2 += 2) {
                    var seg = Math.hypot(pts[j2] - pts[j2 - 2], pts[j2 + 1] - pts[j2 - 1]);
                    if (acc + seg >= need) {
                        var t = seg > 0 ? (need - acc) / seg : 0;
                        ctx.lineTo(
                            pts[j2 - 2] + (pts[j2] - pts[j2 - 2]) * t,
                            pts[j2 - 1] + (pts[j2 + 1] - pts[j2 - 1]) * t
                        );
                        break;
                    }
                    ctx.lineTo(pts[j2], pts[j2 + 1]);
                    acc += seg;
                }
                ctx.stroke();
                budget = 0;
            }
        }
        ctx.restore();
    }

    // ------------------------------------------------------------------
    // 3. Node measurement — the tidy layout core.
    // Every node is a measured vertical stack (icon -> stat -> label)
    // with fixed gaps; edges and the camera use the measured box.
    // ------------------------------------------------------------------
    function wrapText(text, font, maxW) {
        ctx.font = font;
        if (ctx.measureText(text).width <= maxW) {
            return [text];
        }
        var words = text.split(/\s+/);
        var line1 = '';
        var i = 0;
        for (; i < words.length; i++) {
            var candidate = (line1 === '' ? '' : line1 + ' ') + words[i];
            if (ctx.measureText(candidate).width > maxW && line1 !== '') {
                break;
            }
            line1 = candidate;
        }
        var line2 = words.slice(i, i + 3).join(' ');
        if (line2 !== '' && i + 3 < words.length) {
            line2 = line2 + '…';
        }
        return line2 !== '' ? [line1, line2] : [line1];
    }

    function layoutNodeBox(node) {
        var statText = node.stat || '';
        var statFont = 34;
        var statW = 0;
        if (statText !== '') {
            statW = 9999;
            while (statW > 180 && statFont > 18) {
                ctx.font = '700 ' + statFont + 'px "IBM Plex Mono", monospace';
                statW = ctx.measureText(statText).width;
                if (statW > 180) {
                    statFont -= 2;
                }
            }
        }
        var labelFont = '600 18px "Archivo", sans-serif';
        var lines = node.label ? wrapText(node.label, labelFont, LABEL_MAXW) : [];

        var hIcon = ICON_SIZE;
        var gap1 = statText !== '' ? 20 : 30;
        var hStat = statText !== '' ? statFont + 8 : 0;
        var gap2 = lines.length > 0 ? 12 : 0;
        var hLabel = lines.length * 25;
        var total = hIcon + gap1 + hStat + gap2 + hLabel;
        var top = -total / 2;

        node.box = {
            iconCy: top + hIcon / 2,
            iconSize: hIcon,
            statFont: statFont,
            statY: top + hIcon + gap1,
            labelY: top + hIcon + gap1 + hStat + gap2,
            lines: lines,
            contentW: Math.max(hIcon, statW, 200),
            halfW: Math.max(hIcon, statW + 20, statW === 0 ? 0 : 0) / 2,
            halfH: total / 2
        };
        var labelW = 0;
        ctx.font = labelFont;
        for (var i = 0; i < lines.length; i++) {
            labelW = Math.max(labelW, ctx.measureText(lines[i]).width);
        }
        var ornament = 0;
        if (node.role === 'vehicle') {
            ornament = 56;
        }
        node.box.halfW = Math.max(hIcon, statW, labelW) / 2 + 18 + ornament;
        node.box.halfH = total / 2 + 22;
    }

    function nodeExtents(node) {
        var box = node.box;
        if (!box) {
            layoutNodeBox(node);
            box = node.box;
        }
        return { rx: box.halfW, ry: box.halfH };
    }

    // ------------------------------------------------------------------
    // 4. Layout engine — story compositions, not grids.
    // flow rides a wave, hub_spoke is an uneven constellation,
    // comparison is two staggered stages. Roles nudge vehicles
    // up into the air and places down onto the ground.
    // ------------------------------------------------------------------
    var LIFT_VEHICLE = { airplane: 1, train: 1, rocket: 1, route: 1 };
    var LIFT_PLACE = {
        'map-pin': 1, house: 1, hospital: 1, village: 1, 'building-2': 1,
        flag: 1, 'flag-germany': 1, 'flag-japan': 1, 'flag-indonesia': 1
    };

    function storySlots(layout, n) {
        var slots = [];
        var i;
        var t;
        if (layout === 'single' || n <= 1) {
            slots.push({ x: 0, y: 0, scale: 1.28 });
            return slots;
        }
        if (layout === 'hub_spoke') {
            if (n === 2) {
                slots.push({ x: -90, y: 36, scale: 1.18 });
                slots.push({ x: 250, y: -70, scale: 0.96 });
            } else if (n === 3) {
                slots.push({ x: -16, y: 48, scale: 1.16 });
                slots.push({ x: -310, y: -96, scale: 0.94 });
                slots.push({ x: 270, y: -8, scale: 0.94 });
            } else {
                slots.push({ x: -24, y: 28, scale: 1.14 });
                slots.push({ x: -350, y: -130, scale: 0.88 });
                slots.push({ x: 130, y: -180, scale: 0.9 });
                slots.push({ x: 370, y: 36, scale: 0.88 });
            }
            return slots;
        }
        if (layout === 'comparison') {
            if (n === 2) {
                slots.push({ x: -250, y: -36, scale: 1.04 });
                slots.push({ x: 268, y: 64, scale: 1.04 });
            } else if (n === 3) {
                slots.push({ x: -290, y: 12, scale: 1.06 });
                slots.push({ x: 150, y: -140, scale: 0.94 });
                slots.push({ x: 350, y: 120, scale: 0.94 });
            } else {
                slots.push({ x: -390, y: -80, scale: 0.9 });
                slots.push({ x: -140, y: 130, scale: 0.9 });
                slots.push({ x: 160, y: -120, scale: 0.9 });
                slots.push({ x: 400, y: 90, scale: 0.9 });
            }
            return slots;
        }
        // flow — one sine wave, read left to right. Four beats make an
        // S, fewer beats make a single rising-then-landing arc.
        var span = n === 2 ? 480 : (n === 3 ? 700 : 940);
        var amp = n === 2 ? 84 : (n === 3 ? 124 : 108);
        var phase = n >= 4 ? 1.35 : 1;
        var shift = n >= 4 ? 0.25 : 0.15;
        var scale = n >= 4 ? 0.9 : 1;
        for (i = 0; i < n; i++) {
            t = i / (n - 1);
            var y = -Math.sin(t * Math.PI * phase + shift) * amp;
            if (i === n - 1) {
                y += n >= 4 ? 22 : 26;
            }
            slots.push({ x: (t - 0.5) * span, y: y, scale: scale });
        }
        return slots;
    }

    function applyStoryLift(objects, slots) {
        var i;
        for (i = 0; i < objects.length && i < slots.length; i++) {
            var obj = objects[i];
            var role = obj.role || 'object';
            var icon = obj.icon || '';
            if (role === 'vehicle' || LIFT_VEHICLE[icon]) {
                slots[i].y -= 34;
                slots[i].scale = slots[i].scale * 1.04;
            } else if (role === 'destination' || role === 'place' || LIFT_PLACE[icon]) {
                slots[i].y += 20;
            } else if (role === 'subject') {
                slots[i].scale = slots[i].scale * 1.05;
            }
        }
    }

    function computeLayout(layout, objects) {
        var n = objects.length;
        if (n === 0) {
            return [];
        }
        var pos = storySlots(layout, n);
        if (layout !== 'single' && n > 1) {
            applyStoryLift(objects, pos);
        }
        while (pos.length < n) {
            pos.push({ x: 0, y: pos.length * 240, scale: 1 });
        }
        return pos;
    }

    // ------------------------------------------------------------------
    // 5. Scene mutations
    // ------------------------------------------------------------------
    function snapshot() {
        var objs = [];
        for (var i = 0; i < state.nodes.length; i++) {
            var nd = state.nodes[i];
            objs.push({
                id: nd.id,
                icon: nd.icon,
                label: nd.label,
                highlight_stat: nd.stat,
                connect_to: null,
                edge_label: null,
                role: nd.role || 'object'
            });
        }
        for (var e = 0; e < state.edges.length; e++) {
            var ed = state.edges[e];
            for (var o = 0; o < objs.length; o++) {
                if (objs[o].id === ed.fromId) {
                    objs[o].connect_to = ed.toId;
                    objs[o].edge_label = ed.label;
                }
            }
        }
        return {
            topic: state.topic,
            layout: state.layout,
            objects: objs,
            time_context: state.timeContext,
            scene_description: state.sceneDesc,
            beat: state.beat,
            headline: state.headline,
            kicker: state.kicker,
            hero_stat: state.heroStat
        };
    }

    function pushUndo() {
        undoStack.push(snapshot());
        if (undoStack.length > 40) {
            undoStack.shift();
        }
    }

    // Arrows are retired: cards relate through position and layout only.
    function buildEdges(objects) {
        return [];
    }

    function setScene(objects, layout, topic, extras) {
        extras = extras || {};
        var nextBeat = extras.beat || 'scene';
        var nextHead = extras.headline || '';
        var nextKick = extras.kicker || '';
        var nextHero = extras.hero || '';
        if (nextBeat !== state.beat || nextHead !== state.headline || nextHero !== state.heroStat) {
            state.typeBorn = performance.now();
        }
        state.beat = nextBeat;
        state.headline = nextHead;
        state.kicker = nextKick;
        state.heroStat = nextHero;
        state.layout = layout;
        state.topic = topic || '';
        state.timeContext = extras.time || 'none';
        state.sceneDesc = extras.scene || '';
        var pos = computeLayout(layout, objects);
        if (state.beat === 'duo') {
            for (var s = 0; s < pos.length; s++) {
                pos[s].x = 320;
                pos[s].y = (s - (pos.length - 1) / 2) * 220;
                pos[s].scale = pos.length > 1 ? 0.84 : 1.04;
            }
        } else if (state.beat === 'stat') {
            for (var s2 = 0; s2 < pos.length; s2++) {
                pos[s2].x = (s2 - (pos.length - 1) / 2) * 150;
                pos[s2].y = -230;
                pos[s2].scale = 0.42;
            }
        }
        var byId = {};
        for (var i = 0; i < state.nodes.length; i++) {
            byId[state.nodes[i].id] = state.nodes[i];
        }

        var freshNodes = [];
        var spawnFrom = state.nodes.length > 0 ? state.nodes[0] : null;
        for (var j = 0; j < objects.length; j++) {
            var obj = objects[j];
            var p = pos[j];
            var existing = byId[obj.id];
            if (existing !== undefined) {
                existing.tx = p.x;
                existing.ty = p.y;
                existing.tScale = p.scale;
                existing.tAlpha = 1;
                existing.icon = obj.icon || 'sticky-note';
                existing.label = obj.label || '';
                existing.stat = obj.highlight_stat || null;
                existing.role = obj.role || 'object';
                existing.born = existing.born !== undefined ? existing.born : performance.now();
                delete byId[obj.id];
                freshNodes.push(existing);
            } else {
                var sx = spawnFrom !== null ? spawnFrom.x : 0;
                var sy = spawnFrom !== null ? spawnFrom.y : 0;
                freshNodes.push({
                    id: obj.id,
                    icon: obj.icon || 'sticky-note',
                    label: obj.label || '',
                    stat: obj.highlight_stat || null,
                    role: obj.role || 'object',
                    x: sx,
                    y: sy,
                    tx: p.x,
                    ty: p.y,
                    scale: 0.6,
                    tScale: p.scale,
                    alpha: 0,
                    tAlpha: 1,
                    born: performance.now() + 60 + j * 90,
                    phase: Math.random() * 6.283,
                    box: null
                });
            }
        }
        for (var deadId in byId) {
            if (Object.prototype.hasOwnProperty.call(byId, deadId)) {
                var dead = byId[deadId];
                dead.tAlpha = 0;
                state.dying.push(dead);
            }
        }
        state.nodes = freshNodes;
        for (var m = 0; m < state.nodes.length; m++) {
            layoutNodeBox(state.nodes[m]);
        }
        state.edges = buildEdges(objects);

        renderTopicBar();
        updateEmptyState();
        autofit();
    }

    function applyDirective(dir, opts) {
        if (!dir || !dir.action) {
            return;
        }
        opts = opts || {};
        var action = dir.action;
        if (action === 'PAUSE') {
            setPaused(true);
            return;
        }
        if (action === 'RESUME') {
            setPaused(false);
            return;
        }
        if (action === 'IGNORE') {
            return;
        }
        var objects = Array.isArray(dir.objects) ? dir.objects.slice(0, 4) : [];
        var beat = ['scene', 'poster', 'stat', 'duo'].indexOf(dir.beat) >= 0 ? dir.beat : 'scene';
        var headline = (dir.headline || '').trim();
        var kicker = (dir.kicker || '').trim();
        var hero = dir.hero_stat == null ? '' : String(dir.hero_stat).trim();
        if (headline === '' && (beat === 'poster' || beat === 'stat' || beat === 'duo')) {
            headline = (dir.topic_summary || '').trim();
        }
        if (beat === 'stat' && hero === '' && objects.length > 0) {
            hero = objects[0].highlight_stat || '';
        }
        if (beat === 'poster' && headline === '' && objects.length > 0) {
            headline = objects[0].label || '';
        }
        var canDraw = objects.length > 0 ||
            (beat === 'poster' && headline !== '') ||
            (beat === 'stat' && (hero !== '' || headline !== '')) ||
            (beat === 'duo' && headline !== '' && objects.length > 0);
        // Only the explicit "hapus layar" command may bring the empty prompt back.
        // Any other slide with nothing to draw is dropped, so the picture stays
        // while the speaker is still talking.
        if (dir.cleared === true) {
            for (var c = 0; c < state.nodes.length; c++) {
                state.nodes[c].tAlpha = 0;
                state.dying.push(state.nodes[c]);
            }
            state.nodes = [];
            state.edges = [];
            state.topic = '';
            state.timeContext = 'none';
            state.sceneDesc = '';
            state.beat = 'scene';
            state.headline = '';
            state.kicker = '';
            state.heroStat = '';
            renderTopicBar();
            updateEmptyState();
            autofit();
            return;
        }
        if (!canDraw) {
            return;
        }
        if (!opts.partial) {
            pushUndo();
        }
        if (action === 'CLEAR_AND_DRAW') {
            for (var i = 0; i < state.nodes.length; i++) {
                state.nodes[i].tAlpha = 0;
                state.dying.push(state.nodes[i]);
            }
            state.nodes = [];
            state.edges = [];
        }
        var layout = ['single', 'flow', 'hub_spoke', 'comparison'].indexOf(dir.layout) >= 0 ? dir.layout : 'single';
        if (objects.length === 1 && layout === 'flow') {
            layout = 'single';
        }
        if (beat === 'poster' || beat === 'stat') {
            layout = 'single';
        }
        setScene(objects, layout, dir.topic_summary || '', {
            time: dir.time_context,
            scene: dir.scene_description,
            beat: beat,
            headline: headline,
            kicker: kicker,
            hero: hero
        });
        console.log('[sketchtalk] scene applied:', objects.length, 'objects |', beat, layout,
            '| cam zoom', Math.round(cam.tzoom * 100) / 100,
            '| pos', Math.round(cam.tx), Math.round(cam.ty));
    }

    function undo() {
        if (undoStack.length === 0) {
            toast('Tidak ada aksi untuk diurungkan');
            return;
        }
        var snap = undoStack.pop();
        setScene(snap.objects, snap.layout, snap.topic, {
            time: snap.time_context,
            scene: snap.scene_description,
            beat: snap.beat,
            headline: snap.headline,
            kicker: snap.kicker,
            hero: snap.hero_stat
        });
        toast('Aksi terakhir diurungkan');
    }

    function clearCanvas(showToast) {
        pushUndo();
        for (var i = 0; i < state.nodes.length; i++) {
            state.nodes[i].tAlpha = 0;
            state.dying.push(state.nodes[i]);
        }
        state.nodes = [];
        state.edges = [];
        state.topic = '';
        state.timeContext = 'none';
        state.sceneDesc = '';
        state.beat = 'scene';
        state.headline = '';
        state.kicker = '';
        state.heroStat = '';
        renderTopicBar();
        updateEmptyState();
        autofit();
        if (showToast !== false) {
            toast('Kanvas dibersihkan');
        }
    }

    // ------------------------------------------------------------------
    // 6. Camera
    // ------------------------------------------------------------------
    function typeBounds() {
        if (state.beat === 'poster') {
            return { minX: -480, maxX: 480, minY: -190, maxY: 190 };
        }
        if (state.beat === 'stat') {
            return { minX: -360, maxX: 360, minY: -290, maxY: 210 };
        }
        if (state.beat === 'duo') {
            return { minX: -640, maxX: -40, minY: -180, maxY: 180 };
        }
        return null;
    }

    function autofit() {
        var nodes = state.nodes;
        var minX = Infinity;
        var minY = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;
        var counted = 0;
        if (state.beat !== 'poster' && state.beat !== 'stat') {
            for (var i = 0; i < nodes.length; i++) {
                var nd = nodes[i];
                var ext = nodeExtents(nd);
                minX = Math.min(minX, nd.tx - ext.rx);
                maxX = Math.max(maxX, nd.tx + ext.rx);
                minY = Math.min(minY, nd.ty - ext.ry);
                maxY = Math.max(maxY, nd.ty + ext.ry);
                counted = counted + 1;
            }
        }
        var tb = typeBounds();
        if (tb) {
            minX = Math.min(minX, tb.minX);
            maxX = Math.max(maxX, tb.maxX);
            minY = Math.min(minY, tb.minY);
            maxY = Math.max(maxY, tb.maxY);
            counted = counted + 1;
        }
        if (counted === 0) {
            cam.tx = 0;
            cam.ty = 0;
            cam.tzoom = 1;
            return;
        }
        var pad = 78;
        var bw = maxX - minX + pad * 2;
        var bh = maxY - minY + pad * 2;
        var topSafe = 90;
        var bottomSafe = 160;
        var zoomX = viewW / bw;
        var zoomY = (viewH - topSafe - bottomSafe) / bh;
        var zoom = Math.min(zoomX, zoomY, 1.15);
        zoom = Math.max(0.3, zoom);
        var cxWorld = (minX + maxX) / 2;
        var cyWorld = (minY + maxY) / 2;
        cam.tzoom = zoom;
        cam.tx = viewW / 2 - cxWorld * zoom;
        cam.ty = topSafe + (viewH - topSafe - bottomSafe) / 2 - cyWorld * zoom;
    }



    // ------------------------------------------------------------------
    // 7. Render loop
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Living doodles — hand-coded ambient animation per subject.
    // ------------------------------------------------------------------
    function ambientAlpha(p) {
        return Math.max(0, Math.min(1, (p - 0.5) / 0.5));
    }

    var WAVE_FLAGS = {
        'flag-germany': 'stripes3',
        'flag-indonesia': 'stripes2',
        'flag-japan': 'circle',
        'flag': 'plain'
    };

    // Waving flag on a pole, drawn in node-local pixels (s = icon size).
    // The cloth is a strip of ripples so the flag reads as fabric, not a box.
    function drawWavyFlag(kind, t, s) {
        var poleX = -0.28 * s;
        var topY = -0.44 * s;
        var fw = 0.72 * s;
        var fh = 0.42 * s;
        var steps = 7;
        var i;
        var u;
        var wob;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(poleX, topY - 0.055 * s, 0.038 * s, 0, Math.PI * 2);
        ctx.moveTo(poleX, topY - 0.02 * s);
        ctx.lineTo(poleX, topY + fh + 0.5 * s);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(poleX, topY);
        for (i = 1; i <= steps; i++) {
            u = i / steps;
            wob = Math.sin(t * 2.5 + u * 3.4) * 0.05 * s * u;
            ctx.lineTo(poleX + fw * u, topY + wob);
        }
        for (i = steps; i >= 0; i--) {
            u = i / steps;
            wob = Math.sin(t * 2.5 + 0.7 + u * 3.4) * 0.05 * s * u;
            ctx.lineTo(poleX + fw * u, topY + fh + wob);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.lineWidth = 1.6;
        if (kind === 'stripes3' || kind === 'stripes2') {
            var fracs = kind === 'stripes3' ? [0.333, 0.667] : [0.5];
            for (var f = 0; f < fracs.length; f++) {
                ctx.beginPath();
                ctx.moveTo(poleX, topY + fh * fracs[f]);
                for (i = 1; i <= steps; i++) {
                    u = i / steps;
                    wob = Math.sin(t * 2.5 + fracs[f] * 2.2 + u * 3.4) * 0.045 * s * u;
                    ctx.lineTo(poleX + fw * u, topY + fh * fracs[f] + wob);
                }
                ctx.stroke();
            }
        } else if (kind === 'circle') {
            var cx = poleX + fw * 0.48;
            var cy = topY + fh * 0.5 + Math.sin(t * 2.5 + 1.4) * 0.02 * s;
            ctx.beginPath();
            ctx.arc(cx, cy, 0.11 * s, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = ctx.globalAlpha * 0.4;
        ctx.beginPath();
        ctx.ellipse(poleX + 0.08 * s, topY + fh + 0.56 * s, 0.22 * s, 0.045 * s, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Whole-glyph motion (applied in node-local pixels).
    function glyphWobble(icon, t) {
        if (icon === 'heart') {
            return { scale: 1 + 0.05 * Math.pow(Math.max(0, Math.sin(t * 3.1)), 3) };
        }
        if (icon === 'football' || icon === 'soccer-kick') {
            return { dy: -Math.abs(Math.sin(t * 2.1)) * 5 };
        }
        if (icon === 'school-kid') {
            return { rot: Math.sin(t * 3.4) * 0.05 };
        }
        if (icon === 'airplane') {
            return { dy: Math.sin(t * 1.6) * 4 };
        }
        if (icon === 'zap' || icon === 'sparkles') {
            return { alpha: 0.8 + 0.2 * Math.sin(t * 7) };
        }
        return {};
    }

    // Ambient strokes around/over the glyph, drawn in the glyph's 24x24
    // space (ctx is pre-scaled). Every subject gets its own bit of life.
    function drawAmbient(icon, t) {
        var i;
        var a;
        var p;
        ctx.strokeStyle = INK_SOFT;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        switch (icon) {
            case 'airplane': {
                for (i = 0; i < 3; i++) {
                    var ay = 7.2 + i * 2.3;
                    var ax = 0.4 + Math.sin(t * 5 + i) * 0.7;
                    ctx.beginPath();
                    ctx.moveTo(ax, ay);
                    ctx.lineTo(ax + 5.2 - i * 0.6, ay + 0.35);
                    ctx.stroke();
                }
                break;
            }
            case 'rocket': {
                for (i = 0; i < 3; i++) {
                    p = ((t * 1.4) + i / 3) % 1;
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * (1 - p) * 0.75;
                    ctx.beginPath();
                    ctx.moveTo(10.2, 19 + p * 4);
                    ctx.lineTo(12, 21.5 + p * 4.5);
                    ctx.lineTo(13.8, 19 + p * 4);
                    ctx.stroke();
                    ctx.restore();
                }
                break;
            }
            case 'user':
            case 'users':
            case 'school-kid':
            case 'worker': {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (0.35 + 0.45 * Math.pow(Math.max(0, Math.sin(t * 2.2)), 2));
                ctx.beginPath();
                ctx.ellipse(12, 22.2, 5.2, 1.1, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'house':
            case 'village': {
                var sx = 17.2 + Math.sin(t * 0.8) * 0.4;
                ctx.beginPath();
                ctx.moveTo(sx, 6.2);
                ctx.quadraticCurveTo(sx + 1.6, 4.2, sx + 0.4, 2.4);
                ctx.stroke();
                break;
            }
            case 'hospital': {
                p = (t * 0.7) % 1;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (1 - p) * 0.55;
                ctx.beginPath();
                ctx.arc(12, 12.5, 3.2 + p * 5, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'coins':
            case 'dollar-sign':
            case 'wallet': {
                var spark = 0.6 + 0.7 * Math.sin(t * 3.2);
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (0.35 + 0.4 * Math.sin(t * 3.2));
                ctx.beginPath();
                ctx.moveTo(19, 4.5 - spark);
                ctx.lineTo(19, 4.5 + spark);
                ctx.moveTo(19 - spark, 4.5);
                ctx.lineTo(19 + spark, 4.5);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'graduation-cap': {
                a = Math.sin(t * 2.4) * 0.7;
                ctx.beginPath();
                ctx.moveTo(21.2, 9.2);
                ctx.quadraticCurveTo(22.4 + a, 13, 20.6, 16.4);
                ctx.stroke();
                break;
            }
            case 'train': {
                for (i = 0; i < 3; i++) {
                    p = ((t * 0.45) + i / 3) % 1;
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * (1 - p) * 0.7;
                    ctx.beginPath();
                    ctx.arc(6.2 + Math.sin(i * 2.1) * 0.8, 3.2 - p * 3.6, 0.7 + p * 1.5, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                a = t * 6;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * 0.8;
                ctx.beginPath();
                ctx.moveTo(8.5 - 1.5 * Math.cos(a), 19.5 - 1.5 * Math.sin(a));
                ctx.lineTo(8.5 + 1.5 * Math.cos(a), 19.5 + 1.5 * Math.sin(a));
                ctx.moveTo(15.5 - 1.5 * Math.cos(a), 19.5 - 1.5 * Math.sin(a));
                ctx.lineTo(15.5 + 1.5 * Math.cos(a), 19.5 + 1.5 * Math.sin(a));
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'clock': {
                a = -t * 1.047;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * 0.85;
                ctx.beginPath();
                ctx.moveTo(12, 12);
                ctx.lineTo(12 + 7.2 * Math.cos(a), 12 + 7.2 * Math.sin(a));
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'globe': {
                var rx = Math.abs(Math.cos(t * 0.7)) * 7.5;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * 0.55;
                ctx.beginPath();
                ctx.ellipse(12, 12, rx, 8.5, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'lightbulb': {
                for (i = 0; i < 5; i++) {
                    a = (-90 + (i - 2) * 30) * Math.PI / 180;
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * (0.25 + 0.45 * Math.pow(Math.sin(t * 2.4 + i * 1.1), 2));
                    ctx.beginPath();
                    ctx.moveTo(12 + 11.5 * Math.cos(a), 12 + 11.5 * Math.sin(a));
                    ctx.lineTo(12 + 14 * Math.cos(a), 12 + 14 * Math.sin(a));
                    ctx.stroke();
                    ctx.restore();
                }
                break;
            }
            case 'target': {
                p = (t * 0.55) % 1;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (1 - p) * 0.5;
                ctx.beginPath();
                ctx.arc(12, 12, 9 + p * 4.5, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'hourglass': {
                for (i = 0; i < 2; i++) {
                    var py = 11.5 + ((t * 1.3 + i * 0.5) % 1) * 5.5;
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * 0.8;
                    ctx.beginPath();
                    ctx.arc(12, py, 0.55, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                break;
            }
            case 'star':
            case 'sparkles': {
                var s2 = 1.2 + 0.8 * Math.sin(t * 3 + 1);
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (0.4 + 0.4 * Math.sin(t * 3));
                ctx.beginPath();
                ctx.moveTo(19 - s2, 4.5);
                ctx.lineTo(19 + s2, 4.5);
                ctx.moveTo(19, 4.5 - s2);
                ctx.lineTo(19, 4.5 + s2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'cloud': {
                var cx2 = 17 + Math.sin(t * 0.5) * 2.2;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * 0.5;
                ctx.beginPath();
                ctx.ellipse(cx2, 6, 3.2, 1.7, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'search': {
                a = t * 1.8;
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * 0.6;
                ctx.beginPath();
                ctx.moveTo(10.5 - 2.4 * Math.cos(a), 10.5 - 2.4 * Math.sin(a));
                ctx.lineTo(10.5 + 2.4 * Math.cos(a), 10.5 + 2.4 * Math.sin(a));
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'moon': {
                var tw = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * 2.6)), 2);
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * tw;
                ctx.beginPath();
                ctx.moveTo(6.2, 5.2);
                ctx.lineTo(6.2, 7.6);
                ctx.moveTo(5, 6.4);
                ctx.lineTo(7.4, 6.4);
                ctx.stroke();
                ctx.restore();
                break;
            }
            case 'sun':
            case 'sunrise':
            case 'sunset': {
                ctx.save();
                ctx.globalAlpha = ctx.globalAlpha * (0.25 + 0.35 * Math.pow(Math.sin(t * 1.8), 2));
                ctx.beginPath();
                ctx.arc(12, icon === 'sunset' ? 15.6 : 12, icon === 'sunrise' ? 5.2 : 6.4, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                break;
            }
            default:
                break;
        }
    }

    function drawRoleMarks(node, box, t, intro) {
        var s = box.iconSize;
        var role = node.role || 'object';
        var icon = node.icon;
        var reveal = Math.max(0, Math.min(1, (intro - 0.15) / 0.5));
        if (reveal <= 0) {
            return;
        }
        ctx.save();
        ctx.translate(0, box.iconCy);
        ctx.strokeStyle = INK;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.45;
        ctx.globalAlpha = ctx.globalAlpha * 0.55 * reveal;

        if (state.layout === 'single') {
            ctx.beginPath();
            ctx.arc(0, 2, s * 0.64, 0.4 + Math.sin(t * 0.4) * 0.05, Math.PI * 1.62);
            ctx.stroke();
            ctx.globalAlpha = ctx.globalAlpha * 0.65;
            ctx.beginPath();
            ctx.arc(6, 8, s * 0.64, 1.05, 2.35);
            ctx.stroke();
            var tick;
            for (tick = 0; tick < 8; tick++) {
                var ang = t * 0.18 + tick * Math.PI / 4;
                ctx.beginPath();
                ctx.moveTo(Math.cos(ang) * s * 0.72, Math.sin(ang) * s * 0.72 + 2);
                ctx.lineTo(Math.cos(ang) * s * 0.8, Math.sin(ang) * s * 0.8 + 2);
                ctx.stroke();
            }
        } else if (state.layout === 'hub_spoke' && state.nodes.length > 0 && state.nodes[0] === node) {
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.58, 0.2, Math.PI * 1.85);
            ctx.stroke();
        }

        var airborne = role === 'vehicle' || icon === 'airplane' || icon === 'rocket' || icon === 'train';
        var grounded = role === 'destination' || role === 'place' ||
            icon === 'map-pin' || icon === 'house' || icon === 'hospital' ||
            icon === 'village' || icon === 'building-2';
        if (WAVE_FLAGS[icon]) {
            grounded = false;
            airborne = false;
        }
        var person = role === 'subject' || icon === 'user' || icon === 'users' ||
            icon === 'school-kid' || icon === 'worker';

        if (airborne && state.layout !== 'single') {
            var k;
            for (k = 0; k < 3; k++) {
                var yy = -s * 0.2 + k * s * 0.16;
                var len = s * (0.18 + 0.08 * Math.sin(t * 6 + k * 0.8));
                ctx.beginPath();
                ctx.moveTo(-s * 0.58, yy);
                ctx.lineTo(-s * 0.58 - len, yy);
                ctx.stroke();
            }
        } else if (grounded) {
            ctx.beginPath();
            ctx.ellipse(0, s * 0.48, s * 0.38, s * 0.065, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = ctx.globalAlpha * 0.7;
            ctx.beginPath();
            ctx.ellipse(0, s * 0.54, s * 0.22, s * 0.035, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (person) {
            ctx.beginPath();
            ctx.ellipse(0, s * 0.5, s * 0.26, s * 0.05, 0, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawNode(node, now) {
        if (!node.box) {
            layoutNodeBox(node);
        }
        var t = now / 1000;
        var p = Math.max(0, Math.min(1, (now - node.born) / 550));
        var fade = Math.max(0, Math.min(1, (now - node.born) / 200));
        var box = node.box;
        var intro = 0.94 + 0.06 * easeOutCubic(p);
        ctx.save();
        // Gentle breathing bob — every doodle feels alive.
        ctx.translate(node.x, node.y + Math.sin(t * 1.2 + (node.phase || 0)) * 3);
        ctx.scale(node.scale * intro, node.scale * intro);
        ctx.globalAlpha = node.alpha * fade;

        var textAlpha = Math.max(0, Math.min(1, (p - 0.35) / 0.3));
        var geo = GEO !== null ? GEO.buildGeometry(node.icon) : null;
        var wob = glyphWobble(node.icon, t);

        drawRoleMarks(node, box, t, p);

        ctx.save();
        ctx.translate(0, box.iconCy);
        if (wob.rot) {
            ctx.rotate(wob.rot);
        }
        if (wob.dy) {
            ctx.translate(0, wob.dy);
        }
        if (wob.scale) {
            ctx.scale(wob.scale, wob.scale);
        }
        if (wob.alpha !== undefined) {
            ctx.globalAlpha = ctx.globalAlpha * wob.alpha;
        }
        ctx.strokeStyle = INK;

        var flagKind = WAVE_FLAGS[node.icon];
        if (flagKind !== undefined) {
            drawWavyFlag(flagKind, t, box.iconSize);
        } else {
            var k = box.iconSize / 24;
            ctx.save();
            if (geo && geo.bbox) {
                ctx.translate(-geo.bbox.cx * k, -geo.bbox.cy * k);
            }
            drawIcon(geo, box.iconSize, p * 1.05);
            ctx.restore();
            if (geo && geo.bbox) {
                ctx.save();
                ctx.translate(-geo.bbox.cx * k, -geo.bbox.cy * k);
                ctx.scale(k, k);
                ctx.globalAlpha = ctx.globalAlpha * ambientAlpha(p);
                drawAmbient(node.icon, t);
                ctx.restore();
            }
        }
        ctx.restore();

        if (state.beat !== 'stat' && textAlpha > 0 && node.stat) {
            ctx.save();
            ctx.globalAlpha = node.alpha * fade * textAlpha;
            ctx.font = '700 ' + box.statFont + 'px "IBM Plex Mono", monospace';
            ctx.fillStyle = INK;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(node.stat, 0, box.statY + (1 - textAlpha) * 6);
            ctx.restore();
        }

        if (textAlpha > 0 && box.lines.length > 0) {
            ctx.save();
            ctx.globalAlpha = node.alpha * fade * textAlpha;
            ctx.font = '600 18px "Archivo", sans-serif';
            ctx.fillStyle = '#3f3f46';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (var li = 0; li < box.lines.length; li++) {
                ctx.fillText(box.lines[li], 0, box.labelY + li * 25);
            }
            ctx.restore();
        }
        ctx.restore();
    }

    // Faint drifting clouds (and a sun for outdoor scenes) behind the
    // doodles — only for travel/nature subjects, so business slides stay
    // clean.
    var OUTDOOR_ICONS = {
        airplane: 1, train: 1, cloud: 1, globe: 1, route: 1, 'map-pin': 1,
        village: 1, house: 1, flag: 1, 'flag-germany': 1, 'flag-japan': 1,
        'flag-indonesia': 1
    };

    function drawSkyDoodles(t) {
        if (state.nodes.length === 0) {
            return;
        }
        var outdoor = false;
        var sunny = false;
        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        for (var i = 0; i < state.nodes.length; i++) {
            var nd = state.nodes[i];
            if (OUTDOOR_ICONS[nd.icon]) {
                outdoor = true;
            }
            if (nd.icon === 'village' || nd.icon === 'house') {
                sunny = true;
            }
            var ext = nodeExtents(nd);
            minX = Math.min(minX, nd.x - ext.rx);
            maxX = Math.max(maxX, nd.x + ext.rx);
            minY = Math.min(minY, nd.y - ext.ry);
            maxY = Math.max(maxY, nd.y + ext.ry);
        }
        if (!outdoor) {
            return;
        }
        ctx.save();
        ctx.strokeStyle = INK_SOFT;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.14;
        var midX = (minX + maxX) / 2;
        var span = Math.max(400, maxX - minX);
        for (var c = 0; c < 3; c++) {
            var cx = midX + Math.sin(t * 0.07 + c * 2.1) * (span / 2.3);
            var cy = minY - 34 - c * 24;
            var cw = 26 + c * 7;
            ctx.beginPath();
            ctx.moveTo(cx - cw / 2, cy);
            ctx.arc(cx - cw * 0.18, cy, cw * 0.2, Math.PI, 0, false);
            ctx.arc(cx + cw * 0.16, cy - cw * 0.08, cw * 0.24, Math.PI * 1.05, 0.1, false);
            ctx.lineTo(cx + cw / 2, cy);
            ctx.stroke();
        }
        if (sunny) {
            var sx = maxX + 30;
            var sy = minY - 60;
            ctx.beginPath();
            ctx.arc(sx, sy, 14, 0, Math.PI * 2);
            ctx.stroke();
            for (var r = 0; r < 8; r++) {
                var ra = t * 0.15 + r * Math.PI / 4;
                ctx.beginPath();
                ctx.moveTo(sx + 19 * Math.cos(ra), sy + 19 * Math.sin(ra));
                ctx.lineTo(sx + 25 * Math.cos(ra), sy + 25 * Math.sin(ra));
                ctx.stroke();
            }
        }
        // Layered hills under the scene so outdoor stories sit on a landscape.
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 1.5;
        var ground = maxY + 28;
        ctx.beginPath();
        ctx.moveTo(minX - 120, ground + 36);
        ctx.quadraticCurveTo(midX - span * 0.22, ground - 46, midX, ground + 8);
        ctx.quadraticCurveTo(midX + span * 0.28, ground + 54, maxX + 140, ground - 10);
        ctx.stroke();
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(minX - 40, ground + 18);
        ctx.quadraticCurveTo(midX + 20, ground - 18, maxX + 60, ground + 26);
        ctx.stroke();
        ctx.restore();
    }

    function nodeBob(node, now) {
        return Math.sin(now / 1000 * 1.2 + (node.phase || 0)) * 3;
    }

    function iconAnchor(node, now) {
        var box = node.box;
        var cy = box ? box.iconCy : 0;
        return {
            x: node.x,
            y: node.y + nodeBob(node, now) + cy * (node.scale || 1)
        };
    }

    function quadPoint(a, c, b, u) {
        var inv = 1 - u;
        return {
            x: inv * inv * a.x + 2 * inv * u * c.x + u * u * b.x,
            y: inv * inv * a.y + 2 * inv * u * c.y + u * u * b.y
        };
    }

    function linkEnds(a, b, padA, padB) {
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var len = Math.hypot(dx, dy) || 1;
        var ux = dx / len;
        var uy = dy / len;
        var usedA = Math.min(padA, len * 0.42);
        var usedB = Math.min(padB, len * 0.42);
        return {
            a: { x: a.x + ux * usedA, y: a.y + uy * usedA },
            b: { x: b.x - ux * usedB, y: b.y - uy * usedB },
            len: len
        };
    }

    function storyBow(a, b, amount) {
        var mx = (a.x + b.x) / 2;
        var my = (a.y + b.y) / 2;
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var len = Math.hypot(dx, dy) || 1;
        var px = -dy / len * amount;
        var py = dx / len * amount;
        if (amount > 0 && py > 0) {
            px = -px;
            py = -py;
        }
        return { x: mx + px, y: my + py };
    }

    function drawChevron(x, y, ang) {
        var s = 8;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang - 0.55) * s, y - Math.sin(ang - 0.55) * s);
        ctx.lineTo(x, y);
        ctx.lineTo(x - Math.cos(ang + 0.55) * s, y - Math.sin(ang + 0.55) * s);
        ctx.stroke();
    }

    function drawStoryArc(a, b, bow, travel, withChevron) {
        var ends = linkEnds(a, b, 78, 78);
        if (ends.len < 96) {
            return;
        }
        var ctrl = storyBow(ends.a, ends.b, bow);
        var dash = ctx.getLineDash();
        var dashOffset = ctx.lineDashOffset;
        ctx.save();
        ctx.globalAlpha = ctx.globalAlpha * 0.35;
        ctx.lineWidth = ctx.lineWidth + 2.4;
        ctx.beginPath();
        ctx.moveTo(ends.a.x, ends.a.y + 6);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y + 6, ends.b.x, ends.b.y + 6);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.moveTo(ends.a.x, ends.a.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, ends.b.x, ends.b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        var bead = quadPoint(ends.a, ctrl, ends.b, travel);
        ctx.beginPath();
        ctx.arc(bead.x, bead.y, 3.1, 0, Math.PI * 2);
        ctx.stroke();
        if (withChevron) {
            var prev = quadPoint(ends.a, ctrl, ends.b, 0.92);
            var ang = Math.atan2(ends.b.y - prev.y, ends.b.x - prev.x);
            drawChevron(ends.b.x, ends.b.y, ang);
        }
        ctx.setLineDash(dash);
        ctx.lineDashOffset = dashOffset;
    }

    // One connected picture: a traveling ribbon for a flow, curved spokes
    // for a hub, and a bridged pair of stages for a comparison.
    function drawStoryLinks(now) {
        var nodes = state.nodes;
        if (nodes.length < 2) {
            return;
        }
        var t = now / 1000;
        var anchors = [];
        var i;
        for (i = 0; i < nodes.length; i++) {
            anchors.push(iconAnchor(nodes[i], now));
        }
        ctx.save();
        ctx.strokeStyle = INK;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.65;
        ctx.globalAlpha = 0.72;
        ctx.setLineDash([1.2, 7]);
        ctx.lineDashOffset = -t * 36;

        if (state.layout === 'hub_spoke') {
            for (i = 1; i < anchors.length; i++) {
                var bow = (i % 2 === 0 ? 1 : -1) * 42;
                drawStoryArc(anchors[0], anchors[i], bow, (t * 0.22 + i * 0.18) % 1, true);
            }
        } else if (state.layout === 'comparison') {
            ctx.setLineDash([]);
            if (nodes.length === 4) {
                drawStoryArc(anchors[0], anchors[1], 28, (t * 0.2) % 1, false);
                drawStoryArc(anchors[2], anchors[3], 28, (t * 0.2 + 0.3) % 1, false);
            } else if (nodes.length === 3) {
                drawStoryArc(anchors[1], anchors[2], 36, (t * 0.2) % 1, false);
            }
            var left = anchors[0];
            var right = anchors[anchors.length - 1];
            if (nodes.length === 3) {
                right = {
                    x: (anchors[1].x + anchors[2].x) / 2,
                    y: (anchors[1].y + anchors[2].y) / 2
                };
            } else if (nodes.length === 4) {
                left = {
                    x: (anchors[0].x + anchors[1].x) / 2,
                    y: (anchors[0].y + anchors[1].y) / 2
                };
                right = {
                    x: (anchors[2].x + anchors[3].x) / 2,
                    y: (anchors[2].y + anchors[3].y) / 2
                };
            }
            ctx.setLineDash([1.2, 7]);
            drawStoryArc(left, right, 56, (t * 0.18) % 1, false);
            ctx.setLineDash([]);
            var mx = (left.x + right.x) / 2;
            var my = (left.y + right.y) / 2 - 18;
            ctx.globalAlpha = 0.9 * Math.max(0.35, state.dividerAlpha);
            ctx.beginPath();
            ctx.arc(mx, my, 20, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = ctx.globalAlpha * 0.45;
            ctx.beginPath();
            ctx.arc(mx + 3, my + 3, 26, 0.3, Math.PI * 1.75);
            ctx.stroke();
            ctx.globalAlpha = 0.95 * Math.max(0.35, state.dividerAlpha);
            ctx.font = '700 12px "IBM Plex Mono", monospace';
            ctx.fillStyle = INK;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('VS', mx, my + 0.5);
        } else {
            for (i = 0; i < anchors.length - 1; i++) {
                var travel = (t * 0.28 + i * 0.17) % 1;
                drawStoryArc(anchors[i], anchors[i + 1], 54, travel, true);
            }
        }
        ctx.restore();
    }

    function wrapLines(text, maxW, maxLines) {
        var words = String(text || '').split(/\s+/);
        var lines = [];
        var line = '';
        var i;
        for (i = 0; i < words.length; i++) {
            if (words[i] === '') {
                continue;
            }
            var candidate = line === '' ? words[i] : line + ' ' + words[i];
            if (ctx.measureText(candidate).width > maxW && line !== '') {
                lines.push(line);
                line = words[i];
                if (lines.length >= maxLines - 1) {
                    line = words.slice(i).join(' ');
                    break;
                }
            } else {
                line = candidate;
            }
        }
        if (line !== '') {
            lines.push(line);
        }
        return lines.slice(0, maxLines);
    }

    function fillTracked(text, x, y, gap) {
        var chars = String(text || '').split('');
        var total = 0;
        var widths = [];
        var i;
        for (i = 0; i < chars.length; i++) {
            var w = ctx.measureText(chars[i]).width;
            widths.push(w);
            total += w;
            if (i < chars.length - 1) {
                total += gap;
            }
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        var cursor = x - total / 2;
        for (i = 0; i < chars.length; i++) {
            ctx.fillText(chars[i], cursor, y);
            cursor += widths[i] + gap;
        }
    }

    function headlineSize(text) {
        var n = String(text || '').length;
        if (n <= 18) {
            return 72;
        }
        if (n <= 34) {
            return 56;
        }
        if (n <= 52) {
            return 44;
        }
        return 36;
    }

    function drawCopyBlock(x, y, maxW, align, size) {
        var kicker = (state.kicker || '').toUpperCase();
        ctx.fillStyle = INK_MUTE;
        ctx.font = '600 13px "IBM Plex Mono", monospace';
        if (align === 'center') {
            fillTracked(kicker, x, y - 46, 3.4);
            ctx.strokeStyle = INK;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x - 54, y - 16);
            ctx.lineTo(x + 54, y - 16);
            ctx.stroke();
        } else {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(kicker, x, y - 46);
            ctx.strokeStyle = INK;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x, y - 16);
            ctx.lineTo(x + 64, y - 16);
            ctx.stroke();
        }
        ctx.fillStyle = INK;
        ctx.font = '700 ' + size + 'px "Archivo", sans-serif';
        var lines = wrapLines(state.headline || '', maxW, 3);
        var lineH = Math.round(size * 1.14);
        ctx.textBaseline = 'top';
        for (var i = 0; i < lines.length; i++) {
            ctx.textAlign = align === 'center' ? 'center' : 'left';
            ctx.fillText(lines[i], x, y + i * lineH);
        }
    }

    function drawStatBlock(rise) {
        var num = state.heroStat || '';
        var size = 140;
        ctx.font = '700 ' + size + 'px "IBM Plex Mono", monospace';
        while (size > 68 && ctx.measureText(num).width > 700) {
            size -= 6;
            ctx.font = '700 ' + size + 'px "IBM Plex Mono", monospace';
        }
        ctx.fillStyle = INK_MUTE;
        ctx.font = '600 13px "IBM Plex Mono", monospace';
        fillTracked((state.kicker || 'Angka').toUpperCase(), 0, -size * 0.62 + rise, 3.2);
        ctx.fillStyle = INK;
        ctx.font = '700 ' + size + 'px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(num, 0, 8 + rise);
        ctx.font = '600 26px "Archivo", sans-serif';
        ctx.textBaseline = 'top';
        var lines = wrapLines(state.headline || '', 640, 2);
        for (var i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 0, size * 0.46 + i * 34 + rise);
        }
    }

    function drawDuoRule() {
        ctx.save();
        ctx.strokeStyle = '#d4d4d8';
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(20, -160);
        ctx.lineTo(20, 180);
        ctx.stroke();
        ctx.restore();
    }

    function drawTypeLayer(now) {
        if (state.beat !== 'poster' && state.beat !== 'stat' && state.beat !== 'duo') {
            return;
        }
        if (state.headline === '' && state.heroStat === '') {
            return;
        }
        var p = Math.max(0, Math.min(1, (now - (state.typeBorn || now)) / 460));
        var rise = (1 - easeOutCubic(p)) * 18;
        ctx.save();
        ctx.globalAlpha = 0.2 + 0.8 * easeOutCubic(p);
        if (state.beat === 'stat') {
            drawStatBlock(rise);
        } else if (state.beat === 'duo') {
            drawCopyBlock(-580, -10 + rise, 460, 'left', 42);
        } else {
            drawCopyBlock(0, -8 + rise, 860, 'center', headlineSize(state.headline));
        }
        ctx.restore();
    }

    var lastFrame = performance.now();
    var frameErrors = 0;

    // The render loop is crash-proof: one bad frame must never freeze the
    // canvas silently. Errors surface as a toast + console entry instead.
    function frame(now) {
        try {
            renderFrame(now);
        } catch (err) {
            frameErrors = frameErrors + 1;
            console.error('[sketchtalk] render error:', err);
            if (frameErrors === 1) {
                toast('Error render: ' + (err && err.message ? err.message : err));
            }
        }
        requestAnimationFrame(frame);
    }

    function renderFrame(now) {
        var dt = Math.min(0.05, (now - lastFrame) / 1000);
        lastFrame = now;

        cam.x += (cam.tx - cam.x) * Math.min(1, dt * 9);
        cam.y += (cam.ty - cam.y) * Math.min(1, dt * 9);
        cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 9);

        var wantDivider = state.beat === 'scene' && state.layout === 'comparison' && state.nodes.length >= 2 ? 1 : 0;
        state.dividerAlpha += (wantDivider - state.dividerAlpha) * Math.min(1, dt * 6);

        ctx.clearRect(0, 0, viewW, viewH);
        ctx.save();
        ctx.translate(cam.x, cam.y);
        ctx.scale(cam.zoom, cam.zoom);

        for (var i = 0; i < state.nodes.length; i++) {
            var nd = state.nodes[i];
            var k = Math.min(1, dt * 7);
            nd.x += (nd.tx - nd.x) * k;
            nd.y += (nd.ty - nd.y) * k;
            nd.scale += (nd.tScale - nd.scale) * Math.min(1, dt * 6);
            nd.alpha += (nd.tAlpha - nd.alpha) * Math.min(1, dt * 6);
        }
        var showPictures = state.beat !== 'poster';
        if (showPictures && state.beat === 'scene') {
            drawSkyDoodles(now / 1000);
            drawStoryLinks(now);
        }
        if (state.beat === 'duo') {
            drawDuoRule();
        }
        if (showPictures) {
            for (var n = 0; n < state.nodes.length; n++) {
                drawNode(state.nodes[n], now);
            }
        }
        drawTypeLayer(now);
        for (var d = state.dying.length - 1; d >= 0; d--) {
            var dead = state.dying[d];
            dead.alpha -= dt * 4.2;
            dead.x += (dead.tx - dead.x) * Math.min(1, dt * 4);
            dead.y += (dead.ty - dead.y) * Math.min(1, dt * 4);
            if (dead.alpha <= 0) {
                state.dying.splice(d, 1);
                updateEmptyState();
            } else {
                drawNode(dead, now);
            }
        }

        ctx.restore();
    }

    // ------------------------------------------------------------------
    // 8. Speech recognition — continuous sketching
    // ------------------------------------------------------------------
    function setPaused(paused) {
        state.paused = paused;
        pausedEl.style.display = paused ? 'flex' : 'none';
        if (paused) {
            toast('Sistem dijeda — ucapkan "LANJUTKAN"');
        } else {
            toast('Sistem dilanjutkan');
        }
    }

    function initRecognition() {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            return null;
        }
        var recog = new SR();
        recog.continuous = true;
        recog.interimResults = true;
        recog.lang = currentLang;

        recog.onstart = function () {
            isListening = true;
            micBtn.classList.add('on');
            interimEl.textContent = currentLang === 'id-ID' ? 'Mendengarkan… silakan bicara' : 'Listening… speak now';
        };
        recog.onresult = function (event) {
            var interim = '';
            var finalText = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                var transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalText += transcript;
                } else {
                    interim += transcript;
                }
            }
            if (interim.trim() !== '') {
                interimEl.textContent = '"' + interim.trim() + '…"';
                onSpeech(interim.trim(), false);
            }
            if (finalText.trim() !== '') {
                interimEl.textContent = '✓ "' + finalText.trim() + '"';
                onSpeech(finalText.trim(), true);
            }
        };
        recog.onerror = function (event) {
            if (event.error === 'not-allowed') {
                toast('Izin mikrofon ditolak — gunakan kotak teks');
                stopListening();
            } else if (event.error !== 'no-speech') {
                interimEl.textContent = 'mic: ' + event.error;
            }
        };
        recog.onend = function () {
            if (isListening) {
                try {
                    recog.start();
                } catch (err) {
                    stopListening();
                }
            }
        };
        return recog;
    }

    function detectSpeechSupport() {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        var ua = navigator.userAgent || '';
        var isFirefox = /firefox/i.test(ua) && !/seamonkey/i.test(ua);
        return { supported: !!SR, firefox: isFirefox };
    }

    var speechCaps = { supported: true, firefox: false };

    function markMicUnsupported() {
        micBtn.classList.add('off');
        micBtn.title = 'Input suara tidak tersedia di browser ini';
        if (speechCaps.firefox) {
            interimEl.textContent = 'Firefox tidak mendukung input suara (Web Speech API). Buka di Chrome / Edge untuk bicara — atau ketik di bawah.';
            toast('Buka di Chrome / Edge untuk input suara');
        } else {
            interimEl.textContent = 'Browser ini tidak mendukung Web Speech API — gunakan kotak teks di bawah';
            toast('Browser tidak mendukung input suara — gunakan teks');
        }
    }

    function startListening() {
        if (!speechCaps.supported) {
            markMicUnsupported();
            return;
        }
        if (recognition === null) {
            recognition = initRecognition();
        }
        if (recognition === null) {
            speechCaps.supported = false;
            markMicUnsupported();
            return;
        }
        recognition.lang = currentLang;
        try {
            recognition.start();
        } catch (err) {
            // already started
        }
    }

    function stopListening() {
        isListening = false;
        micBtn.classList.remove('on');
        interimEl.textContent = 'Mikrofon dijeda';
        if (recognition !== null) {
            try {
                recognition.stop();
            } catch (err) {
            }
        }
    }

    micBtn.addEventListener('click', function () {
        if (isListening) {
            stopListening();
        } else {
            startListening();
        }
    });

    langBtn.addEventListener('click', function () {
        currentLang = currentLang === 'id-ID' ? 'en-US' : 'id-ID';
        langBtn.textContent = currentLang === 'id-ID' ? 'ID' : 'EN';
        toast('Bahasa suara: ' + (currentLang === 'id-ID' ? 'Indonesia' : 'English'));
        if (isListening) {
            stopListening();
            setTimeout(startListening, 250);
        }
    });

    // ------------------------------------------------------------------
    // 9. Continuous pipeline
    //    interim (partial) -> debounced preview requests
    //    final              -> authoritative commit
    //    stale responses are dropped by sequence number
    // ------------------------------------------------------------------
    var RE_PAUSE = /\b(berhenti|stop|pause)\b/i;
    var RE_RESUME = /\b(lanjut(?:kan)?|continue|resume)\b/i;
    var RE_CLEAR = /(hapus layar|bersihkan layar|slide baru|halaman baru|mulai dari awal|clear screen|new slide|reset canvas)/i;

    function onSpeech(text, isFinal) {
        if (state.paused) {
            if (RE_RESUME.test(text)) {
                setPaused(false);
            }
            return;
        }
        if (!isFinal) {
            var now = performance.now();
            if (now - lastPreviewAt < 950) {
                return;
            }
            if (text === lastPreviewText) {
                return;
            }
            lastPreviewAt = now;
            lastPreviewText = text;
            sendToServer(text, true);
        } else {
            if (text === lastPreviewText && text === lastAppliedPreviewText) {
                // The final is exactly what the preview already rendered:
                // skip the redundant AI call entirely.
                console.log('[sketchtalk] final identical to rendered preview - request skipped');
                return;
            }
            sendToServer(text, false);
        }
    }

    function canvasObjects() {
        return state.nodes.slice(0, 4).map(function (nd) {
            return {
                id: nd.id,
                icon: nd.icon,
                label: nd.label,
                highlight_stat: nd.stat
            };
        });
    }

    function sendToServer(text, partial) {
        // Local fast paths (also enforced server-side).
        if (RE_PAUSE.test(text)) {
            setPaused(true);
            return;
        }
        if (RE_CLEAR.test(text)) {
            clearCanvas(true);
            return;
        }

        var seq = ++seqCounter;
        var aiSeq = partial ? ++seqCounter : seq;

        function doPost(payloadSeq, instant) {
            var payload = {
                transcript: text,
                lang: currentLang,
                is_paused: state.paused,
                partial: partial,
                instant: instant === true,
                room: CFG.room || '',
                source: SOURCE_ID,
                seq: payloadSeq,
                canvas_objects: canvasObjects(),
                slide: {
                    beat: state.beat,
                    kicker: state.kicker,
                    headline: state.headline
                }
            };
            var body = new URLSearchParams();
            body.set('csrf_token', CFG.csrfToken || '');
            body.set('payload', JSON.stringify(payload));
            inFlight++;
            return fetch(CFG.interpretUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });
        }

        console.log('[sketchtalk] ->', partial ? 'partial' : 'final', 'seq' + seq, '"' + text + '"');
        if (partial) {
            // Optimistic instant preview: the local engine answers in
            // milliseconds and paints a provisional card; the AI result
            // (higher seq) replaces it when it arrives.
            doPost(seq, true)
                .then(function (res) { return res.json(); })
                .then(function (result) {
                    if (typeof result.seq === 'number' && result.seq < latestAppliedSeq) {
                        return;
                    }
                    if (result.status === 'SUCCESS' && result.directive && result.directive.action !== 'IGNORE') {
                        if (typeof result.seq === 'number') {
                            latestAppliedSeq = Math.max(latestAppliedSeq, result.seq);
                        }
                        applyDirective(result.directive, { partial: true });
                        console.log('[sketchtalk] instant preview applied (' + Math.round(performance.now()) + 'ms)');
                    }
                })
                .catch(function () { });
        }
        sendRequest();
        function sendRequest() {
            doPost(aiSeq, false)
                .then(function (res) {
                    if (!res.ok) {
                        throw new Error('http ' + res.status);
                    }
                    return res.json();
                })
                .then(function (result) {
                    console.log('[sketchtalk] <-', result.engine, result.directive && result.directive.action, 'seq' + result.seq);
                    // Drop anything older than what is already on screen.
                    if (typeof result.seq === 'number' && result.seq < latestAppliedSeq) {
                        console.log('[sketchtalk] dropping stale response seq' + result.seq);
                        return;
                    }
                    if (result.status === 'SUCCESS' && result.directive) {
                        if (typeof result.seq === 'number') {
                            latestAppliedSeq = Math.max(latestAppliedSeq, result.seq);
                        }
                        if (typeof result.room_seq === 'number') {
                            lastRoomSeq = Math.max(lastRoomSeq, result.room_seq);
                        }
                        if (result.engine && !result.instant) {
                            setEngineBadge(result.engine);
                        }
                        if (result.directive.action === 'IGNORE') {
                            var heard = text.length > 44 ? text.slice(0, 44) + '…' : text;
                            interimEl.textContent = '· didengar, belum ada gagasan visual: "' + heard + '" ·';
                        }
                        if (partial) {
                            lastAppliedPreviewText = text;
                        }
                        applyDirective(result.directive, { partial: partial });
                    } else if (!partial) {
                        toast((result && result.desc) ? result.desc : 'Respons tidak valid');
                    }
                })
                .catch(function (err) {
                    console.warn('[sketchtalk] request failed:', err);
                    if (!partial) {
                        toast('Gagal menghubungi server — coba lagi');
                    }
                })
                .then(function () {
                    inFlight--;
                });
        }
    }

    formEl.addEventListener('submit', function (e) {
        e.preventDefault();
        var val = inputEl.value.trim();
        if (val === '') {
            return;
        }
        interimEl.textContent = '✓ "' + val + '"';
        inputEl.value = '';
        onSpeech(val, true);
    });

    sendBtn.addEventListener('click', function () {
        var val = inputEl.value.trim();
        if (val === '') {
            return;
        }
        interimEl.textContent = '✓ "' + val + '"';
        inputEl.value = '';
        onSpeech(val, true);
    });

    document.querySelectorAll('.sk-sample').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var text = btn.getAttribute('data-text') || '';
            interimEl.textContent = '✓ "' + text + '"';
            onSpeech(text, true);
        });
    });

    // ------------------------------------------------------------------
    // 10. Toolbar actions
    // ------------------------------------------------------------------
    document.getElementById('sk-grid-btn').addEventListener('click', function () {
        showGrid = !showGrid;
        stage.classList.toggle('sk-dotgrid', showGrid);
    });

    document.getElementById('sk-fit-btn').addEventListener('click', function () {
        autofit();
        toast('Tampilan dipusatkan');
    });

    document.getElementById('sk-undo-btn').addEventListener('click', undo);

    document.getElementById('sk-clear-btn').addEventListener('click', function () {
        clearCanvas(true);
    });

    // Copy the exact mic URL so the second device never types a room code.
    document.getElementById('sk-copy-mic').addEventListener('click', function () {
        var micLink = document.getElementById('sk-mic-link');
        var micUrl = location.origin + (micLink ? micLink.getAttribute('href') : '/mic');
        function done() {
            toast('Tautan mic disalin — buka di perangkat lain: ' + micUrl);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(micUrl).then(done, function () { fallbackCopy(micUrl); done(); });
        } else {
            fallbackCopy(micUrl);
            done();
        }
    });

    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
        } catch (err) {
        }
        document.body.removeChild(ta);
    }

    document.getElementById('sk-export-btn').addEventListener('click', function () {
        if (state.nodes.length === 0) {
            toast('Kanvas masih kosong');
            return;
        }
        var exportCanvas = document.createElement('canvas');
        exportCanvas.width = canvas.width;
        exportCanvas.height = canvas.height;
        var ectx = exportCanvas.getContext('2d');
        ectx.fillStyle = '#ffffff';
        ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        ectx.drawImage(canvas, 0, 0);
        var link = document.createElement('a');
        link.download = 'sketchtalk-' + Date.now() + '.png';
        link.href = exportCanvas.toDataURL('image/png');
        link.click();
        toast('Gambar PNG diunduh');
    });

    // ------------------------------------------------------------------
    // 11. Boot
    // ------------------------------------------------------------------
    window.addEventListener('error', function (e) {
        console.error('[sketchtalk] page error:', e.message);
        toast('Error: ' + e.message);
    });
    if (GEO === null) {
        interimEl.textContent = 'Library ikon gagal dimuat — hard reload (Ctrl+Shift+R)';
        toast('sketchtalk-icons.js gagal dimuat — Ctrl+Shift+R');
    }
    // Room sync: apply directives pushed by OTHER sources (e.g. the mic
    // page). Own pushes are already applied locally and skipped by the
    // source check + room_seq echo.
    function pollRoom() {
        if (!CFG.stateUrl) {
            return;
        }
        fetch(CFG.stateUrl + '?since=' + lastRoomSeq)
            .then(function (res) { return res.json(); })
            .then(function (st) {
                if (st && st.directive && typeof st.seq === 'number' && st.seq > lastRoomSeq && st.source !== SOURCE_ID) {
                    lastRoomSeq = st.seq;
                    applyDirective(st.directive, { partial: st.partial === true });
                }
            })
            .catch(function () { });
    }
    setInterval(pollRoom, 450);

    setEngineBadge(CFG.aiEnabled ? (CFG.aiProvider === 'anthropic' ? 'claude' : CFG.aiProvider) : 'fallback');
    speechCaps = detectSpeechSupport();
    if (window.isSecureContext === false) {
        micBtn.classList.add('off');
        micBtn.title = 'Mikrofon diblokir di http:// non-localhost';
        interimEl.textContent = 'Mikrofon diblokir browser di alamat http:// ini (hanya localhost/https yang diizinkan) — ketik di bawah, atau buka via https://';
    } else if (!speechCaps.supported) {
        markMicUnsupported();
    }
    // end if
    resize();
    requestAnimationFrame(frame);
    // Re-measure all node boxes once webfonts are ready.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
            for (var i = 0; i < state.nodes.length; i++) {
                layoutNodeBox(state.nodes[i]);
            }
        });
    }
})();
