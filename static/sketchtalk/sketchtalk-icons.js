/* =========================================================================
 * SketchTalk icon library — hand-authored minimalist line icons.
 * =========================================================================
 * Original bezier icons drawn in a 24x24 coordinate space, stroked at
 * width 2 with round caps/joins (pure Canvas 2D — no icon font, no SVG
 * files, no network fetch; icons are available instantly).
 *
 * This file is DOM-free on purpose: it also loads under Node.js so the
 * icon set can be validated by a script (parse every path, verify the
 * bounding box and total length).
 *
 * ADDING ICONS: just add a new entry to ICONS below and reload — the
 * server derives its whitelist automatically from this file, so new
 * icons are instantly available to the Visual Director. Icons the model
 * asks for that do NOT exist here are reported in
 * training-model-folder/missing-icons/ (they render as sticky-note on
 * screen until you draw them).
 * ========================================================================= */
(function () {
    'use strict';

    var NUM_RE = /-?\d*\.?\d+(?:[eE][+-]?\d+)?/g;

    function tokenizeNumbers(str) {
        var out = [];
        var m = null;
        NUM_RE.lastIndex = 0;
        while ((m = NUM_RE.exec(str)) !== null) {
            out.push(parseFloat(m[0]));
        }
        return out;
    }

    // W3C endpoint-to-center arc parameterization, sampled as a polyline.
    function sampleArc(pts, x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
        if (rx === 0 || ry === 0) {
            pts.push(x2, y2);
            return;
        }
        var phi = phiDeg * Math.PI / 180;
        var cosp = Math.cos(phi);
        var sinp = Math.sin(phi);
        var dx = (x1 - x2) / 2;
        var dy = (y1 - y2) / 2;
        var x1p = cosp * dx + sinp * dy;
        var y1p = -sinp * dx + cosp * dy;
        var lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lambda > 1) {
            var s = Math.sqrt(lambda);
            rx *= s;
            ry *= s;
        }
        var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        var den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        var co = Math.sqrt(Math.max(0, num / den));
        if (largeArc === sweep) {
            co = -co;
        }
        var cxp = co * rx * y1p / ry;
        var cyp = -co * ry * x1p / rx;
        var cx = cxp * cosp - cyp * sinp + (x1 + x2) / 2;
        var cy = cxp * sinp + cyp * cosp + (y1 + y2) / 2;
        var th1 = Math.atan2((y1 - cy) / ry, (x1 - cx) / rx);
        var th2 = Math.atan2((y2 - cy) / ry, (x2 - cx) / rx);
        var dth = th2 - th1;
        if (!sweep && dth > 0) {
            dth -= 2 * Math.PI;
        }
        if (sweep && dth < 0) {
            dth += 2 * Math.PI;
        }
        var steps = Math.max(4, Math.ceil(Math.abs(dth) / (Math.PI / 12)));
        for (var i = 1; i <= steps; i++) {
            var t = i / steps;
            var th = th1 + dth * t;
            pts.push(
                cx + rx * Math.cos(th) * cosp - ry * Math.sin(th) * sinp,
                cy + rx * Math.cos(th) * sinp + ry * Math.sin(th) * cosp
            );
        }
    }

    // Full SVG path-data parser -> array of subpaths [{pts: [x,y,...]}].
    // Supports M m L l H h V v C c S s Q q T t A a Z z.
    function parsePathD(d) {
        var subpaths = [];
        var cur = null;
        var cx = 0;
        var cy = 0;
        var startX = 0;
        var startY = 0;
        var lastC2x = null;
        var lastC2y = null;
        var lastQx = null;
        var lastQy = null;

        var cmdRe = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
        var match = null;
        while ((match = cmdRe.exec(d)) !== null) {
            var cmd = match[1];
            var args = tokenizeNumbers(match[2]);
            var i = 0;
            while (i < args.length || cmd === 'Z' || cmd === 'z') {
                var rel = (cmd === cmd.toLowerCase()) && cmd !== 'z';
                switch (cmd) {
                    case 'M':
                    case 'm': {
                        var nx = args[i] + (rel ? cx : 0);
                        var ny = args[i + 1] + (rel ? cy : 0);
                        cx = nx;
                        cy = ny;
                        startX = nx;
                        startY = ny;
                        cur = [nx, ny];
                        subpaths.push({ pts: cur });
                        lastC2x = null;
                        lastQx = null;
                        i += 2;
                        cmd = cmd === 'M' ? 'L' : 'l';
                        break;
                    }
                    case 'L':
                    case 'l': {
                        var lx = args[i] + (rel ? cx : 0);
                        var ly = args[i + 1] + (rel ? cy : 0);
                        cur.push(lx, ly);
                        cx = lx;
                        cy = ly;
                        lastC2x = null;
                        lastQx = null;
                        i += 2;
                        break;
                    }
                    case 'H':
                    case 'h': {
                        var hx = args[i] + (rel ? cx : 0);
                        cur.push(hx, cy);
                        cx = hx;
                        i += 1;
                        break;
                    }
                    case 'V':
                    case 'v': {
                        var vy = args[i] + (rel ? cy : 0);
                        cur.push(cx, vy);
                        cy = vy;
                        i += 1;
                        break;
                    }
                    case 'C':
                    case 'c': {
                        var x1 = args[i] + (rel ? cx : 0);
                        var y1 = args[i + 1] + (rel ? cy : 0);
                        var x2 = args[i + 2] + (rel ? cx : 0);
                        var y2 = args[i + 3] + (rel ? cy : 0);
                        var x3 = args[i + 4] + (rel ? cx : 0);
                        var y3 = args[i + 5] + (rel ? cy : 0);
                        for (var s = 1; s <= 14; s++) {
                            var t = s / 14;
                            var mt = 1 - t;
                            cur.push(
                                mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
                                mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
                            );
                        }
                        lastC2x = x2;
                        lastC2y = y2;
                        cx = x3;
                        cy = y3;
                        lastQx = null;
                        i += 6;
                        break;
                    }
                    case 'S':
                    case 's': {
                        var sx1 = (lastC2x !== null) ? 2 * cx - lastC2x : cx;
                        var sy1 = (lastC2y !== null) ? 2 * cy - lastC2y : cy;
                        var sx2 = args[i] + (rel ? cx : 0);
                        var sy2 = args[i + 1] + (rel ? cy : 0);
                        var sx3 = args[i + 2] + (rel ? cx : 0);
                        var sy3 = args[i + 3] + (rel ? cy : 0);
                        for (var s2 = 1; s2 <= 14; s2++) {
                            var t2 = s2 / 14;
                            var mt2 = 1 - t2;
                            cur.push(
                                mt2 * mt2 * mt2 * cx + 3 * mt2 * mt2 * t2 * sx1 + 3 * mt2 * t2 * t2 * sx2 + t2 * t2 * t2 * sx3,
                                mt2 * mt2 * mt2 * cy + 3 * mt2 * mt2 * t2 * sy1 + 3 * mt2 * t2 * t2 * sy2 + t2 * t2 * t2 * sy3
                            );
                        }
                        lastC2x = sx2;
                        lastC2y = sy2;
                        cx = sx3;
                        cy = sy3;
                        i += 4;
                        break;
                    }
                    case 'Q':
                    case 'q': {
                        var qx1 = args[i] + (rel ? cx : 0);
                        var qy1 = args[i + 1] + (rel ? cy : 0);
                        var qx2 = args[i + 2] + (rel ? cx : 0);
                        var qy2 = args[i + 3] + (rel ? cy : 0);
                        for (var s3 = 1; s3 <= 12; s3++) {
                            var t3 = s3 / 12;
                            var mt3 = 1 - t3;
                            cur.push(
                                mt3 * mt3 * cx + 2 * mt3 * t3 * qx1 + t3 * t3 * qx2,
                                mt3 * mt3 * cy + 2 * mt3 * t3 * qy1 + t3 * t3 * qy2
                            );
                        }
                        lastQx = qx1;
                        lastQy = qy1;
                        cx = qx2;
                        cy = qy2;
                        lastC2x = null;
                        i += 4;
                        break;
                    }
                    case 'T':
                    case 't': {
                        var tx1 = (lastQx !== null) ? 2 * cx - lastQx : cx;
                        var ty1 = (lastQy !== null) ? 2 * cy - lastQy : cy;
                        var tx2 = args[i] + (rel ? cx : 0);
                        var ty2 = args[i + 1] + (rel ? cy : 0);
                        for (var s4 = 1; s4 <= 12; s4++) {
                            var t4 = s4 / 12;
                            var mt4 = 1 - t4;
                            cur.push(
                                mt4 * mt4 * cx + 2 * mt4 * t4 * tx1 + t4 * t4 * tx2,
                                mt4 * mt4 * cy + 2 * mt4 * t4 * ty1 + t4 * t4 * ty2
                            );
                        }
                        lastQx = tx1;
                        lastQy = ty1;
                        cx = tx2;
                        cy = ty2;
                        i += 2;
                        break;
                    }
                    case 'A':
                    case 'a': {
                        var arx = args[i];
                        var ary = args[i + 1];
                        var arot = args[i + 2];
                        var alaf = args[i + 3] ? 1 : 0;
                        var asf = args[i + 4] ? 1 : 0;
                        var ax2 = args[i + 5] + (rel ? cx : 0);
                        var ay2 = args[i + 6] + (rel ? cy : 0);
                        sampleArc(cur, cx, cy, arx, ary, arot, alaf, asf, ax2, ay2);
                        cx = ax2;
                        cy = ay2;
                        lastC2x = null;
                        lastQx = null;
                        i += 7;
                        break;
                    }
                    case 'Z':
                    case 'z': {
                        if (cur !== null && cur.length >= 2) {
                            cur.push(startX, startY);
                        }
                        cx = startX;
                        cy = startY;
                        i = args.length;
                        break;
                    }
                    default:
                        i = args.length;
                }
                if (cmd === 'Z' || cmd === 'z') {
                    break;
                }
            }
        }
        return subpaths;
    }

    function finalizeGeometry(subpaths) {
        var total = 0;
        var clean = [];
        var minX = Infinity;
        var minY = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;
        for (var i = 0; i < subpaths.length; i++) {
            var pts = subpaths[i].pts;
            if (pts.length < 4) {
                continue;
            }
            var len = 0;
            for (var j = 0; j + 3 < pts.length; j += 2) {
                len += Math.hypot(pts[j + 2] - pts[j], pts[j + 3] - pts[j + 1]);
                if (pts[j] < minX) { minX = pts[j]; }
                if (pts[j + 2] < minX) { minX = pts[j + 2]; }
                if (pts[j] > maxX) { maxX = pts[j]; }
                if (pts[j + 2] > maxX) { maxX = pts[j + 2]; }
                if (pts[j + 1] < minY) { minY = pts[j + 1]; }
                if (pts[j + 3] < minY) { minY = pts[j + 3]; }
                if (pts[j + 1] > maxY) { maxY = pts[j + 1]; }
                if (pts[j + 3] > maxY) { maxY = pts[j + 3]; }
            }
            if (len < 0.4) {
                continue;
            }
            clean.push({ pts: pts, len: len });
            total += len;
        }
        // True glyph bounds — lets the renderer center each icon optically
        // instead of trusting the 24x24 cell (hand-drawn glyphs sit at
        // different heights inside it).
        var bbox = isFinite(minX)
            ? { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
            : { cx: 12, cy: 12 };
        return { paths: clean, total: total, bbox: bbox };
    }

    // ------------------------------------------------------------------
    // The icon set. Each entry is a list of SVG-style path strings drawn
    // by hand for SketchTalk (24x24 grid, stroke 2, round caps).
    // Dots are drawn as 1.2-unit segments so round caps render them.
    // ------------------------------------------------------------------
    var ICONS = {
        'lightbulb': [
            'M12 3.2a5.6 5.6 0 0 1 3.5 10c-.7.6-1.1 1.3-1.1 2.1v.7H9.6v-.7c0-.8-.4-1.5-1.1-2.1A5.6 5.6 0 0 1 12 3.2Z',
            'M10.4 8.2 12 10.4 13.6 8.2',
            'M12 10.4v2.2',
            'M9.6 18.2h4.8',
            'M10.4 20.4h3.2',
            'M11.2 21.6h1.6'
        ],
        'rocket': [
            'M12 2.2c2.6 1.8 4.2 4.6 4.2 7.8 0 1.8-.4 3.4-1.2 4.8h-6c-.8-1.4-1.2-3-1.2-4.8 0-3.2 1.6-6 4.2-7.8Z',
            'M12 6.6a1.7 1.7 0 1 0 .01 0',
            'M10.6 6.2h.8',
            'M9.2 15.2 6.2 18.2l3.4.4',
            'M14.8 15.2l3 3-3.4.4',
            'M10.4 17.6c.4 1.5 1 2.6 1.6 3.4.6-.8 1.2-1.9 1.6-3.4',
            'M11.3 18.2c.2 1 .4 1.7.7 2.2.3-.5.5-1.2.7-2.2',
            'M8.4 12.4c-1.6.2-2.8 1.2-3.2 2.4',
            'M15.6 12.4c1.6.2 2.8 1.2 3.2 2.4'
        ],
        'users': [
            'M8.4 5.2a2.6 2.6 0 1 0 .01 0',
            'M7.4 7.2h.7',
            'M9.6 7.2h.7',
            'M6.2 20.4c.2-2.6 1.6-4.4 3.6-4.4.8 0 1.5.2 2.1.6',
            'M7.2 12.2c.5-1.3 1.3-2 2.4-2s1.9.7 2.4 2',
            'M5.6 13.4 3.4 15.6',
            'M15.6 4.4a2.3 2.3 0 1 0 .01 0',
            'M14.8 6.2h.7',
            'M16.6 6.2h.7',
            'M13.8 19.6c.3-2.2 1.6-3.8 3.4-3.8s3.1 1.6 3.4 3.8',
            'M14.6 11.2c.4-1.1 1.1-1.7 2.1-1.7s1.7.6 2.1 1.7',
            'M11.2 13.6c1.2.6 2.2 1.6 2.6 2.8'
        ],
        'user': [
            'M12 3.2a3.2 3.2 0 1 0 .01 0',
            'M10.6 5.6h.9',
            'M13.2 5.6h.9',
            'M10.8 7.2c.7.5 1.7.5 2.4 0',
            'M9.2 11.2c.7-1.5 1.7-2.2 2.8-2.2s2.1.7 2.8 2.2',
            'M6.4 20.8c.4-3.2 2.6-5.4 5.6-5.4s5.2 2.2 5.6 5.4',
            'M8.2 13.4c-1.8.9-2.8 2.4-2.6 4',
            'M15.8 13.4c1.8.9 2.8 2.4 2.6 4',
            'M4.2 20.8h15.6'
        ],
        'handshake': [
            'M2.2 12.4c1.8-1.8 3.4-2 5.2-.2l2.2 2',
            'M7 10.6 9.2 8.4',
            'M9.4 14.2 7.2 16.6',
            'M21.8 12.4c-1.8-1.8-3.4-2-5.2-.2l-2.2 2',
            'M17 10.6 14.8 8.4',
            'M14.6 14.2l2.2 2.4',
            'M9.6 12.2h4.8',
            'M11.2 10.8v2.8'
        ],
        'trending-up': [
            'M3.5 3.5v16h17',
            'M7 14.5l3.5-4 3 2.5 5-6',
            'M15.6 6.7h3v3'
        ],
        'trending-down': [
            'M3.5 3.5v16h17',
            'M7 8l3.5 4 3-2.5 5 6',
            'M15.6 16.8h3v-3'
        ],
        'chart-column': [
            'M3.5 3.5v16h17',
            'M8 19.5v-6',
            'M12 19.5v-10',
            'M16 19.5v-4'
        ],
        'dollar-sign': [
            'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0',
            'M14.5 8.5c-2.5-1.6-5.5-.6-5.5 1.5 0 2.4 5.5 1.7 5.5 4.2 0 2-3 3-5.5 1.3',
            'M12 6v12'
        ],
        'coins': [
            'M4.2 8.4c0-1.4 2.8-2.5 6.2-2.5s6.2 1.1 6.2 2.5-2.8 2.5-6.2 2.5-6.2-1.1-6.2-2.5Z',
            'M4.2 8.4v3.2c0 1.4 2.8 2.5 6.2 2.5s6.2-1.1 6.2-2.5V8.4',
            'M4.2 11.6c0 1.4 2.8 2.5 6.2 2.5s6.2-1.1 6.2-2.5',
            'M7.4 15.6c0-1.2 2-2.1 4.6-2.1s4.6.9 4.6 2.1-2 2.1-4.6 2.1-4.6-.9-4.6-2.1Z',
            'M7.4 15.6V18.4c0 1.2 2 2.1 4.6 2.1s4.6-.9 4.6-2.1v-2.8',
            'M18.8 6.6l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7Z'
        ],
        'server': [
            'M6 4h12a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
            'M6 13h12a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2Z',
            'M6.4 6.8h1.2',
            'M11 6.8h6',
            'M6.4 15.8h1.2',
            'M11 15.8h6'
        ],
        'database': [
            'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z',
            'M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6',
            'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3'
        ],
        'target': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M7.5 12a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0',
            'M12 12l7-7',
            'M16.4 4.6h3v3'
        ],
        'triangle-alert': [
            'M12 2.8 22 20.4H2Z',
            'M12 5.2 19.6 18.6H4.4Z',
            'M12 9.4v4.4',
            'M11.4 16.8h1.2'
        ],
        'bug': [
            'M12 7.5a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0v-3a4 4 0 0 1 4-4Z',
            'M9 7 7.5 4.5',
            'M15 7l1.5-2.5',
            'M8 12H4.5',
            'M8 15H5',
            'M16 12h3.5',
            'M16 15h3',
            'M12 7.5V19'
        ],
        'clock': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M12 7.5V12l3.2 1.9'
        ],
        'calendar': [
            'M4.5 5.5h15v15h-15Z',
            'M8 3v4',
            'M16 3v4',
            'M4.5 9.5h15',
            'M8 13h1.2',
            'M12 13h1.2',
            'M16 13h1.2',
            'M8 16.5h1.2',
            'M12 16.5h1.2'
        ],
        'globe': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M12 3c-2.5 2-4 5.2-4 9s1.5 7 4 9c2.5-2 4-5.2 4-9s-1.5-7-4-9Z',
            'M3.3 12h17.4'
        ],
        'shield-check': [
            'M12 2.5 20 5.5v5c0 5-3.4 8.6-8 10.5-4.6-1.9-8-5.5-8-10.5v-5Z',
            'M8.5 11.8l2.4 2.4 4.6-4.8'
        ],
        'shield': [
            'M12 2.5 20 5.5v5c0 5-3.4 8.6-8 10.5-4.6-1.9-8-5.5-8-10.5v-5Z'
        ],
        'circle-check': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M8 12.3l2.7 2.7 5.5-5.5'
        ],
        'circle-x': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M9 9l6 6',
            'M15 9l-6 6'
        ],
        'check': [
            'M4.5 12.5 10 18 19.5 7'
        ],
        'brain': [
            'M12 4.5c-1-1-2.6-1.4-4-.8-1.5.6-2.3 2-2.2 3.5-1.4.6-2.2 2-2 3.5.1 1 .7 1.9 1.5 2.4-.4 1.5.3 3.1 1.8 3.8 1.1.5 2.4.4 3.4-.3',
            'M12 4.5c1-1 2.6-1.4 4-.8 1.5.6 2.3 2 2.2 3.5 1.4.6 2.2 2 2 3.5-.1 1-.7 1.9-1.5 2.4.4 1.5-.3 3.1-1.8 3.8-1.1.5-2.4.4-3.4-.3',
            'M12 4.5V20'
        ],
        'zap': [
            'M13 2 5 13.2h5.8L11 22l8-11.2h-5.8Z'
        ],
        'workflow': [
            'M3.5 4h6v5h-6Z',
            'M14.5 4h6v5h-6Z',
            'M9 15.5h6v5H9Z',
            'M6.5 9v3.2h11V9',
            'M12 12.2v3.3'
        ],
        'layers': [
            'M12 3 21 8l-9 5-9-5Z',
            'M3.8 12.4 12 17l8.2-4.6',
            'M3.8 16.4 12 21l8.2-4.6'
        ],
        'cpu': [
            'M6 6h12v12H6Z',
            'M10 10h4v4h-4Z',
            'M9 3v3',
            'M15 3v3',
            'M9 18v3',
            'M15 18v3',
            'M3 9h3',
            'M3 15h3',
            'M18 9h3',
            'M18 15h3'
        ],
        'building-2': [
            'M5 21V6l7-3.5V21',
            'M12 10.5 19 7v14h-7',
            'M7.4 9h1.2',
            'M7.4 12.5h1.2',
            'M7.4 16h1.2',
            'M15.4 12.5h1.2',
            'M15.4 16h1.2',
            'M3.5 21h17'
        ],
        'megaphone': [
            'M3.5 10 20 4.5v15L3.5 14Z',
            'M14.8 8.8c1.2 1.8 1.2 4.6 0 6.4',
            'M5.5 14v4.5h3V15'
        ],
        'package': [
            'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5Z',
            'M3.5 7.5 12 12l8.5-4.5',
            'M12 12v9'
        ],
        'presentation': [
            'M3 4.5h18v11H3Z',
            'M6.5 12l3-3.5 2.5 2 3.5-4',
            'M12 15.5v4',
            'M8.5 20.5h7'
        ],
        'star': [
            'M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3L12 17l-5.7 3 1.2-6.3L2.8 9.3l6.4-.8Z'
        ],
        'trophy': [
            'M7 3.5h10v5a5 5 0 0 1-10 0Z',
            'M7 4.5H4.5v2A3 3 0 0 0 7 9.5',
            'M17 4.5h2.5v2A3 3 0 0 1 17 9.5',
            'M12 13.5V17',
            'M8.5 20.5h8',
            'M9.5 17h5'
        ],
        'lock': [
            'M5.5 10.5h13v10h-13Z',
            'M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5',
            'M11.4 14h1.2',
            'M12 16v2'
        ],
        'cloud': [
            'M6.8 18a4.2 4.2 0 0 1-.3-8.4 5.6 5.6 0 0 1 10.9-1.1A3.9 3.9 0 0 1 17.5 18Z'
        ],
        'route': [
            'M5 18a8 8 0 0 1 13.6-5.7',
            'M15.5 9.5 19 12l-3 3',
            'M4.4 18h1.2'
        ],
        'list-checks': [
            'M10 6.5h10',
            'M10 12h10',
            'M10 17.5h10',
            'M3.5 6l1.5 1.5L7.5 5',
            'M3.5 11.5 5 13l2.5-2.5',
            'M3.5 17 5 18.5 7.5 16.5'
        ],
        'sparkles': [
            'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z',
            'M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z',
            'M4.4 18h1.2'
        ],
        'hourglass': [
            'M6.5 3h11',
            'M6.5 21h11',
            'M7.5 3v3.5L12 11l4.5-4.5V3',
            'M7.5 21v-3.5L12 13l4.5 4.5V21'
        ],
        'wallet': [
            'M3.5 7.5h17V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z',
            'M3.5 7.5V6a2 2 0 0 1 2-2h12',
            'M15.9 13.2h1.2'
        ],
        'sticky-note': [
            'M5 4h14v10l-5 6H5Z',
            'M14 20v-6h5',
            'M8.5 9h7',
            'M8.5 12h4'
        ],
        'search': [
            'M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0',
            'M15.3 15.3 21 21'
        ],
        'house': [
            'M2.6 11.4 12 3 21.4 11.4',
            'M5.2 9.8V20.6h13.6V9.8',
            'M2.2 20.8h19.6',
            'M10.2 20.6v-5h3.6v5',
            'M7 13h2.3v2.2H7Z',
            'M14.7 13h2.3v2.2h-2.3Z',
            'M16.4 7.2V4.2h2.1v4.4',
            'M7.6 14.1h1.1',
            'M15.3 14.1h1.1'
        ],
        'heart': [
            'M12 20.5S4 15 4 9.5C4 6.5 6.3 5 8.3 5c1.6 0 3 .9 3.7 2.3C12.7 5.9 14.1 5 15.7 5c2 0 4.3 1.5 4.3 4.5 0 5.5-8 11-8 11Z'
        ],
        'mail': [
            'M3.5 5.5h17v13h-17Z',
            'M3.5 5.5 12 13l8.5-7.5'
        ],
        'message-circle': [
            'M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.2-.4-4.5-1.2L3 20l1.2-4.9A8.5 8.5 0 1 1 21 11.5Z'
        ],
        'link': [
            'M9.5 14.5 14.5 9.5',
            'M11 6.5 13 4.5a3.5 3.5 0 0 1 5 5l-2 2',
            'M13 17.5l-2 2a3.5 3.5 0 0 1-5-5l2-2'
        ],
        'eye': [
            'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z',
            'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'
        ],
        'map-pin': [
            'M12 21s6.6-5.8 6.6-10.6a6.6 6.6 0 0 0-13.2 0C5.4 15.2 12 21 12 21Z',
            'M9.4 9.6a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0',
            'M10.6 9.6h.8',
            'M4.2 22.4c2.2-.9 4.6-1.3 7.8-1.3s5.6.4 7.8 1.3',
            'M7.2 22.6c.8.5 1.6.8 2.4.6'
        ],
        'book-open': [
            'M12 6.5C10 4.8 7.5 4.2 4 4.5v14c3.5-.3 6 .3 8 2 2-1.7 4.5-2.3 8-2v-14c-3.5-.3-6 .3-8 2Z',
            'M12 6.5v14'
        ],
        'download': [
            'M12 3.5v11',
            'M7.5 10 12 14.5 16.5 10',
            'M4.5 16.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5'
        ],
        'flag': [
            'M5.5 21V3.5',
            'M5.5 4c2-1.2 4-1.2 6 0s4 1.2 6 0v8c-2 1.2-4 1.2-6 0s-4-1.2-6 0Z'
        ],
        'settings': [
            'M4 7h8',
            'M17 7h3',
            'M4 17h3',
            'M12 17h8',
            'M12.4 5.4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0',
            'M7.4 15.4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0'
        ],
        // ——— Story pictograms (personal-narrative vocabulary) ———
        'airplane': [
            'M3.2 12.4c1.6-1.5 5.2-2.2 10.2-2.2 3.6 0 6.6.7 8.2 1.6-1.2 1.2-4.2 2.1-8.2 2.2-5 0-8.6-.6-10.2-1.6Z',
            'M17.4 10.4 20.2 5.6l1.6.4-2.2 5',
            'M8.2 13.6 2.4 18.2l7.2-3.2',
            'M15.8 13.6 21.6 18.2l-7.2-3.2',
            'M6.2 12.2h1.3',
            'M8.4 12.2h1.3',
            'M10.6 12.2h1.3',
            'M12.8 12.2h1.3',
            'M15 12.2h1.3',
            'M18.6 11.4h1.6',
            'M9.2 14.4h3.2v1.5H9.2Z'
        ],
        'train': [
            'M4.2 9.2h13.2c1.4 0 2.4 1 2.4 2.4V16.2H4.2Z',
            'M14.2 9.2V5.6h4.4V9.2',
            'M6.2 9.2V4.6',
            'M4.8 4.6h2.8',
            'M5.4 11.2h3.2v2.8H5.4Z',
            'M9.6 11.2h3.2v2.8H9.6Z',
            'M17.6 12.4h1.4',
            'M7 19.2a1.9 1.9 0 1 0 .01 0',
            'M15.2 19.2a1.9 1.9 0 1 0 .01 0',
            'M7 19.2h8.2',
            'M4.6 16.2 7 18',
            'M19.4 16.2 17.2 18',
            'M2.2 21.4h19.6',
            'M3.2 22.6h17.6'
        ],
        'graduation-cap': [
            'M12 3.2 2.2 8 12 12.6 21.8 8Z',
            'M6.2 10.2v3.2c0 1.6 2.4 3.2 5.8 3.2s5.8-1.6 5.8-3.2v-3.2',
            'M12 8v4.6',
            'M21.2 8.2v4.6',
            'M20.4 13.4h1.6',
            'M21.2 13.2c.6 1.6.2 3.2-.8 4.2'
        ],
        'school-kid': [
            'M12 3.4a2.5 2.5 0 1 0 .01 0',
            'M10.8 5.2h.8',
            'M13.2 5.2h.8',
            'M11.1 6.6c.5.35 1.3.35 1.8 0',
            'M9.2 11c.6-1.3 1.6-2 2.8-2s2.2.7 2.8 2',
            'M8.2 20.6c.2-2.6 1.8-4.4 3.8-4.4s3.6 1.8 3.8 4.4',
            'M8.6 12.6 6.2 14.8',
            'M15.4 12.2 17.4 11',
            'M4.6 14.6h3.4v2.6H4.6Z',
            'M5.2 15.4h2.2',
            'M15.6 12.4h3.1v4.6h-3.1Z',
            'M15.6 14h3.1'
        ],
        'worker': [
            'M8.6 6.2a2.4 2.4 0 1 0 .01 0',
            'M6.4 5.2c.4-1.6 2-2.6 4-2.2 1.2.2 2 .8 2.4 1.6',
            'M7.6 7.6h.7',
            'M10.2 7.6h.7',
            'M5.2 20.6c.2-2.8 1.8-4.6 4.2-4.6 1.4 0 2.6.6 3.4 1.6',
            'M7.4 12.2c.5-1.2 1.4-1.8 2.5-1.8s2 .6 2.5 1.8',
            'M15.2 13.6h5.6v6.2h-5.6Z',
            'M16.6 13.6v-1.4h2.8v1.4',
            'M17.4 16.4h1.2',
            'M4.8 14.2 3.2 16.4'
        ],
        'village': [
            'M2 20.8h20',
            'M8.6 20.8v-6.4l3.2-2.4 3.2 2.4v6.4',
            'M6.8 14.4 11.8 10.4l4.6 3.8',
            'M10.6 20.8V17h2.4v3.8',
            'M3.4 20.8v-4.2',
            'M2.2 16.2h2.4',
            'M1.6 12.2a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0',
            'M18.4 20.8v-4.6',
            'M17.2 15.8h2.4',
            'M16.6 11.4a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0-4.8 0',
            'M4.2 21.6c2.4-.5 4.2-.6 7.8-.2 3.2.4 5.4.2 7.6-.4',
            'M12.4 8.2c.4-1.4 1.6-2.2 2.4-1.2'
        ],
        'hospital': [
            'M4.6 21V9.2L12 4.8 19.4 9.2V21',
            'M2.4 21h19.2',
            'M12 2.4v2.2',
            'M10.8 3.5h2.4',
            'M12 10.2v5.6',
            'M9.2 13h5.6',
            'M10.3 21v-3.3h3.4V21',
            'M6.6 12h1.4',
            'M16 12h1.4',
            'M6.6 15.2h1.4',
            'M16 15.2h1.4',
            'M6.6 18h1.4',
            'M16 18h1.4'
        ],
        'football': [
            'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
            'M12 7.2l3.3 2.4-1.3 3.9h-4L8.7 9.6Z',
            'M15.3 9.6l4.2-1.2',
            'M14 13.5l2.6 3.4',
            'M10 13.5l-2.6 3.4',
            'M8.7 9.6 4.5 8.4',
            'M12 7.2V3.5'
        ],
        'soccer-kick': [
            'M7.5 4.5a2.3 2.3 0 1 0 .01 0',
            'M7.5 7.2v5.3',
            'M7.5 8.8 4 10.5',
            'M7.5 8.8l3.6 1.2',
            'M7.5 12.5 6.2 19',
            'M7.5 12.5l5.2 3.2',
            'M16.8 14a3.4 3.4 0 1 0 .01 0'
        ],
        'office-desk': [
            'M3 15h18',
            'M5 15v6',
            'M19 15v6',
            'M8.2 6.2a2.1 2.1 0 1 0 .01 0',
            'M6.6 12.4c0-1.8 1.4-3 3.2-3s3.2 1.2 3.2 3',
            'M14.2 8.4h4.4v3.2h-4.4Z',
            'M16.4 8.4V7.2',
            'M9.2 15v2.2',
            'M6.4 15.6h2.2',
            'M2.4 21.2h19.2'
        ],
        'briefcase': [
            'M3.2 8.2h17.6V19.4a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6Z',
            'M9 8.2V6a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 6v2.2',
            'M3.2 12.4h17.6',
            'M10.6 12.4v1.8h2.8v-1.8',
            'M6.4 15.2h4.2',
            'M6.4 17.2h2.6'
        ],
        'flag-germany': [
            'M4 5h16v14H4Z',
            'M4 9.7h16',
            'M4 14.4h16'
        ],
        'flag-japan': [
            'M4 5h16v14H4Z',
            'M9.7 12a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0'
        ],
        'flag-indonesia': [
            'M4 5h16v14H4Z',
            'M4 12h16'
        ],
        // Greeting marks — one symbol, readable at a glance.
        'sunrise': [
            'M12 10.6a3.4 3.4 0 1 0 .01 0',
            'M3 17.4h18',
            'M12 5.6V3.8',
            'M7.6 7.2 5.8 5.4',
            'M16.4 7.2l1.8-1.8',
            'M5.4 12.2 3.6 11.2',
            'M18.6 12.2l-1.8-1'
        ],
        'sun': [
            'M12 12a4 4 0 1 0 .01 0',
            'M12 3.2v2.3',
            'M12 18.5v2.3',
            'M3.2 12h2.3',
            'M18.5 12h2.3',
            'M5.7 5.7l1.6 1.6',
            'M16.7 16.7l1.6 1.6',
            'M18.3 5.7l-1.6 1.6',
            'M7.3 16.7l-1.6 1.6'
        ],
        'sunset': [
            'M8 15.6A4 4 0 0 1 16 15.6',
            'M2.6 15.6h18.8',
            'M12 8.4V6.6',
            'M7.2 10.8 5.6 9.2',
            'M16.8 10.8l1.6-1.6',
            'M4.2 18.6c2.4-.8 4.6-1.1 7.8-1.1s5.4.3 7.8 1.1'
        ],
        'moon': [
            'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
            'M6.2 6.4l.45 1 .95.35-.95.4-.45 1-.4-1-.95-.4.95-.35Z'
        ],
        'sabbath': [
            'M12 4.4a2.5 2.5 0 1 0 .01 0',
            'M12 1.5v1.2',
            'M8.8 3.4 7.6 2.2',
            'M15.2 3.4l1.2-1.2',
            'M3.8 15.2c2.6-1.4 5-1 8.2.7 3.2-1.7 5.6-2.1 8.2-.7v5.2c-2.6-1.4-5-1-8.2 1.2-3.2-2.2-5.6-2.6-8.2-1.2Z',
            'M12 15.9v5.6'
        ],
        'welcome': [
            'M6.2 20.8V4.2h11.6v16.6',
            'M6.2 20.8h11.6',
            'M8.4 20.8V10.4h6.4',
            'M14.8 20.8V10.4',
            'M8.4 10.4h6.4',
            'M12.8 15.2h1.1',
            'M3.2 20.8h17.6'
        ],
        'cake': [
            'M5 13.4h14V20H5Z',
            'M5 16.6h14',
            'M7.4 13.4c.15-1.5 1.1-2.3 1.9-2.3s1.7.8 1.9 2.3',
            'M12.8 13.4c.15-1.5 1.1-2.3 1.9-2.3s1.7.8 1.9 2.3',
            'M12 7.4v2.6',
            'M12 5.2c.55.7.55 1.3 0 2-.55-.7-.55-1.3 0-2Z',
            'M4.2 20.6h15.6'
        ]
    };

    var geometryCache = {};

    function buildGeometry(name) {
        if (Object.prototype.hasOwnProperty.call(geometryCache, name)) {
            return geometryCache[name];
        }
        var defs = ICONS[name] || ICONS['sticky-note'];
        var subpaths = [];
        for (var i = 0; i < defs.length; i++) {
            var subs = parsePathD(defs[i]);
            for (var k = 0; k < subs.length; k++) {
                subpaths.push(subs[k]);
            }
        }
        var geo = finalizeGeometry(subpaths);
        geometryCache[name] = geo;
        return geo;
    }

    var api = {
        ICONS: ICONS,
        parsePathD: parsePathD,
        finalizeGeometry: finalizeGeometry,
        sampleArc: sampleArc,
        buildGeometry: buildGeometry
    };

    if (typeof window !== 'undefined') {
        window.SK_ICONS_LIB = api;
    } else {
        globalThis.SK_ICONS_LIB = api;
    }
})();
