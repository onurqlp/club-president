(function () {
  'use strict';

  var active = false;
  var startPending = false;
  var renderer = null;
  var scene3 = null;
  var camera = null;
  var ball = null;
  var players = [];
  var frame = 0;
  var resizeHandler = null;
  var handledFinish = null;
  var activeHighlight = null;
  var highlightStartedAt = 0;
  var highlightTimer = 0;
  var commentaryTimer = 0;
  var language = function () { try { return localStorage.getItem('cp-ui-language-2026') === 'de' ? 'de' : 'tr'; } catch (e) { return 'tr'; } };
  var tr = function (turkish, german) { return language() === 'de' ? german : turkish; };

  function mountMatchPage() {
    var oldRoom = document.querySelector('#content .room.match');
    var sceneRoot = oldRoom && oldRoom.closest('#scene');
    if (!sceneRoot || sceneRoot.querySelector('#cp-watch-page')) return;
    var scroll = sceneRoot.querySelector('.room-scroll');
    if (!scroll) return;

    var score = scroll.querySelector('.scorebar');
    var pitch = scroll.querySelector('.canvas-box');
    var controls = scroll.querySelector('.match-buttons');
    var tactics = scroll.querySelector('.touchline');
    var hub = scroll.querySelector('.cp13-hub');
    var insights = scroll.querySelector('.match-insights');
    var substitutions = scroll.querySelector('.career-panel');
    if (!score || !pitch || !controls) return;

    active = true;
    document.body.classList.add('cp-match-active');
    var page = document.createElement('main');
    page.id = 'cp-watch-page';
    page.className = 'cp-watch-page';
    page.innerHTML = '<header class="cp-watch-top"><button type="button" class="cp-return" data-cp-return>‹ <span>' + tr('KULÜBEYE DÖN', 'ZURÜCK ZUR BANK') + '</span></button><div class="cp-broadcast-brand"><span>CP</span><b>CLUB PRESIDENT</b><small>' + tr('MAÇ YAYINI', 'SPIELÜBERTRAGUNG') + '</small></div><span class="cp-live-chip" id="cp-live-chip"><i></i><b id="cp-live-label">' + tr('MAÇ ÖNCESİ', 'VOR DEM SPIEL') + '</b><em id="cp-live-clock">00′</em></span></header>' +
      '<section class="cp-score-card"><div class="cp-score-inner"></div><div class="cp-score-sub"><span>' + tr('SPİKER ANLATIMI · CANLI İSTATİSTİK', 'KOMMENTAR · LIVE-STATISTIK') + '</span><span id="cp-watch-clock">00:00</span></div></section>' +
      '<section class="cp-broadcast-stage" id="cp-broadcast-stage"><div class="cp-stadium-lights"></div><div class="cp-commentary-stage" id="cp-commentary-stage"><div class="cp-commentary-head"><span>🎙 ' + tr('SPİKER ANLATIYOR', 'LIVE-KOMMENTAR') + '</span><span id="cp-commentary-minute">00′</span></div><div class="cp-commentary-main"><div class="cp-commentary-mark">CP<br><small>LIVE</small></div><div><span class="cp-event-type" id="cp-event-type">' + tr('MAÇ GÜNÜ', 'SPIELTAG') + '</span><h2 id="cp-commentary-title">' + tr('Takımlar sahaya çıkıyor', 'Die Teams betreten den Platz') + '</h2><p id="cp-commentary-copy">' + tr('Taktik planlar ve ilk 11 maç boyunca burada güncellenecek.', 'Taktik und Startelf werden hier live aktualisiert.') + '</p></div></div><div class="cp-commentary-stats" id="cp-commentary-stats"></div><div class="cp-commentary-feed" id="cp-commentary-feed"></div></div><div class="cp3d-stage" id="cp3d-stage" aria-label="Kritik anın 3D tekrar görüntüsü"></div><div class="cp-highlight-overlay" id="cp-highlight-overlay"><span id="cp-highlight-minute"></span><b id="cp-highlight-title"></b><p id="cp-highlight-copy"></p><span class="cp-replay-label">● ' + tr('3D KRİTİK AN', '3D-SZENE') + '</span></div><div class="cp-stage-overlay"><span class="cp-possession-label">' + tr('TAKTİK KAMERA', 'TAKTIKKAMERA') + '</span></div></section>' +
      '<section class="cp-watch-controls"><div class="cp-controls-inner"></div><div class="cp-watch-note">' + tr('Kararların ve maç sonucu bu kariyer kaydına işlenir.', 'Taktik und Ergebnis werden in diesem Spielstand gespeichert.') + '</div></section>' +
      '<section class="cp-tactic-card"><div class="cp-tactics-inner"></div></section>' +
      '<section class="cp-watch-data"></section><details class="cp-subs"><summary>' + tr('Oyuncu değişiklikleri', 'Auswechslungen') + '</summary><div class="cp-subs-inner"></div></details><div class="cp-engine-hidden"></div>';

    page.querySelector('.cp-score-inner').appendChild(score);
    if (pitch) page.querySelector('.cp-engine-hidden').appendChild(pitch);
    page.querySelector('.cp-controls-inner').appendChild(controls);
    if (tactics) page.querySelector('.cp-tactics-inner').appendChild(tactics);
    if (hub) page.querySelector('.cp-watch-data').appendChild(hub);
    if (substitutions) page.querySelector('.cp-subs-inner').appendChild(substitutions);
    if (insights) {
      var statPanel = insights.querySelector('#statPanel');
      var log = insights.querySelector('#log');
      var live = insights.querySelector('#live');
      if (statPanel) page.querySelector('#cp-commentary-stats').appendChild(statPanel);
      if (log) page.querySelector('#cp-commentary-feed').appendChild(log);
      if (live) { live.className = 'cp-live-label'; page.querySelector('#cp-live-label').replaceWith(live); }
      page.querySelector('.cp-engine-hidden').appendChild(insights);
    }
    sceneRoot.replaceChildren(page);
    page.querySelectorAll('.cp13-tab').forEach(function (tab) {
      var label = tab.textContent || '';
      if (label.indexOf('OYUNCU') >= 0) tab.textContent = '⭐ ' + tr('OYUNCU', 'SPIELER');
      if (label.indexOf('ANALİZ') >= 0) tab.textContent = '📊 ' + tr('ANALİZ', 'ANALYSE');
      if (label.indexOf('OLAYLAR') >= 0) tab.textContent = '📡 ' + tr('OLAYLAR', 'EREIGNISSE');
    });
    refreshCommentary();
    window.clearInterval(commentaryTimer);
    commentaryTimer = window.setInterval(refreshCommentary, 350);
    window.addEventListener('cp:match-event', onMatchEvent);
    window.addEventListener('cp:halftime', onHalftime);
    if (window.CP_HALFTIME_DATA) onHalftime({ detail: window.CP_HALFTIME_DATA });
  }

  function leaveMatchPage() {
    if (document.getElementById('cp-watch-page')) return;
    if (document.querySelector('#content .room.match')) return;
    if (!active) return;
    active = false;
    document.body.classList.remove('cp-match-active', 'cp-goal-pending');
    window.clearInterval(commentaryTimer); commentaryTimer = 0;
    window.removeEventListener('cp:match-event', onMatchEvent);
    window.removeEventListener('cp:halftime', onHalftime);
    window.clearTimeout(highlightTimer); highlightTimer = 0;
    stop3D();
  }

  function showCompletedMatch() {
    var modal = document.querySelector('#overlay .modal');
    if (!modal || handledFinish === modal || !/MAÇ SONA ERDİ|SPIEL BEENDET/i.test(modal.innerText || '')) return;
    handledFinish = modal;
    var text = modal.innerText || '';
    var scoreMatch = text.match(/(\d+)\s*[—–-]\s*(\d+)/);
    var teams = Array.from(modal.querySelectorAll('h2')).map(function (el) { return (el.textContent || '').trim(); }).filter(Boolean);
    var back = modal.querySelector('[data-a="back"]');
    var card = document.createElement('aside');
    card.className = 'cp-return-result';
    card.setAttribute('role', 'status');
    card.innerHTML = '<button class="cp-result-close" type="button" aria-label="Kapat">×</button><span class="cp-result-kicker">' + tr('MAÇ BİTTİ · KARİYER KAYDI GÜNCELLENDİ', 'SPIEL BEENDET · SPIELSTAND AKTUALISIERT') + '</span><b class="cp-result-title">' + tr('SONUÇ KAYDEDİLDİ', 'ERGEBNIS GESPEICHERT') + '</b><strong class="cp-result-score">' + (teams[0] || tr('Ev sahibi', 'Heim')) + ' <i>' + (scoreMatch ? scoreMatch[1] + '–' + scoreMatch[2] : '✓') + '</i> ' + (teams[1] || tr('Deplasman', 'Gast')) + '</strong><small>' + tr('Puan, bütçe, fikstür ve oyuncu performansları işlendi.', 'Punkte, Budget, Spielplan und Spielerleistungen wurden übernommen.') + '</small><button class="cp-result-report" data-a="report">' + tr('MAÇ RAPORUNU AÇ', 'SPIELBERICHT ÖFFNEN') + ' →</button>';
    if (back) back.click();
    else {
      var office = document.querySelector('#nav [data-sc="office"]');
      if (office) office.click();
    }
    window.setTimeout(function () {
      document.body.appendChild(card);
      requestAnimationFrame(function () { card.classList.add('is-visible'); });
      card.querySelector('.cp-result-close').addEventListener('click', function () { card.remove(); });
      window.setTimeout(function () { if (card.isConnected) { card.classList.remove('is-visible'); window.setTimeout(function () { if (card.isConnected) card.remove(); }, 350); } }, 13000);
    }, 80);
  }

  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-cp-return]')) {
      event.preventDefault();
      var play = document.querySelector('#play');
      if (play && (play.textContent || '').includes('DURAKLAT')) play.click();
      var office = document.querySelector('#nav [data-sc="office"]');
      if (office) office.click();
      if (typeof window.toast === 'function') window.toast(tr('Maç duraklatıldı. İstediğinde devam edebilirsin.', 'Spiel pausiert. Du kannst jederzeit fortfahren.'));
    }
    var halfChoice = event.target.closest('[data-cp-half-tactic]');
    if (halfChoice) {
      event.preventDefault();
      var tactic = document.querySelector('[data-mt="' + halfChoice.dataset.cpHalfTactic + '"]');
      if (tactic) tactic.click();
      document.querySelectorAll('[data-cp-half-tactic]').forEach(function (item) { item.classList.toggle('is-picked', item === halfChoice); });
    }
    if (event.target.closest('[data-cp-half-subs]')) {
      event.preventDefault();
      var details = document.querySelector('.cp-subs');
      if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    if (event.target.closest('[data-cp-half-continue]')) {
      event.preventDefault();
      var card = document.querySelector('.cp-halftime-card'); if (card) card.remove();
      var resume = document.querySelector('.cp-watch-controls [data-a="play"]'); if (resume) resume.click();
    }
  }, true);

  function refreshCommentary() {
    if (!active) return;
    var minute = document.getElementById('minute');
    var score = document.getElementById('score');
    var feed = document.querySelector('#log .event');
    var clock = document.getElementById('cp-watch-clock');
    var stageMinute = document.getElementById('cp-commentary-minute');
    var live = document.getElementById('live');
    var m = minute ? (minute.textContent || '0′').trim() : '0′';
    if (clock) clock.textContent = (m.replace(/[^0-9]/g, '').padStart(2, '0')) + ':00';
    if (stageMinute) stageMinute.textContent = m;
    var headerClock = document.getElementById('cp-live-clock'); if (headerClock) headerClock.textContent = m;
    if (live && live.textContent) live.textContent = /CANLI|LIVE/i.test(live.textContent) ? tr('CANLI', 'LIVE') : live.textContent.replace(/[●•]/g, '').trim();
    var title = document.getElementById('cp-commentary-title');
    var copy = document.getElementById('cp-commentary-copy');
    var kind = document.getElementById('cp-event-type');
    if (document.body.classList.contains('cp-goal-pending')) return;
    if (feed && title) {
      var content = (feed.innerText || '').replace(/\s+/g, ' ').trim();
      var split = content.match(/^([0-9]+(?:\.[0-9]+)?′?)\s*(.*)$/);
      title.textContent = split ? split[2] || tr('Oyun devam ediyor', 'Das Spiel läuft') : content;
      if (copy) copy.textContent = score ? tr('Skor ', 'Spielstand ') + score.textContent + ' · ' + tr('Takımlar taktik planlarını sahaya yansıtıyor.', 'Die Teams setzen ihre taktischen Pläne um.') : tr('Maçın ritmi ve son olaylar canlı aktarılıyor.', 'Spieltempo und Ereignisse werden live kommentiert.');
      if (kind) kind.textContent = tr('SAHADAN SON GELİŞME', 'AKTUELLES VOM PLATZ');
    }
  }

  function onMatchEvent(event) {
    var detail = event.detail || {};
    if (detail.goalReveal) {
      if (!detail.keepScoreHidden) document.body.classList.remove('cp-goal-pending');
      var revealTitle=document.getElementById('cp-commentary-title');
      var revealCopy=document.getElementById('cp-commentary-copy');
      var revealKind=document.getElementById('cp-event-type');
      if(revealKind) revealKind.textContent=tr('GOL','TOR');
      if(revealTitle) revealTitle.textContent=tr('GOL! '+(detail.player||''),'TOR! '+(detail.player||''));
      if(revealCopy) revealCopy.textContent=(detail.message||'')+(detail.scoreText?' · '+tr('Skor ','Spielstand ')+detail.scoreText:'');
      var highlightTitle=document.getElementById('cp-highlight-title');
      var highlightCopy=document.getElementById('cp-highlight-copy');
      if(highlightTitle) highlightTitle.textContent=tr('GOL!','TOR!');
      if(highlightCopy) highlightCopy.textContent=detail.message||'';
      return;
    }
    if (!detail.highlight) { refreshCommentary(); return; }
    window.CP_LIVE_MATCH = detail;
    detail.event = detail.event || detail.type || 'pass';
    if(detail.preGoal){
      document.body.classList.add('cp-goal-pending');
      if(!document.getElementById('cp-spoiler-guard')){
        var guard=document.createElement('style');guard.id='cp-spoiler-guard';
        guard.textContent='.cp-goal-pending .cp-score-card .scorebar,.cp-goal-pending #cp-commentary-stats,.cp-goal-pending #cp-commentary-feed{visibility:hidden!important}.cp-goal-pending .cp-commentary-main{min-height:82px}';
        document.head.appendChild(guard);
      }
      var suspenseTitle=document.getElementById('cp-commentary-title');
      var suspenseCopy=document.getElementById('cp-commentary-copy');
      var suspenseKind=document.getElementById('cp-event-type');
      if(suspenseKind)suspenseKind.textContent=tr('ATAK GELİŞİYOR','ANGRIFF LÄUFT');
      if(suspenseTitle)suspenseTitle.textContent=tr('TEHLİKELİ ATAK!','GEFÄHRLICHER ANGRIFF!');
      if(suspenseCopy)suspenseCopy.textContent=tr('Hücum ceza sahasına girdi. Pozisyon devam ediyor…','Der Angriff erreicht den Strafraum. Die Szene läuft …');
    }
    activeHighlight = detail;
    highlightStartedAt = performance.now();
    var stage = document.getElementById('cp-broadcast-stage');
    if (!stage) return;
    stage.classList.add('is-highlight');
    var minute = document.getElementById('cp-highlight-minute');
    var title = document.getElementById('cp-highlight-title');
    var copy = document.getElementById('cp-highlight-copy');
    if (minute) minute.textContent = Math.floor(detail.minute || 0) + '′ · ' + tr('ÖZEL AN', 'SCHLÜSSELSZENE');
    if (title) title.textContent = detail.preGoal ? tr('TEHLİKELİ ATAK!', 'GEFÄHRLICHER ANGRIFF!') : (detail.title || tr('Tehlikeli atak', 'Gefährlicher Angriff'));
    if (copy) copy.textContent = detail.preGoal ? tr('Hücum ceza sahasına girdi…', 'Der Angriff erreicht den Strafraum …') : (detail.message || '');
    window.clearTimeout(highlightTimer);
    if (document.body.classList.contains('cp-3d-fallback')) showFallbackPitch(); else start3D();
    highlightTimer = window.setTimeout(function () { returnFallbackPitch(); stage.classList.remove('is-highlight', 'is-highlight-fallback'); activeHighlight = null; }, (Number(detail.durationMs) || 7500) + 100);
    refreshCommentary();
    if(detail.preGoal){var suspenseTitle=document.getElementById('cp-highlight-title');if(suspenseTitle)suspenseTitle.textContent=tr('TEHLİKELİ ATAK!','GEFÄHRLICHER ANGRIFF!');}
  }

  function onHalftime(event) {
    var data = event.detail || {};
    if (!active) return;
    window.clearTimeout(highlightTimer);
    var stage = document.getElementById('cp-broadcast-stage');
    if (stage) stage.classList.remove('is-highlight', 'is-highlight-fallback');
    returnFallbackPitch();
    var existing = document.querySelector('.cp-halftime-card'); if (existing) existing.remove();
    var names = data.names || ['EV SAHİBİ', 'DEPLASMAN'];
    var score = data.score || [0, 0];
    var stats = data.stats || [];
    var shots = stats.map(function (s) { return s.shots || 0; });
    var xg = stats.map(function (s) { return Number(s.xg || 0).toFixed(2); });
    var possessionTotal = (stats[0] && stats[0].pos || 0) + (stats[1] && stats[1].pos || 0);
    var possession = possessionTotal ? [Math.round(100 * stats[0].pos / possessionTotal), Math.round(100 * stats[1].pos / possessionTotal)] : [50, 50];
    var card = document.createElement('section');
    card.className = 'cp-halftime-card';
    card.innerHTML = '<div class="cp-half-kicker">⏸ ' + tr('DEVRE ARASI · 15 DAKİKALIK TAKTİK PENCERESİ', 'HALBZEIT · TAKTIKPAUSE') + '</div><h2>' + tr('İlk yarı sona erdi', 'Die erste Halbzeit ist vorbei') + '</h2><div class="cp-half-score"><span>' + names[0] + '</span><b>' + score[0] + ' : ' + score[1] + '</b><span>' + names[1] + '</span></div><div class="cp-half-stats"><div><small>' + tr('ŞUT', 'SCHÜSSE') + '</small><b>' + shots[0] + '–' + shots[1] + '</b></div><div><small>xG</small><b>' + xg[0] + '–' + xg[1] + '</b></div><div><small>' + tr('TOPA SAHİP OLMA', 'BALLBESITZ') + '</small><b>' + possession[0] + '%–' + possession[1] + '%</b></div></div><p>' + tr('İkinci yarı başlamadan taktiği değiştir veya oyuncu değişikliği yap.', 'Ändere vor dem Wiederanpfiff die Taktik oder wechsle Spieler aus.') + '</p><div class="cp-half-tactics"><button data-cp-half-tactic="Dengeli">Dengeli</button><button data-cp-half-tactic="Hücum">Hücum</button><button data-cp-half-tactic="Savunma">Savunma</button><button data-cp-half-tactic="Yüksek Pres">Yüksek Pres</button><button data-cp-half-tactic="Kontra">Kontra</button></div><div class="cp-half-actions"><button class="cp-half-sub" data-cp-half-subs>🔄 ' + tr('DEĞİŞİKLİK YAP', 'AUSWECHSELN') + '</button><button class="cp-half-resume" data-cp-half-continue>▶ ' + tr('İKİNCİ YARIYA BAŞLA', 'ZWEITE HALBZEIT STARTEN') + '</button></div>';
    document.body.appendChild(card);
    requestAnimationFrame(function () { card.classList.add('is-visible'); });
  }

  function start3D() {
    if (startPending || !active || !document.getElementById('cp3d-stage')) return;
    var live = activeHighlight || window.CP_LIVE_MATCH || {};
    var evoHost = document.getElementById('cp3d-stage');
    if (window.CP_EVO_ENGINE && window.CP_EVO_ENGINE.playHighlight && live.eventId) {
      if (renderer) { renderer.dispose(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); renderer = null; scene3 = null; camera = null; ball = null; players = []; }
      try { if (window.CP_EVO_ENGINE.playHighlight(evoHost, live.eventId)) { document.body.classList.add('cp-3d-ready'); return; } } catch (e) { }
    }
    if (renderer) { draw3D(); return; }
    startPending = true;
    import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js').then(function (THREE) {
      startPending = false;
      if (active) build3D(THREE);
    }).catch(function () {
      startPending = false;
      document.body.classList.add('cp-3d-fallback');
      var status = document.getElementById('cp-stage-status');
      if (status) status.textContent = tr('3D tekrar bu cihazda açılamadı', '3D-Wiederholung auf diesem Gerät nicht verfügbar');
      var stage = document.getElementById('cp-broadcast-stage'); if (stage) stage.classList.add('is-highlight-fallback');
      showFallbackPitch();
    });
  }

  function showFallbackPitch() {
    var stage = document.getElementById('cp-broadcast-stage');
    var pitch = document.querySelector('.cp-engine-hidden .canvas-box');
    var overlay = document.getElementById('cp-highlight-overlay');
    if (stage && pitch) stage.insertBefore(pitch, overlay || null);
  }

  function returnFallbackPitch() {
    var stage = document.getElementById('cp-broadcast-stage');
    var hidden = document.querySelector('.cp-engine-hidden');
    var pitch = stage && stage.querySelector('.canvas-box');
    if (pitch && hidden) hidden.appendChild(pitch);
  }

  function build3D(THREE) {
    var host = document.getElementById('cp3d-stage');
    if (!host || !active) return;
    var scene = new THREE.Scene(); scene3 = scene;
    scene.background = new THREE.Color('#07151b');
    scene.fog = new THREE.Fog('#07151b', 105, 210);
    var width = Math.max(320, host.clientWidth || innerWidth), height = Math.max(220, host.clientHeight || 360);
    camera = new THREE.PerspectiveCamera(42, width / height, .1, 260);
    camera.position.set(0, 43, 58); camera.lookAt(0, 0, 0);
    var compactViewport = window.matchMedia('(max-width: 800px), (pointer: coarse)').matches;
    var cores = Number(navigator.hardwareConcurrency) || 0;
    var memory = Number(navigator.deviceMemory) || 0;
    var lowPowerDevice = compactViewport && ((cores > 0 && cores <= 4) || (memory > 0 && memory <= 4));
    renderer = new THREE.WebGLRenderer({ antialias: !lowPowerDevice, alpha: false, powerPreference: lowPowerDevice ? 'low-power' : 'high-performance' });
    var pixelRatioLimit = lowPowerDevice ? 1 : (compactViewport ? 1.25 : 2);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, pixelRatioLimit)); renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
    host.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight('#eaf7ff', '#203622', 2.6));
    var key = new THREE.DirectionalLight('#fff1ce', 3.1); key.position.set(-18, 56, 28); scene.add(key);
    var fill = new THREE.DirectionalLight('#a9d6ff', 1.35); fill.position.set(28, 34, -48); scene.add(fill);
    buildStadium(THREE, scene); buildPitch(THREE, scene);
    var colors = [teamColor(0), teamColor(1)];
    for (var team = 0; team < 2; team++) for (var i = 0; i < 11; i++) {
      var p = makePlayer(THREE, colors[team], team, i); scene.add(p); players.push(p);
    }
    var referee = makePlayer(THREE, '#e94f49', 2, 0); referee.scale.setScalar(.88); referee.position.set(-2, 0, 3); scene.add(referee);
    ball = new THREE.Mesh(new THREE.SphereGeometry(.11, 20, 16), new THREE.MeshStandardMaterial({ color: '#f5f1df', roughness: .42, metalness: .02 })); ball.position.y = .11; scene.add(ball);
    var ballPatch = new THREE.Mesh(new THREE.SphereGeometry(.112, 10, 8, 0, Math.PI, .15, .7), new THREE.MeshStandardMaterial({ color: '#20282b', roughness: .7 })); ball.add(ballPatch);
    renderer.domElement.setAttribute('aria-label', 'Canlı 3D futbol maçı');
    resizeHandler = function () { if (!active || !host.isConnected) return; var w = Math.max(320, host.clientWidth), h = Math.max(220, host.clientHeight); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); };
    window.addEventListener('resize', resizeHandler);
    window.__cp3D = { scene: scene, camera: camera, renderer: renderer, THREE: THREE };
    window.__cp3DScene = scene; window.__cp3DCamera = camera;
    window.__cp3DRender = renderer;
    document.body.classList.add('cp-3d-ready');
    draw3D();
  }

  function draw3D() {
    if (!renderer || !scene3 || !active || frame || !document.getElementById('cp-broadcast-stage')?.classList.contains('is-highlight')) return;
    var previous = performance.now();
    function draw(now) {
      var stage = document.getElementById('cp-broadcast-stage');
      if (!active || !renderer || !stage || !stage.classList.contains('is-highlight')) { frame = 0; return; }
      var dt = Math.min(.06, (now - previous) / 1000); previous = now;
      update3D(now, dt); renderer.render(scene3, camera); frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
  }

  function teamColor(index) {
    try {
      var found = window.CP_LIVE_MATCH && window.CP_LIVE_MATCH.colors;
      if (found && found[index]) {
        if (index === 1 && found[0]) {
          var a = String(found[0]).replace('#',''), b = String(found[1]).replace('#','');
          if (a.length === 6 && b.length === 6) {
            var d = Math.abs(parseInt(a.slice(0,2),16)-parseInt(b.slice(0,2),16)) + Math.abs(parseInt(a.slice(2,4),16)-parseInt(b.slice(2,4),16)) + Math.abs(parseInt(a.slice(4,6),16)-parseInt(b.slice(4,6),16));
            if (d < 165) return '#f1ead7';
          }
        }
        return found[index];
      }
    } catch (e) { }
    return index === 0 ? '#152648' : '#f2eddf';
  }

  function buildStadium(THREE, scene) {
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(155, 126), new THREE.MeshStandardMaterial({ color: '#0c1b20', roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -2.1; scene.add(floor);
    var colors = ['#213d47', '#29444b', '#192f38', '#304a4e'];
    for (var side = 0; side < 2; side++) for (var row = 0; row < 8; row++) {
      var stand = new THREE.Mesh(new THREE.BoxGeometry(114 + row * 3, 1.05, 3.2), new THREE.MeshStandardMaterial({ color: colors[(row + side) % colors.length], roughness: .95 }));
      stand.position.set(0, row * 1.05 - .6, (side ? -1 : 1) * (39 + row * 2.1)); scene.add(stand);
    }
    for (var end = 0; end < 2; end++) for (var er = 0; er < 6; er++) {
      var endStand = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.05, 70 + er * 2), new THREE.MeshStandardMaterial({ color: colors[(er + end + 1) % colors.length], roughness: .95 }));
      endStand.position.set((end ? -1 : 1) * (57 + er * 2), er * 1.05 - .6, 0); scene.add(endStand);
    }
    var seatGeo = new THREE.BoxGeometry(.6, .7, .55), seatMat = new THREE.MeshStandardMaterial({ color: '#d2d4c8', roughness: .9 });
    var seats = new THREE.InstancedMesh(seatGeo, seatMat, 860), dummy = new THREE.Object3D(), k = 0;
    for (var rz = 0; rz < 6; rz++) for (var j = 0; j < 72; j++) for (var sign = -1; sign <= 1; sign += 2) {
      if (k >= seats.count) break;
      dummy.position.set(-49 + j * 1.38 + Math.sin(j * 12.7 + rz) * .24, rz * 1.05 + .05, sign * (42 + rz * 2.1)); dummy.scale.set(.8, .8, .8); dummy.updateMatrix(); seats.setMatrixAt(k, dummy.matrix);
      seats.setColorAt(k, new THREE.Color(['#d4d6c8','#546e83','#c7ad78','#37515e','#85989a'][(j * 7 + rz * 3) % 5])); k++;
    }
    seats.instanceMatrix.needsUpdate = true; scene.add(seats);
    var lampMat = new THREE.MeshBasicMaterial({ color: '#fff0bd' });
    [[-57, 26, -36], [57, 26, -36], [-57, 26, 36], [57, 26, 36]].forEach(function (pos) {
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(.22, .38, 28, 6), new THREE.MeshStandardMaterial({ color: '#101f25' })); pole.position.set(pos[0], 9, pos[2]); scene.add(pole);
      var lamps = new THREE.Mesh(new THREE.BoxGeometry(5, 1.3, .7), lampMat); lamps.position.set(pos[0], 23, pos[2]); scene.add(lamps);
      var glow = new THREE.PointLight('#ffdfa1', 4.3, 40); glow.position.set(pos[0], 23, pos[2]); scene.add(glow);
    });
  }

  function buildPitch(THREE, scene) {
    var base = new THREE.Mesh(new THREE.PlaneGeometry(104, 68), new THREE.MeshStandardMaterial({ color: '#26703d', roughness: .97 })); base.rotation.x = -Math.PI / 2; base.position.y = -.35; scene.add(base);
    for (var i = 0; i < 13; i++) { var stripe = new THREE.Mesh(new THREE.PlaneGeometry(8, 67.8), new THREE.MeshStandardMaterial({ color: i % 2 ? '#2a7842' : '#236b39', roughness: 1 })); stripe.rotation.x = -Math.PI / 2; stripe.position.set(-48 + i * 8, -.33, 0); scene.add(stripe); }
    var mat = new THREE.LineBasicMaterial({ color: '#e7efdc', transparent: true, opacity: .84 });
    function line(points) { scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(function (p) { return new THREE.Vector3(p[0], .03, p[1]); })), mat)); }
    line([[-51,-33],[51,-33],[51,33],[-51,33],[-51,-33]]); line([[0,-33],[0,33]]);
    var circle = new THREE.Mesh(new THREE.RingGeometry(9.05, 9.3, 64), mat); circle.rotation.x = -Math.PI/2; circle.position.y = .045; scene.add(circle);
    var dot = new THREE.Mesh(new THREE.CircleGeometry(.45,16),mat);dot.rotation.x=-Math.PI/2;dot.position.y=.05;scene.add(dot);
    [-1,1].forEach(function (side) {
      var x=side*51;line([[x,-20],[x-side*16,-20],[x-side*16,20],[x,20]]);line([[x,-10],[x-side*5,-10],[x-side*5,10],[x,10]]);
      var goal=new THREE.Group();goal.position.set(x,0,0);scene.add(goal);var white=new THREE.MeshStandardMaterial({color:'#f4f5e9',roughness:.55});
      [[0,0],[0,-3.66],[0,3.66]].forEach(function(v){var post=new THREE.Mesh(new THREE.CylinderGeometry(.055,.055,2.44,10),white);post.position.set(side*1.1,1.22,v[1]);goal.add(post)});
      var bar=new THREE.Mesh(new THREE.BoxGeometry(.11,.11,7.32),white);bar.position.set(side*1.1,2.44,0);goal.add(bar);
      var netMat=new THREE.LineBasicMaterial({color:'#d6ddd0',transparent:true,opacity:.35});for(var z=-3.66;z<=3.67;z+=1.83){goal.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(side*1.2,.08,z),new THREE.Vector3(side*5.6,.08,z),new THREE.Vector3(side*5.6,2.36,z),new THREE.Vector3(side*1.2,2.44,z)]),netMat))}
    });
  }

  function makePlayer(THREE, color, team, number) {
    var group = new THREE.Group();
    var shirtMat = new THREE.MeshStandardMaterial({color: team===2?'#e34c43':color, roughness:.8});
    var shortsMat = new THREE.MeshStandardMaterial({color: team===0?'#14202b':'#e9e5d9', roughness:.88});
    var skinMat = new THREE.MeshStandardMaterial({color:'#bd8f70', roughness:.92});
    var bootMat = new THREE.MeshStandardMaterial({color:'#171b1c', roughness:.72});
    var trimMat = new THREE.MeshStandardMaterial({color:team===0?'#f1dfbd':'#263644', roughness:.75});
    function mesh(geo, mat, parent, x,y,z) { var m=new THREE.Mesh(geo,mat); m.position.set(x,y,z); parent.add(m); return m; }
    var torso=mesh(new THREE.CapsuleGeometry(.31,.48,5,10),shirtMat,group,0,1.34,0);
    var collar=mesh(new THREE.TorusGeometry(.13,.035,6,12),trimMat,group,0,1.64,0); collar.rotation.x=Math.PI/2;
    var head=mesh(new THREE.SphereGeometry(.19,12,10),skinMat,group,0,1.78,0);
    var hair=mesh(new THREE.SphereGeometry(.194,10,8,0,Math.PI*2,0,Math.PI*.47),bootMat,group,0,1.82,-.01);
    var shorts=mesh(new THREE.BoxGeometry(.47,.28,.28),shortsMat,group,0,.91,0);
    var armPivots=[], legPivots=[];
    [-1,1].forEach(function(side) {
      var arm=new THREE.Group(); arm.position.set(side*.37,1.54,0); group.add(arm);
      mesh(new THREE.CylinderGeometry(.075,.06,.39,8),shirtMat,arm,0,-.2,0);
      mesh(new THREE.SphereGeometry(.07,8,6),skinMat,arm,0,-.43,0);
      armPivots.push(arm);
      var leg=new THREE.Group(); leg.position.set(side*.14,.82,0); group.add(leg);
      mesh(new THREE.CylinderGeometry(.105,.075,.38,8),shortsMat,leg,0,-.19,0);
      var knee=new THREE.Group(); knee.position.set(0,-.38,0); leg.add(knee);
      mesh(new THREE.CylinderGeometry(.065,.052,.4,8),skinMat,knee,0,-.2,0);
      mesh(new THREE.BoxGeometry(.13,.09,.27),bootMat,knee,0,-.42,.075);
      leg.userData.knee=knee; legPivots.push(leg);
    });
    var stripe=mesh(new THREE.BoxGeometry(.055,.43,.018),trimMat,group,.19,1.35,.294);
    var shadow=mesh(new THREE.CircleGeometry(.36,16),new THREE.MeshBasicMaterial({color:'#07120b',transparent:true,opacity:.34}),group,0,.018,0);
    shadow.rotation.x=-Math.PI/2;
    var numberCanvas=document.createElement('canvas'); numberCanvas.width=128; numberCanvas.height=128;
    var ctx=numberCanvas.getContext('2d'); ctx.clearRect(0,0,128,128); ctx.font='900 82px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle=team===0?'#fff4da':'#17242d'; ctx.fillText(String(number||1),64,67);
    var texture=new THREE.CanvasTexture(numberCanvas); texture.colorSpace=THREE.SRGBColorSpace;
    var mark=mesh(new THREE.PlaneGeometry(.2,.22),new THREE.MeshBasicMaterial({map:texture,transparent:true,side:THREE.DoubleSide,depthWrite:false}),group,0,1.35,.305);
    group.scale.setScalar(1.02);
    group.userData={team:team,number:number,phase:Math.random()*6.28,leftLeg:legPivots[0],rightLeg:legPivots[1],leftArm:armPivots[0],rightArm:armPivots[1],speed:0,homeX:0,homeZ:0};
    return group;
  }

  function update3D(now, dt) {
    if (!ball) return;
    var live=activeHighlight||window.CP_LIVE_MATCH||{};
    var clamp=function(v,a,b){return Math.max(a,Math.min(b,v));};
    var toX=(Number(live.x==null?50:live.x)-50)*.92;
    var toZ=(Number(live.y==null?50:live.y)-50)*.58;
    var fromX=(Number(live.fromX==null?50:live.fromX)-50)*.92;
    var fromZ=(Number(live.fromY==null?50:live.fromY)-50)*.58;
    var type=String(live.event||'pass');
    var isShot=type==='shot'||type==='goal';
    var elapsed=Math.max(0,now-highlightStartedAt);
    var duration=isShot?3000:2100;
    var progress=activeHighlight?clamp(elapsed/duration,0,1):1;
    var smooth=progress*progress*(3-2*progress);
    var shotTargetX=Number(live.team||0)===0?48:-48;
    var shotTargetZ=clamp(toZ*.13,-3.3,3.3);
    var ballStartX=activeHighlight?fromX:toX, ballStartZ=activeHighlight?fromZ:toZ;
    var ballEndX=isShot?shotTargetX:toX, ballEndZ=isShot?shotTargetZ:toZ;
    var ballX=ballStartX+(ballEndX-ballStartX)*smooth;
    var ballZ=ballStartZ+(ballEndZ-ballStartZ)*smooth;
    var loft=isShot?Math.sin(Math.PI*progress)*(live.onTarget?.85:.5):type==='pass'?Math.sin(Math.PI*progress)*.24:0;
    ball.position.set(ballX,.11+loft,ballZ);
    ball.rotation.x+=dt*5; ball.rotation.z+=dt*3.7;

    var possession=Number(live.team||0), actorIndex=Number.isInteger(Number(live.actorIndex))?Number(live.actorIndex):-1, receiverIndex=Number.isInteger(Number(live.receiverIndex))?Number(live.receiverIndex):Number(live.receiver);
    players.forEach(function(player,index) {
      var team=player.userData.team, n=player.userData.number, keeper=n===0;
      var sideIndex=n, roster=live.rosters&&live.rosters[team]||[], profile=roster[n]||{}, role=String(profile.pos||'');
      var dismissed=live.dismissedIds||[]; player.visible=!dismissed.includes(String(profile.id||profile.name||''));
      if(!player.visible){player.userData.speed=0;return;}
      keeper=role==='KL'||n===0; var homeX=keeper?-43:(role==='STP'?-29:role==='SLB'||role==='SĞB'?-28:role==='DOS'?-13:role==='MO'?-3:role==='SLK'||role==='SĞK'?17:role==='SNT'?30:(sideIndex<=4?-29:sideIndex<=7?-8:15));
      var homeZ=keeper?0:(role==='SLB'||role==='SLK'?-21:role==='SĞB'||role==='SĞK'?21:((sideIndex%4)-1.5)*12);
      if(team===1) homeX=-homeX;
      var own=team===possession, chase=own?8:-3;
      var influence=keeper?.06:.19;
      var tx=homeX+(team===0?chase:-chase)+(ballX*influence);
      var tz=homeZ+ballZ*(keeper?.07:.22);
      var isActor=own&&sideIndex===actorIndex, nearest=sideIndex===receiverIndex;
      if(isActor&&!keeper){if(type==='pass'){tx=fromX;tz=fromZ;}else{tx=ballX+(type==='dribble'?0:1.5);tz=ballZ+(sideIndex%2?1:-1);}}
      if(own&&nearest&&!keeper&&type==='pass'){tx=toX;tz=toZ;}
      if(!own&&!keeper&&Math.abs(sideIndex-(receiverIndex<0?actorIndex:receiverIndex))<2){tx=ballX-3;tz=ballZ+(sideIndex%2?2:-2);}
      tx=clamp(tx,-46,46);tz=clamp(tz,-31,31);
      var dx=tx-player.position.x,dz=tz-player.position.z,dist=Math.hypot(dx,dz);
      var targetSpeed=activeHighlight?clamp(dist*1.25,1.8,7.2):.7;
      player.userData.speed+=(targetSpeed-player.userData.speed)*Math.min(1,dt*2.4);
      var blend=1-Math.exp(-Math.max(.01,player.userData.speed)*dt/Math.max(1,dist));
      player.position.x+=dx*blend; player.position.z+=dz*blend;
      var running=dist>.65&&activeHighlight, cadence=now*.0095+player.userData.phase;
      var stride=running?Math.min(1,player.userData.speed/5):.1;
      var swing=Math.sin(cadence)*.62*stride;
      player.userData.leftLeg.rotation.x=swing; player.userData.rightLeg.rotation.x=-swing;
      player.userData.leftLeg.userData.knee.rotation.x=Math.max(0,-swing)*.8;
      player.userData.rightLeg.userData.knee.rotation.x=Math.max(0,swing)*.8;
      player.userData.leftArm.rotation.x=-swing*.58; player.userData.rightArm.rotation.x=swing*.58;
      player.position.y=running?Math.abs(Math.sin(cadence*2))*.035:0; player.rotation.z+=(0-player.rotation.z)*Math.min(1,dt*3);
      var faceX=dx,faceZ=dz;
      if(own&&nearest){faceX=ballX-player.position.x;faceZ=ballZ-player.position.z;}
      player.rotation.y=Math.atan2(faceX,faceZ);
    });
    if(isShot&&progress>.72&&players.length) {
      var keeper=players.find(function(p){return p.userData.team===1-possession&&p.userData.number===0;});
      if(keeper){keeper.position.x+=(shotTargetX+(possession===0?-2:2)-keeper.position.x)*Math.min(1,dt*2);keeper.position.z+=(shotTargetZ-keeper.position.z)*Math.min(1,dt*2);keeper.rotation.z=Math.sin(progress*Math.PI)*.7;}
    }
    var minute=Number(live.minute||0),clock=document.getElementById('cp-watch-clock');
    if(clock)clock.textContent=String(Math.floor(minute)).padStart(2,'0')+':00';
    var chip=document.getElementById('cp-live-chip');
    if(chip)chip.innerHTML='<i></i>'+(live.running?tr('CANLI · ','LIVE · ')+Math.floor(minute)+'′':minute>=90?tr('TAMAMLANDI','BEENDET'):tr('MAÇ GÜNÜ','SPIELTAG'));
    if(camera&&camera.position){
      var camX=ballX*.34,camZ=ballZ+46;
      camera.position.x+=(camX-camera.position.x)*Math.min(1,dt*1.05);
      camera.position.z+=(camZ-camera.position.z)*Math.min(1,dt*1.05);
      camera.lookAt(ballX,.3,ballZ);
    }
  }

  function stop3D() {
    if (window.CP_EVO_ENGINE && window.CP_EVO_ENGINE.stopRenderer) { try { window.CP_EVO_ENGINE.stopRenderer(); } catch (e) { } }
    if(frame)cancelAnimationFrame(frame);frame=0;
    if(resizeHandler)window.removeEventListener('resize',resizeHandler);resizeHandler=null;
    if(renderer){renderer.dispose();if(renderer.domElement.parentNode)renderer.domElement.parentNode.removeChild(renderer.domElement)}
    renderer=null;scene3=null;camera=null;ball=null;players=[];startPending=false;
    document.body.classList.remove('cp-3d-ready','cp-3d-fallback');
    delete window.__cp3D;delete window.__cp3DScene;delete window.__cp3DCamera;delete window.__cp3DRender;
  }

  var content = document.getElementById('content');
  if (content) {
    var observer = new MutationObserver(function () { mountMatchPage(); leaveMatchPage(); });
    observer.observe(content, { childList: true, subtree: true });
    mountMatchPage();
  }
  var overlay = document.getElementById('overlay');
  if (overlay) {
    var finishObserver = new MutationObserver(showCompletedMatch);
    finishObserver.observe(overlay, { childList: true, subtree: true, characterData: true });
  }
})();
