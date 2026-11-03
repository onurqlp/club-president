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
    page.innerHTML = '<header class="cp-watch-top"><button type="button" class="cp-return" data-cp-return>‹ <span>' + tr('KULÜBEYE DÖN', 'ZURÜCK ZUR BANK') + '</span></button><div class="cp-broadcast-brand"><span>CP</span><b>CLUB PRESIDENT</b><small>' + tr('MAÇ YAYINI', 'SPIELÜBERTRAGUNG') + '</small></div><span class="cp-live-chip" id="cp-live-chip"><i></i>' + tr('MAÇ GÜNÜ', 'SPIELTAG') + '</span></header>' +
      '<section class="cp-score-card"><div class="cp-score-inner"></div><div class="cp-score-sub"><span>' + tr('CANLI MAÇ MOTORU', 'LIVE-SPIELSIMULATION') + '</span><span id="cp-watch-clock">00:00</span></div></section>' +
      '<section class="cp-broadcast-stage"><div class="cp-stadium-lights"></div><div class="cp3d-stage" id="cp3d-stage" aria-label="3D futbol sahası"></div><div class="cp-stage-overlay"><span class="cp-possession-label">' + tr('TAKTİK KAMERA', 'TAKTIKKAMERA') + '</span><span class="cp-stage-status" id="cp-stage-status">' + tr('Maç başlamak üzere', 'Anpfiff steht bevor') + '</span></div></section>' +
      '<section class="cp-watch-controls"><div class="cp-controls-inner"></div><div class="cp-watch-note">' + tr('Kararların ve maç sonucu bu kariyer kaydına işlenir.', 'Taktik und Ergebnis werden in diesem Spielstand gespeichert.') + '</div></section>' +
      '<section class="cp-tactic-card"><div class="cp-tactics-inner"></div></section>' +
      '<section class="cp-watch-data"></section><details class="cp-subs"><summary>' + tr('Oyuncu değişiklikleri', 'Auswechslungen') + '</summary><div class="cp-subs-inner"></div></details><div class="cp-engine-hidden"></div>';

    page.querySelector('.cp-score-inner').appendChild(score);
    page.querySelector('.cp-broadcast-stage').appendChild(pitch);
    page.querySelector('.cp-controls-inner').appendChild(controls);
    if (tactics) page.querySelector('.cp-tactics-inner').appendChild(tactics);
    if (hub) page.querySelector('.cp-watch-data').appendChild(hub);
    if (substitutions) page.querySelector('.cp-subs-inner').appendChild(substitutions);
    if (insights) page.querySelector('.cp-engine-hidden').appendChild(insights);
    sceneRoot.replaceChildren(page);
    page.querySelectorAll('.cp13-tab').forEach(function (tab) {
      var label = tab.textContent || '';
      if (label.indexOf('OYUNCU') >= 0) tab.textContent = '⭐ ' + tr('OYUNCU', 'SPIELER');
      if (label.indexOf('ANALİZ') >= 0) tab.textContent = '📊 ' + tr('ANALİZ', 'ANALYSE');
      if (label.indexOf('OLAYLAR') >= 0) tab.textContent = '📡 ' + tr('OLAYLAR', 'EREIGNISSE');
    });
    start3D();
  }

  function leaveMatchPage() {
    if (document.getElementById('cp-watch-page')) return;
    if (document.querySelector('#content .room.match')) return;
    if (!active) return;
    active = false;
    document.body.classList.remove('cp-match-active');
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
      var office = document.querySelector('#nav [data-sc="office"]');
      if (office) office.click();
      if (window.toast) toast(tr('Maç duraklatıldı. İstediğinde devam edebilirsin.', 'Spiel pausiert. Du kannst jederzeit fortfahren.'));
    }
  }, true);

  function start3D() {
    if (startPending || !active || !document.getElementById('cp3d-stage')) return;
    startPending = true;
    import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js').then(function (THREE) {
      startPending = false;
      if (active) build3D(THREE);
    }).catch(function () {
      startPending = false;
      document.body.classList.add('cp-3d-fallback');
      var status = document.getElementById('cp-stage-status');
      if (status) status.textContent = tr('Yedek saha görünümü etkin', 'Ersatzansicht aktiv');
    });
  }

  function build3D(THREE) {
    var host = document.getElementById('cp3d-stage');
    if (!host || !active) return;
    var scene = new THREE.Scene();
    scene.background = new THREE.Color('#07151b');
    scene.fog = new THREE.Fog('#07151b', 105, 210);
    var width = Math.max(320, host.clientWidth || innerWidth), height = Math.max(220, host.clientHeight || 360);
    var camera = new THREE.PerspectiveCamera(42, width / height, .1, 260);
    camera.position.set(0, 77, 91); camera.lookAt(0, 0, 0);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.35)); renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight('#eaf7ff', '#203622', 2));
    var key = new THREE.DirectionalLight('#fff1ce', 2.4); key.position.set(-18, 56, 28); scene.add(key);
    var fill = new THREE.DirectionalLight('#a9d6ff', 1.1); fill.position.set(28, 34, -48); scene.add(fill);
    buildStadium(THREE, scene); buildPitch(THREE, scene);
    var colors = [teamColor(0), teamColor(1)];
    for (var team = 0; team < 2; team++) for (var i = 0; i < 11; i++) {
      var p = makePlayer(THREE, colors[team], team, i); scene.add(p); players.push(p);
    }
    var referee = makePlayer(THREE, '#e94f49', 2, 0); referee.scale.setScalar(.88); referee.position.set(-2, 0, 3); scene.add(referee);
    ball = new THREE.Mesh(new THREE.SphereGeometry(.72, 18, 14), new THREE.MeshStandardMaterial({ color: '#f5f1df', roughness: .52 })); ball.position.y = .78; scene.add(ball);
    var ballPatch = new THREE.Mesh(new THREE.SphereGeometry(.73, 10, 8, 0, Math.PI, .15, .7), new THREE.MeshStandardMaterial({ color: '#20282b', roughness: .7 })); ball.add(ballPatch);
    renderer.domElement.setAttribute('aria-label', 'Canlı 3D futbol maçı');
    resizeHandler = function () { if (!active || !host.isConnected) return; var w = Math.max(320, host.clientWidth), h = Math.max(220, host.clientHeight); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false); };
    window.addEventListener('resize', resizeHandler);
    window.__cp3D = { scene: scene, camera: camera, renderer: renderer };
    window.__cp3DScene = scene; window.__cp3DCamera = camera;
    window.__cp3DRender = renderer;
    document.body.classList.add('cp-3d-ready');
    var previous = performance.now();
    function draw(now) { if (!active || !host.isConnected) return; var dt = Math.min(.06, (now - previous) / 1000); previous = now; update3D(now, dt); renderer.render(scene, camera); frame = requestAnimationFrame(draw); }
    frame = requestAnimationFrame(draw);
  }

  function teamColor(index) {
    try { var found = window.CP_LIVE_MATCH && window.CP_LIVE_MATCH.colors; if (found && found[index]) return found[index]; } catch (e) { }
    return index === 0 ? '#18234e' : '#eee9d9';
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
      [[0,0],[0,-7.3],[0,7.3]].forEach(function(v){var post=new THREE.Mesh(new THREE.CylinderGeometry(.24,.24,4.8,8),white);post.position.set(side*1.1,2.4,v[1]);goal.add(post)});
      var bar=new THREE.Mesh(new THREE.BoxGeometry(.45,.38,14.6),white);bar.position.set(side*1.1,4.8,0);goal.add(bar);
      var netMat=new THREE.LineBasicMaterial({color:'#d6ddd0',transparent:true,opacity:.35});for(var z=-7;z<=7;z+=3.5){goal.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(side*1.4,.2,z),new THREE.Vector3(side*7,.2,z),new THREE.Vector3(side*7,4.5,z),new THREE.Vector3(side*1.4,4.8,z)]),netMat))}
    });
  }

  function makePlayer(THREE, color, team, number) {
    var group=new THREE.Group(),shirt=new THREE.MeshStandardMaterial({color:color,roughness:.72}),skin=new THREE.MeshStandardMaterial({color:'#d4a37c',roughness:.8}),shorts=new THREE.MeshStandardMaterial({color:team===0?'#111827':'#d8d5ca',roughness:.86});
    var body=new THREE.Mesh(new THREE.CapsuleGeometry(.75,1.1,3,7),shirt);body.position.y=2.1;group.add(body);
    var head=new THREE.Mesh(new THREE.SphereGeometry(.42,10,8),skin);head.position.y=3.2;group.add(head);
    var shortMesh=new THREE.Mesh(new THREE.CylinderGeometry(.68,.55,.65,8),shorts);shortMesh.position.y=1.2;group.add(shortMesh);
    for(var leg=0;leg<2;leg++){var limb=new THREE.Mesh(new THREE.CylinderGeometry(.16,.12,1.05,6),team===2?shirt:shorts);limb.position.set(leg?.27:-.27,.53,0);limb.rotation.z=leg?-.08:.08;group.add(limb)}
    for(var arm=0;arm<2;arm++){var sleeve=new THREE.Mesh(new THREE.CylinderGeometry(.18,.13,.86,6),shirt);sleeve.position.set(arm?.8:-.8,2.22,0);sleeve.rotation.z=arm?-.35:.35;group.add(sleeve)}
    var shadow=new THREE.Mesh(new THREE.CircleGeometry(1.15,12),new THREE.MeshBasicMaterial({color:'#07120b',transparent:true,opacity:.32}));shadow.rotation.x=-Math.PI/2;shadow.position.y=.02;group.add(shadow);
    group.userData={team:team,number:number,phase:Math.random()*6.28};return group;
  }

  function update3D(now, dt) {
    if (!ball) return;
    var live = window.CP_LIVE_MATCH || {};
    var bx = (Number(live.x == null ? 50 : live.x) - 50) * .92;
    var bz = (Number(live.y == null ? 50 : live.y) - 50) * .58;
    var isShot = live.event === 'shot' || live.event === 'goal';
    var loft = isShot ? Math.max(0, Math.sin(now / 220) * 2.8) : 0;
    ball.position.set(bx, .78 + loft, bz); ball.rotation.set(now*.002,now*.003,now*.0012);
    var possession = Number(live.team || 0);
    players.forEach(function (player, index) {
      var team=player.userData.team,n=index%11,keeper=n===0,line=keeper?-43:n<=4?-28:n<=7?-8:16,lane=keeper?0:((n%4)-1.5)*13;
      if(team===1)line=-line;var push=possession===team?7:-2,targetX=line+(team===0?push:-push)+bx*(keeper?.05:.17),targetZ=lane+bz*(keeper?.08:.19);
      player.position.x+=(targetX-player.position.x)*Math.min(1,dt*3.2);player.position.z+=(targetZ-player.position.z)*Math.min(1,dt*3.2);player.position.y=Math.abs(Math.sin(now*.008+player.userData.phase))*.08;player.rotation.y=team===0?Math.PI/2:-Math.PI/2;
    });
    var minute=Number(live.minute||0),clock=document.getElementById('cp-watch-clock');if(clock)clock.textContent=String(Math.floor(minute)).padStart(2,'0')+':00';
    var chip=document.getElementById('cp-live-chip');if(chip)chip.innerHTML='<i></i>'+(live.running?tr('CANLI · ','LIVE · ')+Math.floor(minute)+'′':minute>=90?tr('TAMAMLANDI','BEENDET'):tr('MAÇ GÜNÜ','SPIELTAG'));
    var stage=document.getElementById('cp-stage-status'),recent=document.querySelector('#log .event');if(stage&&recent)stage.textContent=recent.innerText.replace(/\s+/g,' ').trim();
  }

  function stop3D() {
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
