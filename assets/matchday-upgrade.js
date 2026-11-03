(function () {
  'use strict';

  var originalMatchScene = window.matchScene;
  var originalFinish = window.finish;
  var originalScene = window.scene;
  var threeState = { active: false, started: false, raf: 0, renderer: null, scene: null, camera: null, ball: null, players: [], lastEvent: null, lastEventAt: 0 };
  var language = function () { try { return localStorage.getItem('cp-ui-language-2026') === 'de' ? 'de' : 'tr'; } catch (e) { return 'tr'; } };
  var tr = function (turkish, german) { return language() === 'de' ? german : turkish; };

  function nodeByClass(root, selector) {
    var value = root.querySelector(selector);
    return value ? value.outerHTML : '';
  }

  function getMatchFragments(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    var root = template.content;
    var hub = root.querySelector('.cp13-hub');
    var pitch = root.querySelector('.canvas-box');
    var score = root.querySelector('.scorebar');
    var controls = root.querySelector('.match-buttons');
    var tactics = root.querySelector('.touchline');
    var insights = root.querySelector('.match-insights');
    var substitutions = root.querySelector('.career-panel');
    return {
      hub: hub ? hub.outerHTML : '',
      pitch: pitch ? pitch.outerHTML : '<div class="canvas-box"><canvas id="pitch" width="900" height="510"></canvas></div>',
      score: score ? score.outerHTML : '<div class="scorebar"><b>' + (window.state && esc(state.club) || '') + '</b><strong id="score">0 : 0</strong><span class="minute" id="minute">0′</span><b>' + (window.rival && esc(rival()) || '') + '</b></div>',
      controls: controls ? controls.outerHTML : '',
      tactics: tactics ? tactics.outerHTML : '',
      insights: insights ? insights.outerHTML : '<div class="panel match-insights"><span id="live"></span><span id="liveAdvice"></span><div id="statPanel"></div><div id="log"></div></div>',
      substitutions: substitutions ? substitutions.outerHTML : ''
    };
  }

  window.matchScene = function () {
    var original = originalMatchScene();
    var parts = getMatchFragments(original);
    threeState.active = true;
    document.body.classList.add('cp-match-active');
    window.requestAnimationFrame(function () { if (document.getElementById('cp-watch-page')) start3D(); });
    var ready = window.state && state.date >= state.next;
    var returnLabel = tr('KULÜBEYE DÖN', 'ZURÜCK ZUR BANK');
    return '<main class="cp-watch-page" id="cp-watch-page">' +
      '<header class="cp-watch-top"><button type="button" class="cp-return" data-cp-return>‹ <span>' + returnLabel + '</span></button><div class="cp-broadcast-brand"><span>CP</span><b>CLUB PRESIDENT</b><small>' + tr('MAÇ YAYINI', 'SPIELÜBERTRAGUNG') + '</small></div><span class="cp-live-chip" id="cp-live-chip"><i></i>' + (ready ? tr('HAZIR', 'BEREIT') : tr('BEKLENİYOR', 'WARTET')) + '</span></header>' +
      '<section class="cp-score-card">' + parts.score + '<div class="cp-score-sub"><span>' + tr('LİG MAÇI', 'LIGASPIEL') + ' · ' + ((window.state && state.round || 0) + 1) + '. ' + tr('HAFTA', 'SPIELTAG') + '</span><span id="cp-watch-clock">00:00</span></div></section>' +
      '<section class="cp-broadcast-stage"><div class="cp-stadium-lights"></div><div class="cp3d-stage" id="cp3d-stage" aria-label="3D futbol sahası"></div>' + parts.pitch + '<div class="cp-stage-overlay"><span class="cp-possession-label">' + tr('TAKTİK KAMERA', 'TAKTIKKAMERA') + '</span><span class="cp-stage-status" id="cp-stage-status">' + tr('Maç başlamak üzere', 'Anpfiff steht bevor') + '</span></div></section>' +
      '<section class="cp-watch-controls">' + parts.controls + '<div class="cp-watch-note">' + tr('Kararların ve maç sonucu mevcut kariyer kaydına işlenir.', 'Taktik und Ergebnis werden im aktuellen Spielstand gespeichert.') + '</div></section>' +
      '<section class="cp-tactic-card">' + parts.tactics + '</section>' +
      '<section class="cp-watch-data">' + (parts.hub || '') + '</section>' +
      (parts.substitutions ? '<details class="cp-subs"><summary>' + tr('Oyuncu değişiklikleri', 'Auswechslungen') + '</summary>' + parts.substitutions + '</details>' : '') +
      '<div class="cp-engine-hidden" aria-hidden="true">' + parts.insights + '</div>' +
      '</main>';
  };

  window.scene = function (next) {
    if (next !== 'match') stop3D();
    document.body.classList.remove('cp-match-active');
    return originalScene(next);
  };

  window.finish = function () {
    var wasWatching = window.screen === 'match' && !!window.mt;
    var result = window.mt ? { home: mt.home, away: mt.away, club: state.club, opponent: rival() } : null;
    originalFinish();
    if (!wasWatching || !result || !window.state) return;
    var finalReport = state.lastMatchReport13 || {};
    var score = result.home + '–' + result.away;
    var outcome = result.home > result.away ? tr('Galibiyet', 'Sieg') : result.home < result.away ? tr('Mağlubiyet', 'Niederlage') : tr('Beraberlik', 'Unentschieden');
    var mvp = finalReport.mvp && finalReport.mvp.name ? finalReport.mvp.name : tr('Maç raporu kaydedildi', 'Spielbericht gespeichert');
    if (window.close) close();
    document.body.classList.remove('cp-match-active');
    originalScene('office');
    var card = document.createElement('aside');
    card.className = 'cp-return-result';
    card.setAttribute('role', 'status');
    card.innerHTML = '<button class="cp-result-close" type="button" aria-label="Kapat">×</button><span class="cp-result-kicker">' + tr('MAÇ TAMAMLANDI · KAYIT GÜNCELLENDİ', 'SPIEL BEENDET · SPIELSTAND AKTUALISIERT') + '</span><b class="cp-result-title">' + outcome + '</b><strong class="cp-result-score">' + esc(result.club) + ' <i>' + score + '</i> ' + esc(result.opponent) + '</strong><small>⭐ ' + tr('Maçın oyuncusu', 'Spieler des Spiels') + ': ' + esc(mvp) + '</small><button class="cp-result-report" data-a="report">' + tr('MAÇ RAPORUNU AÇ', 'SPIELBERICHT ÖFFNEN') + ' →</button>';
    document.body.appendChild(card);
    requestAnimationFrame(function () { card.classList.add('is-visible'); });
    card.querySelector('.cp-result-close').addEventListener('click', function () { card.remove(); });
    window.setTimeout(function () { if (card.isConnected) { card.classList.remove('is-visible'); window.setTimeout(function () { if (card.isConnected) card.remove(); }, 350); } }, 13000);
    stop3D();
  };

  document.addEventListener('click', function (event) {
    var back = event.target.closest('[data-cp-return]');
    if (back) {
      event.preventDefault();
      if (window.mt) mt.running = false;
      if (window.clearInterval) clearInterval(window.interval);
      window.scene('office');
      if (window.toast) toast(tr('Maç duraklatıldı. İstediğinde devam edebilirsin.', 'Spiel pausiert. Du kannst jederzeit fortfahren.'));
    }
    if (event.target.closest('[data-cp13-tab]')) {
      window.setTimeout(function () { var page = document.getElementById('cp-watch-page'); if (page) page.scrollIntoView({ block: 'start' }); }, 0);
    }
  }, true);

  function start3D() {
    if (threeState.started || !threeState.active || !document.getElementById('cp3d-stage')) return;
    threeState.started = true;
    import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js').then(function (THREE) {
      if (!threeState.active) return;
      build3D(THREE);
    }).catch(function () {
      threeState.started = false;
      document.body.classList.add('cp-3d-fallback');
      var stage = document.getElementById('cp-stage-status');
      if (stage) stage.textContent = tr('Yedek saha görünümü etkin', 'Ersatzansicht aktiv');
    });
  }

  function build3D(THREE) {
    var host = document.getElementById('cp3d-stage');
    if (!host || !threeState.active) return;
    var width = Math.max(320, host.clientWidth || window.innerWidth);
    var height = Math.max(220, host.clientHeight || 360);
    var scene3 = new THREE.Scene();
    scene3.background = new THREE.Color('#07151b');
    scene3.fog = new THREE.Fog('#07151b', 105, 210);
    var camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 260);
    camera.position.set(0, 77, 91);
    camera.lookAt(0, 0, 0);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = false;
    host.appendChild(renderer.domElement);
    threeState.renderer = renderer;
    threeState.scene = scene3;
    threeState.camera = camera;
    scene3.add(new THREE.HemisphereLight('#eaf7ff', '#203622', 2.0));
    var key = new THREE.DirectionalLight('#fff1ce', 2.4); key.position.set(-18, 56, 28); scene3.add(key);
    var blue = new THREE.DirectionalLight('#a9d6ff', 1.1); blue.position.set(28, 34, -48); scene3.add(blue);
    addStadium(THREE, scene3);
    addPitch(THREE, scene3);
    var teams = [window.state && state.club || 'EV SAHİBİ', window.rival ? rival() : 'DEPLASMAN'];
    var colors = [getTeamColor(0), getTeamColor(1)];
    for (var t = 0; t < 2; t++) for (var i = 0; i < 11; i++) {
      var player = makePlayer(THREE, colors[t], t, i);
      player.userData.teamName = teams[t]; scene3.add(player); threeState.players.push(player);
    }
    var ref = makePlayer(THREE, '#ed4c47', 2, 0); ref.scale.setScalar(.9); ref.position.set(-3, 0, 3); scene3.add(ref);
    var ball = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 16), new THREE.MeshStandardMaterial({ color: '#f5f1df', roughness: .5, metalness: .02 }));
    ball.position.set(0, .8, 0); scene3.add(ball); threeState.ball = ball;
    var patch = new THREE.Mesh(new THREE.SphereGeometry(.76, 10, 8, 0, Math.PI, .15, .7), new THREE.MeshStandardMaterial({ color: '#20282b', roughness: .7 }));
    ball.add(patch);
    var resize = function () { if (!threeState.active || !host.isConnected) return; var w = Math.max(320, host.clientWidth), h = Math.max(220, host.clientHeight); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); };
    window.addEventListener('resize', resize);
    threeState.resize = resize;
    document.body.classList.add('cp-3d-ready');
    var lastFrame = performance.now();
    var draw = function (now) {
      if (!threeState.active || !host.isConnected) return;
      var dt = Math.min(.06, (now - lastFrame) / 1000); lastFrame = now;
      update3D(THREE, now, dt);
      renderer.render(scene3, camera);
      threeState.raf = requestAnimationFrame(draw);
    };
    threeState.raf = requestAnimationFrame(draw);
  }

  function getTeamColor(index) {
    try { var club = window.clubs && clubs.find(function (c) { return c[0] === (index === 0 ? state.club : rival()); }); if (club && club[2]) return club[2]; } catch (e) { }
    return index === 0 ? '#18234e' : '#eee9d9';
  }

  function addStadium(THREE, scene3) {
    var dark = new THREE.MeshStandardMaterial({ color: '#101f25', roughness: .93 });
    var standMat = ['#213d47', '#29444b', '#192f38', '#304a4e'].map(function (c) { return new THREE.MeshStandardMaterial({ color: c, roughness: 1 }); });
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(155, 126), new THREE.MeshStandardMaterial({ color: '#0c1b20', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -2.1; scene3.add(floor);
    for (var side = 0; side < 2; side++) for (var row = 0; row < 8; row++) {
      var length = 114 + row * 3, depth = 3.2;
      var stand = new THREE.Mesh(new THREE.BoxGeometry(length, 1.05, depth), standMat[(row + side) % standMat.length]);
      stand.position.set(0, row * 1.05 - .6, (side ? -1 : 1) * (39 + row * 2.1)); scene3.add(stand);
    }
    for (var end = 0; end < 2; end++) for (var row2 = 0; row2 < 6; row2++) {
      var standEnd = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.05, 70 + row2 * 2), standMat[(row2 + end + 1) % standMat.length]);
      standEnd.position.set((end ? -1 : 1) * (57 + row2 * 2), row2 * 1.05 - .6, 0); scene3.add(standEnd);
    }
    var seatGeo = new THREE.BoxGeometry(.6, .7, .55);
    var seatMats = ['#d4d6c8', '#546e83', '#c7ad78', '#37515e', '#85989a'].map(function (c) { return new THREE.MeshStandardMaterial({ color: c, roughness: .9 }); });
    var seats = new THREE.InstancedMesh(seatGeo, seatMats[0], 860); var dummy = new THREE.Object3D(); var k = 0;
    for (var rz = 0; rz < 6; rz++) for (var j = 0; j < 72; j++) for (var side2 = -1; side2 <= 1; side2 += 2) {
      if (k >= seats.count) break;
      var x = -49 + j * 1.38 + Math.sin(j * 12.7 + rz) * .24, z = side2 * (42 + rz * 2.1);
      dummy.position.set(x, rz * 1.05 + .05, z); dummy.rotation.y = Math.PI; dummy.scale.set(.8, .8, .8); dummy.updateMatrix(); seats.setMatrixAt(k, dummy.matrix); seats.setColorAt(k, new THREE.Color(seatMats[(j * 7 + rz * 3) % seatMats.length].color)); k++;
    }
    seats.instanceMatrix.needsUpdate = true; scene3.add(seats);
    var lampMat = new THREE.MeshBasicMaterial({ color: '#fff0bd' });
    [[-57, 26, -36], [57, 26, -36], [-57, 26, 36], [57, 26, 36]].forEach(function (p) {
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(.22, .38, 28, 6), dark); pole.position.set(p[0], 9, p[2]); scene3.add(pole);
      var lamp = new THREE.Mesh(new THREE.BoxGeometry(5, 1.3, .7), lampMat); lamp.position.set(p[0], 23, p[2]); scene3.add(lamp);
      var glow = new THREE.PointLight('#ffdfa1', 4.3, 40); glow.position.set(p[0], 23, p[2]); scene3.add(glow);
    });
  }

  function addPitch(THREE, scene3) {
    var base = new THREE.Mesh(new THREE.PlaneGeometry(104, 68), new THREE.MeshStandardMaterial({ color: '#26703d', roughness: .97 })); base.rotation.x = -Math.PI / 2; base.position.y = -.35; scene3.add(base);
    for (var i = 0; i < 13; i++) { var stripe = new THREE.Mesh(new THREE.PlaneGeometry(8, 67.8), new THREE.MeshStandardMaterial({ color: i % 2 ? '#2a7842' : '#236b39', roughness: 1 })); stripe.rotation.x = -Math.PI / 2; stripe.position.set(-48 + i * 8, -.33, 0); scene3.add(stripe); }
    var lineMat = new THREE.LineBasicMaterial({ color: '#e7efdc', transparent: true, opacity: .84 });
    function line(points) { var geo = new THREE.BufferGeometry().setFromPoints(points.map(function (p) { return new THREE.Vector3(p[0], .03, p[1]); })); scene3.add(new THREE.Line(geo, lineMat)); }
    line([[-51,-33],[51,-33],[51,33],[-51,33],[-51,-33]]); line([[0,-33],[0,33]]);
    var center = new THREE.Mesh(new THREE.RingGeometry(9.05, 9.3, 64), lineMat); center.rotation.x = -Math.PI / 2; center.position.y = .045; scene3.add(center);
    var spot = new THREE.Mesh(new THREE.CircleGeometry(.45, 16), lineMat); spot.rotation.x = -Math.PI / 2; spot.position.y = .05; scene3.add(spot);
    [-1,1].forEach(function (side) {
      var x = side * 51;
      line([[x,-20],[x-side*16,-20],[x-side*16,20],[x,20]]); line([[x,-10],[x-side*5,-10],[x-side*5,10],[x,10]]);
      var goalMat = new THREE.MeshStandardMaterial({ color: '#f4f5e9', roughness: .55 });
      var goal = new THREE.Group(); goal.position.set(x, 0, 0); scene3.add(goal);
      [[0,0,0],[0,0,-7.3],[0,0,7.3]].forEach(function (v) { var post = new THREE.Mesh(new THREE.CylinderGeometry(.24,.24,4.8,8),goalMat); post.position.set(side*1.1,2.4,v[2]); goal.add(post); });
      var bar = new THREE.Mesh(new THREE.BoxGeometry(.45,.38,14.6),goalMat); bar.position.set(side*1.1,4.8,0); goal.add(bar);
      var netMat = new THREE.LineBasicMaterial({ color: '#d6ddd0', transparent:true, opacity:.35 });
      for(var g=-7;g<=7;g+=3.5){var pts=[new THREE.Vector3(side*1.4,.2,g),new THREE.Vector3(side*7,.2,g),new THREE.Vector3(side*7,4.5,g),new THREE.Vector3(side*1.4,4.8,g)];goal.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),netMat));}
    });
  }

  function makePlayer(THREE, color, team, number) {
    var group = new THREE.Group();
    var jersey = new THREE.MeshStandardMaterial({ color: color, roughness: .72, metalness: .02 });
    var skin = new THREE.MeshStandardMaterial({ color: '#d4a37c', roughness: .8 });
    var shorts = new THREE.MeshStandardMaterial({ color: team === 0 ? '#111827' : '#d8d5ca', roughness: .86 });
    var body = new THREE.Mesh(new THREE.CapsuleGeometry(.75, 1.1, 3, 7), jersey); body.position.y = 2.1; group.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(.42, 10, 8), skin); head.position.y = 3.2; group.add(head);
    var shortsMesh = new THREE.Mesh(new THREE.CylinderGeometry(.68,.55,.65,8), shorts); shortsMesh.position.y = 1.2; group.add(shortsMesh);
    for(var leg=0;leg<2;leg++){var limb=new THREE.Mesh(new THREE.CylinderGeometry(.16,.12,1.05,6),team===2?jersey:shorts);limb.position.set(leg? .27:-.27,.53,0);limb.rotation.z=(leg?-.08:.08);group.add(limb);}
    for(var arm=0;arm<2;arm++){var sleeve=new THREE.Mesh(new THREE.CylinderGeometry(.18,.13,.86,6),jersey);sleeve.position.set(arm?.8:-.8,2.22,0);sleeve.rotation.z=arm?-.35:.35;group.add(sleeve);}
    var shadow = new THREE.Mesh(new THREE.CircleGeometry(1.15, 12), new THREE.MeshBasicMaterial({ color:'#07120b',transparent:true,opacity:.32 })); shadow.rotation.x=-Math.PI/2;shadow.position.y=.02;group.add(shadow);
    group.userData={team:team,number:number,phase:Math.random()*6.28};
    return group;
  }

  function update3D(THREE, now, dt) {
    var match = window.mt;
    if (!match || !threeState.ball) return;
    var bx = (Number(match.x == null ? 50 : match.x) - 50) * .92;
    var bz = (Number(match.y == null ? 50 : match.y) - 50) * .58;
    var stamp = match.lastEvent ? [match.min, match.lastEvent.type, match.lastEvent.player].join('|') : '';
    if (stamp && stamp !== threeState.lastEvent) { threeState.lastEvent = stamp; threeState.lastEventAt = now; }
    var t = (now - threeState.lastEventAt) / 1000;
    var shot = match.lastEvent && (match.lastEvent.type === 'shot' || match.lastEvent.type === 'goal');
    var height = shot && t < .75 ? Math.sin(Math.min(1, t / .75) * Math.PI) * 5.4 : 0;
    threeState.ball.position.set(bx, .78 + height, bz);
    threeState.ball.rotation.set(now*.002, now*.003, now*.0012);
    var holder = Number(match.lastEvent && match.lastEvent.team || 0);
    threeState.players.forEach(function (player, index) {
      var team = player.userData.team, n = index % 11, keeper = n === 0;
      var line = keeper ? -43 : n <= 4 ? -28 : n <= 7 ? -8 : 16;
      var lane = keeper ? 0 : ((n % 4) - 1.5) * 13;
      if (team === 1) line = -line;
      var push = holder === team ? 7 : -2;
      var targetX = line + (team === 0 ? push : -push) + bx * (keeper ? .05 : .17);
      var targetZ = lane + bz * (keeper ? .08 : .19);
      var drift = Math.sin(now*.0016 + player.userData.phase) * .75;
      player.position.x += (targetX-player.position.x)*Math.min(1,dt*3.2);
      player.position.z += (targetZ-player.position.z)*Math.min(1,dt*3.2);
      player.position.y = Math.abs(Math.sin(now*.008 + player.userData.phase))*.08;
      player.rotation.y = team === 0 ? Math.PI/2 : -Math.PI/2;
      player.rotation.z = drift*.035;
    });
    var clock = document.getElementById('cp-watch-clock'); if (clock) clock.textContent = String(Math.floor(match.min)).padStart(2,'0') + ':00';
    var minute = document.getElementById('cp-live-chip'); if (minute) minute.innerHTML = '<i></i>' + (match.running ? tr('CANLI · ', 'LIVE · ') + Math.floor(match.min) + '′' : match.min >= 90 ? tr('TAMAMLANDI', 'BEENDET') : tr('DURAKLATILDI', 'PAUSIERT'));
    var stage = document.getElementById('cp-stage-status'); if (stage && match.lastEvent && match.lastEvent.msg) stage.textContent = Math.floor(match.min) + '′ · ' + match.lastEvent.msg;
  }

  function stop3D() {
    threeState.active = false;
    if (threeState.raf) cancelAnimationFrame(threeState.raf);
    if (threeState.resize) window.removeEventListener('resize', threeState.resize);
    if (threeState.renderer) { threeState.renderer.dispose(); var canvas = threeState.renderer.domElement; if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    threeState.started = false; threeState.renderer = null; threeState.scene = null; threeState.camera = null; threeState.ball = null; threeState.players = [];
    document.body.classList.remove('cp-3d-ready', 'cp-3d-fallback');
  }

  threeState.active = true;
})();
