/* =========================================================================
 * SketchTalk mic page — voice capture only.
 * =========================================================================
 * Same continuous pipeline as the stage (debounced interim previews,
 * instant local sketch + AI refinement), but this page renders nothing:
 * directives are pushed into the room and the presentation screen picks
 * them up by polling.
 * ========================================================================= */
(function () {
    'use strict';

    var CFG = window.SK_CONFIG || {};
    var micBtn = document.getElementById('sk-mic');
    var interimEl = document.getElementById('sk-interim');
    var engineEl = document.getElementById('sk-engine');
    var langBtn = document.getElementById('sk-lang');
    var stageEl = document.getElementById('sk-stage');
    var modeFastBtn = document.getElementById('sk-mode-fast');
    var modeSlowBtn = document.getElementById('sk-mode-slow');

    var SOURCE_ID = 'mic-' + Math.random().toString(36).slice(2, 10);
    var currentLang = 'id-ID';
    var isListening = false;
    var recognition = null;
    var state = { paused: false };
    var seqCounter = 0;
    var latestAppliedSeq = 0;
    var lastPreviewAt = 0;
    var lastPreviewText = '';
    var lastAppliedPreviewText = '';
    var lastRoomSeq = 0;

    var RE_PAUSE = /\b(berhenti|stop|pause)\b/i;
    var RE_RESUME = /\b(lanjut(?:kan)?|continue|resume)\b/i;
    var RE_CLEAR = /(hapus layar|bersihkan layar|slide baru|halaman baru|mulai dari awal|clear screen|new slide|reset canvas)/i;

    function setEngineBadge(engine) {
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

    var toastTimer = null;
    var toastEl = document.createElement('div');
    toastEl.className = 'sk-toast sk-toast-static';
    document.body.appendChild(toastEl);
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('show');
        }, 2400);
    }

    function setPaused(paused) {
        state.paused = paused;
        if (paused) {
            toast('Sistem dijeda — ucapkan "LANJUTKAN"');
            interimEl.textContent = '⏸ DIJEDA — ucapkan "LANJUTKAN"';
        } else {
            toast('Sistem dilanjutkan');
        }
    }

    // ------------------------------------------------------------------
    // Speech recognition (continuous, interim previews)
    // ------------------------------------------------------------------
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
            interimEl.textContent = 'Mendengarkan… silakan bicara';
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
                toast('Izin mikrofon ditolak');
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

    function startListening() {
        if (recognition === null) {
            recognition = initRecognition();
        }
        if (recognition === null) {
            interimEl.textContent = 'Firefox tidak mendukung input suara — gunakan Chrome / Edge';
            toast('Buka halaman ini di Chrome / Edge');
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
    // Continuous pipeline (identical semantics to the stage page)
    // ------------------------------------------------------------------
    var genMode = 'fast';
    var slowFlushTimer = 0;
    try {
        genMode = localStorage.getItem('sketchtalk-mode') === 'slow' ? 'slow' : 'fast';
    } catch (err) {
        genMode = 'fast';
    }

    function paintMode() {
        if (modeFastBtn) {
            modeFastBtn.style.background = genMode === 'fast' ? '#111' : '';
            modeFastBtn.style.color = genMode === 'fast' ? '#fff' : '';
        }
        if (modeSlowBtn) {
            modeSlowBtn.style.background = genMode === 'slow' ? '#111' : '';
            modeSlowBtn.style.color = genMode === 'slow' ? '#fff' : '';
        }
    }

    function showSlowStatus(status) {
        if (genMode !== 'slow') {
            return;
        }
        var label = 'mendengarkan, slide menyusul jeda';
        if (status === 'preparing') {
            label = 'menyusun slide';
        } else if (status === 'ready') {
            label = 'slide berikutnya siap';
        } else if (status === 'shown') {
            label = 'slide tampil';
        }
        stageEl.textContent = 'Slow · ' + label;
    }

    function postMode() {
        var payload = {
            transcript: '',
            lang: currentLang,
            partial: false,
            instant: false,
            flush: false,
            mode: genMode,
            room: CFG.room || '',
            source: SOURCE_ID
        };
        var body = new URLSearchParams();
        body.set('csrf_token', CFG.csrfToken || '');
        body.set('payload', JSON.stringify(payload));
        fetch(CFG.interpretUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        }).catch(function () { });
    }

    function setGenMode(mode, announce) {
        genMode = mode === 'slow' ? 'slow' : 'fast';
        try {
            localStorage.setItem('sketchtalk-mode', genMode);
        } catch (err) {
        }
        paintMode();
        if (announce) {
            toast(genMode === 'slow' ? 'Slow — satu slide tiap gagasan' : 'Fast — gambar mengikuti ucapan');
            postMode();
            if (genMode === 'slow') {
                showSlowStatus('listening');
            }
        }
    }

    function armSlowFlush(text) {
        if (genMode !== 'slow') {
            return;
        }
        if (slowFlushTimer) {
            clearTimeout(slowFlushTimer);
        }
        slowFlushTimer = setTimeout(function () {
            slowFlushTimer = 0;
            if (genMode !== 'slow') {
                return;
            }
            sendToServer(text, false, true);
        }, 1700);
    }

    if (modeFastBtn) {
        modeFastBtn.addEventListener('click', function () { setGenMode('fast', true); });
    }
    if (modeSlowBtn) {
        modeSlowBtn.addEventListener('click', function () { setGenMode('slow', true); });
    }
    paintMode();

    function onSpeech(text, isFinal, flushNow) {
        if (state.paused) {
            if (RE_RESUME.test(text)) {
                setPaused(false);
                sendToServer(text, false, false);
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
            sendToServer(text, true, false);
        } else {
            if (genMode !== 'slow' && text === lastPreviewText && text === lastAppliedPreviewText) {
                return;
            }
            sendToServer(text, false, flushNow === true);
        }
    }

    function sendToServer(text, partial, flush) {
        if (RE_PAUSE.test(text)) {
            setPaused(true);
            return;
        }
        if (RE_CLEAR.test(text)) {
            // The stage clears itself from the pushed directive below.
        }

        var slow = genMode === 'slow';
        var seq = ++seqCounter;
        var aiSeq = partial ? ++seqCounter : seq;

        function doPost(payloadSeq, instant) {
            var payload = {
                transcript: text,
                lang: currentLang,
                is_paused: state.paused,
                partial: partial,
                instant: slow ? false : instant === true,
                flush: flush === true,
                mode: genMode,
                room: CFG.room || '',
                source: SOURCE_ID,
                seq: payloadSeq,
                canvas_objects: []
            };
            var body = new URLSearchParams();
            body.set('csrf_token', CFG.csrfToken || '');
            body.set('payload', JSON.stringify(payload));
            return fetch(CFG.interpretUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });
        }

        function showHttpError(where, res) {
            res.json().then(function (body) {
                interimEl.textContent = '⚠ ' + where + ' gagal (HTTP ' + res.status + '): ' + (body && body.desc ? body.desc : '') + ' — reload halaman ini';
            }).catch(function () {
                interimEl.textContent = '⚠ ' + where + ' gagal (HTTP ' + res.status + ') — reload halaman ini';
            });
        }

        if (flush !== true) {
            armSlowFlush(text);
        }
        if (partial) {
            doPost(seq, true)
                .then(function (res) {
                    if (!res.ok) {
                        showHttpError('pratinjau', res);
                        return null;
                    }
                    return res.json();
                })
                .then(function (result) {
                    if (result == null) {
                        return;
                    }
                    if (typeof result.room_seq === 'number') {
                        lastRoomSeq = Math.max(lastRoomSeq, result.room_seq);
                    }
                })
                .catch(function (err) {
                    console.warn('[sketchtalk-mic] preview failed:', err);
                    interimEl.textContent = '⚠ tidak bisa menghubungi server — cek jaringan perangkat ini';
                });
            if (slow) {
                return;
            }
        }
        doPost(aiSeq, false)
            .then(function (res) {
                if (!res.ok) {
                    showHttpError('kirim', res);
                    throw new Error('http ' + res.status);
                }
                return res.json();
            })
            .then(function (result) {
                if (result.engine && !result.instant) {
                    setEngineBadge(result.engine);
                }
                if (typeof result.room_seq === 'number') {
                    lastRoomSeq = Math.max(lastRoomSeq, result.room_seq);
                }
                if (result.directive && result.directive.topic_summary) {
                    stageEl.textContent = 'layar: ' + result.directive.topic_summary;
                }
                if (partial) {
                    lastAppliedPreviewText = text;
                }
                if (result.gen_mode === 'slow') {
                    showSlowStatus(result.slow_status || '');
                } else if (result.directive && result.directive.action === 'IGNORE' && !partial) {
                    interimEl.textContent = '· didengar, belum ada gagasan visual: "' + (text.length > 40 ? text.slice(0, 40) + '…' : text) + '" ·';
                }
            })
            .catch(function (err) {
                console.warn('[sketchtalk-mic] request failed:', err);
            });
    }

    // Typing fallback: works on any device, no microphone permission
    // needed (useful when the browser blocks the mic on insecure origins).
    var formEl = document.getElementById('sk-form');
    var inputEl = document.getElementById('sk-input');
    if (formEl !== null) {
        formEl.addEventListener('submit', function (e) {
            e.preventDefault();
            var val = inputEl.value.trim();
            if (val === '') {
                return;
            }
            interimEl.textContent = '✓ "' + val + '"';
            inputEl.value = '';
            onSpeech(val, true, true);
        });
    }

    // Insecure origin: explain WHY the mic is blocked instead of failing
    // silently (localhost is fine; LAN IP over http is not).
    if (window.isSecureContext === false) {
        var secEl = document.getElementById('sk-secure');
        if (secEl !== null) {
            secEl.classList.remove('hidden');
            secEl.textContent = 'Browser memblokir mikrofon di http:// (bukan localhost). Buka halaman ini via https:// — atau gunakan kotak ketik di bawah.';
        }
    }

    document.querySelectorAll('.sk-sample').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var text = btn.getAttribute('data-text') || '';
            interimEl.textContent = '✓ "' + text + '"';
            onSpeech(text, true, true);
        });
    });

    // ------------------------------------------------------------------
    // Watch the room so the presenter sees what is on screen.
    // ------------------------------------------------------------------
    function pollStage() {
        if (!CFG.stateUrl) {
            return;
        }
        fetch(CFG.stateUrl + '?since=' + lastRoomSeq)
            .then(function (res) { return res.json(); })
            .then(function (st) {
                if (!st) {
                    return;
                }
                if ((st.gen_mode === 'slow' || st.gen_mode === 'fast') && st.gen_mode !== genMode) {
                    setGenMode(st.gen_mode, false);
                }
                if (st.gen_mode === 'slow') {
                    showSlowStatus(st.slow_status || '');
                } else if (typeof st.seq === 'number' && st.seq > 0) {
                    lastRoomSeq = Math.max(lastRoomSeq, st.seq);
                    var topic = st.directive && st.directive.topic_summary ? st.directive.topic_summary : '';
                    stageEl.textContent = 'layar: ' + (topic !== '' ? topic : 'menunggu');
                }
                if (typeof st.seq === 'number' && st.seq > 0) {
                    lastRoomSeq = Math.max(lastRoomSeq, st.seq);
                }
            })
            .catch(function () { });
    }

    setEngineBadge(CFG.aiEnabled ? (CFG.aiProvider === 'anthropic' ? 'claude' : CFG.aiProvider) : 'fallback');
    setInterval(pollStage, 1000);
})();
