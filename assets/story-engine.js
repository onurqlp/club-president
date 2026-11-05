/* CLUB PRESIDENT — context-aware off-pitch story loop v1 */
(function () {
  'use strict';

  var api = window.CP_OFFPITCH_API;
  if (!api || !api.getState || !api.wrapDay) return;

  var KEY = 'storyEngine21';
  var LAST = 8;
  function isGerman() {
    try { return localStorage.getItem('cp-ui-language-2026') === 'de'; }
    catch (error) { return false; }
  }
  function tx(tr, de) { return isGerman() ? de : tr; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function seed(text) {
    var hash = 2166136261;
    text = String(text || '');
    for (var i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return function () {
      hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
      return (hash >>> 0) / 4294967296;
    };
  }
  function engine(state) {
    if (!state[KEY] || state[KEY].version !== 1) {
      state[KEY] = {
        version: 1, nextDay: Number(state.day || 0) + 3,
        recent: [], cooldowns: {}, threads: {}, pressPromise: null,
        total: 0, lastCategory: ''
      };
    }
    var data = state[KEY];
    data.recent = Array.isArray(data.recent) ? data.recent : [];
    data.cooldowns = data.cooldowns || {};
    data.threads = data.threads || {};
    data.total = Number(data.total) || 0;
    return data;
  }
  function history(state) { return Array.isArray(state.history) ? state.history : []; }
  function losses(state, count) {
    var list = history(state).slice(-count);
    var n = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (Number(list[i].h) < Number(list[i].a)) n++;
      else break;
    }
    return n;
  }
  function wins(state, count) {
    var list = history(state).slice(-count);
    var n = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (Number(list[i].h) > Number(list[i].a)) n++;
      else break;
    }
    return n;
  }
  function averageFit(state) {
    var players = state.players || [];
    if (!players.length) return 80;
    var sum = players.slice(0, 11).reduce(function (total, player) {
      var condition = Number(player.condition);
      return total + (Number.isFinite(condition) ? condition : 80);
    }, 0);
    return Math.round(sum / Math.min(11, players.length));
  }
  function nextRival(state) {
    var row = state.seasonCalendar && state.seasonCalendar[state.round];
    return row && row.opp || '';
  }
  function isDerby(state) {
    var pairs = [
      ['Galatasaray','Fenerbahçe'], ['Galatasaray','Beşiktaş'], ['Fenerbahçe','Beşiktaş'],
      ['Liverpool','Arsenal'], ['Liverpool','Manchester City'], ['Arsenal','Tottenham'],
      ['Real Madrid','Barcelona'], ['Real Madrid','Atlético Madrid'], ['Barcelona','Atlético Madrid'],
      ['Bayern Münih','Dortmund'], ['Juventus','Inter'], ['AC Milan','Inter'], ['PSG','Marseille']
    ];
    var opp = nextRival(state);
    return pairs.some(function (pair) {
      return (pair[0] === state.club && pair[1] === opp) || (pair[1] === state.club && pair[0] === opp);
    });
  }
  function lastOutgoing(state) {
    var log = state.marketV11 && state.marketV11.log || [];
    return log.find(function (row) { return row.type === 'out' && row.from === state.club; });
  }
  function ready(state, id, cooldown) {
    var e = engine(state);
    return Number(state.day || 0) >= (Number(e.cooldowns[id]) || 0) &&
      !e.recent.slice(0, 3).some(function (row) { return row.id === id; });
  }
  function option(labelTr, labelDe, effects, meta) {
    return [tx(labelTr, labelDe), effects || {}, null, 'office', null, meta || null];
  }
  function prompt(id, context) {
    var state = api.getState(), eng = state && engine(state);
    context = context || {};
    var title, body, choices = [], type = '📨', who = tx('KULÜP GÜNDEMİ','VEREINSTHEMA');
    if (id === 'finance_review') {
      title = tx('Kasada sıkışık dönem','Enger Finanzspielraum');
      body = tx('Mali işler ekibi, gelecek haftaki maaş ve tesis giderleri için harcamaları gözden geçirmeni istiyor. Kasada '+Math.round(state.cash / 1000000)+' milyon € var. Transfer ve maaş taahhütlerini de düşünerek yön belirle.',
        'Die Finanzabteilung bittet um einen Ausgabenplan für Gehälter und Anlagen. Die Kasse enthält '+Math.round(state.cash / 1000000)+' Mio. €. Berücksichtige laufende Transfer- und Gehaltsverpflichtungen.');
      choices = [
        option('Bir hafta yeni harcamaları dondur','Neue Ausgaben eine Woche einfrieren',{trust:2,morale:-1},{freezeDays:7}),
        option('Tesis yatırımını ertele, kadroyu koru','Anlageninvestition verschieben, Kader schützen',{trust:1,coach:1}),
        option('Taraftara açık mali plan sun','Finanzplan transparent erklären',{fans:2,trust:2})
      ];
    } else if (id === 'board_confidence') {
      type = '🧠'; who = tx('YÖNETİM KURULU','VORSTAND');
      title = tx('Yönetim kurulu netlik istiyor','Der Vorstand verlangt Klarheit');
      body = tx('Son haftalardaki sonuçlar ve kulübün hedefi yönetim kurulunda tartışma yarattı. Teknik direktör '+(state.managerName || 'teknik ekip')+' için nasıl bir tutum alacaksın?',
        'Die jüngsten Ergebnisse und das Saisonziel sorgen im Vorstand für Diskussionen. Wie positionierst du dich zu Trainer '+(state.managerName || 'dem Trainerteam')+'?');
      choices = [
        option('Hocaya sonuna kadar destek ver','Dem Trainer den Rücken stärken',{coach:3,morale:2,trust:-1}),
        option('Bir sonraki maç için yazılı plan iste','Für das nächste Spiel einen klaren Plan verlangen',{trust:2,coach:-1}),
        option('Değerlendirmeyi iki maç sonra yap','Die Lage nach zwei Spielen neu bewerten',{trust:1,coach:1})
      ];
    } else if (id === 'supporters') {
      type = '📣'; who = tx('TARAFTAR TEMSİLCİSİ','FANVERTRETER');
      title = tx('Taraftarlar kulüpten cevap bekliyor','Die Fans erwarten eine Reaktion');
      body = tx('Taraftar temsilcileri, son dönemdeki sonuçlar ve kulübün iletişimi hakkında görüşmek istiyor. Bir sonraki maç öncesinde nasıl karşılık verelim?',
        'Die Fanvertreter wollen über die letzten Ergebnisse und die Kommunikation des Vereins sprechen. Wie soll der Klub vor dem nächsten Spiel reagieren?');
      choices = [
        option('Açık bir toplantı düzenle','Ein offenes Treffen organisieren',{fans:5,trust:2,cash:-250000}),
        option('Sahada cevap vereceğimizi söyle','Eine Antwort auf dem Platz versprechen',{fans:2,morale:2,trust:-1}),
        option('Taraftar temsilcileriyle düzenli görüş','Regelmäßige Gespräche vereinbaren',{fans:3,trust:3})
      ];
    } else if (id === 'derby') {
      type = '🔥'; who = tx('KULÜP DANIŞMANI','VEREINSBERATER');
      title = tx('Derbi yaklaşırken beklenti yükseliyor','Die Erwartungen vor dem Derby steigen');
      body = tx(nextRival(state)+' maçına yaklaşırken taraftarlar ve basın özel bir mesaj bekliyor. Takımın hazırlık planı da bu karardan etkilenecek.',
        'Vor dem Spiel gegen '+nextRival(state)+' erwarten Fans und Medien eine klare Botschaft. Auch die Vorbereitung des Teams wird davon beeinflusst.');
      choices = [
        option('Taraftara galibiyet sözü verme, sakin kal','Keine Garantie geben und ruhig bleiben',{trust:2,morale:1}),
        option('Derbinin önemini vurgula','Die Bedeutung des Derbys betonen',{fans:3,morale:2,trust:-1}),
        option('Oyuncularla kapalı toplantı yap','Ein internes Teamtreffen abhalten',{morale:3,coach:1,cash:-100000})
      ];
    } else if (id === 'academy_project') {
      type = '🎓'; who = tx('ALTYAPI SORUMLUSU','NACHWUCHSLEITER');
      title = tx('Altyapı için küçük bir pilot proje','Ein kleines Nachwuchsprojekt');
      body = tx('Altyapı ekibi, genç oyuncuların gelişimini takip etmek için sınırlı bütçeli bir pilot çalışma öneriyor. Sonuç raporu bir hafta sonra gelecek.',
        'Der Nachwuchsbereich schlägt ein begrenztes Pilotprojekt zur Entwicklung junger Spieler vor. Ein Bericht folgt in einer Woche.');
      choices = [
        option('Pilot çalışmayı başlat · €1,2M','Pilotprojekt starten · 1,2 Mio. €',{cash:-1200000,facility:2,trust:1},{thread:'academy',set:true}),
        option('Bu sezon bütçeyi A takıma ayır','Das Budget diese Saison der ersten Mannschaft geben',{coach:1,trust:1}),
        option('Ücretsiz gözlem raporu iste','Einen kostenlosen Beobachtungsbericht anfordern',{trust:1})
      ];
    } else if (id === 'academy_report') {
      type = '📈'; who = tx('ALTYAPI SORUMLUSU','NACHWUCHSLEITER');
      title = tx('Altyapı pilotunun ilk raporu','Erster Bericht zum Nachwuchsprojekt');
      body = tx('Bir haftalık çalışma tamamlandı. Ekip, oyuncu gelişimini takip edecek düzenli bir plana geçilmesini öneriyor. Proje bütçesini nasıl kapatalım?',
        'Die erste Arbeitswoche ist abgeschlossen. Das Team empfiehlt einen regelmäßigen Entwicklungsplan. Wie soll das Projekt weitergeführt werden?');
      choices = [
        option('Projeyi bir ay daha sürdür','Das Projekt einen Monat fortsetzen',{cash:-300000,facility:2,trust:2},{thread:'academy',extendDays:30}),
        option('Bu sonucu yeterli gör, projeyi kapat','Ergebnis sichern und Projekt beenden',{facility:1,trust:1},{thread:'academy',clear:true}),
        option('Raporu A takım antrenmanına aktar','Erkenntnisse ins Training der Profis übernehmen',{coach:1,morale:1},{thread:'academy',clear:true})
      ];
    } else if (id === 'press_promise') {
      type = '🎙'; who = tx('BASIN SORUMLUSU','PRESSESPRECHER');
      title = tx('Basın toplantısında beklenti','Erwartungen auf der Pressekonferenz');
      body = tx('Basın, '+(losses(state,3)>=2?'üst üste gelen kötü sonuçları':'takımın sezon hedefini')+' soruyor. Vereceğin söz sonraki maçtan sonra yeniden gündeme gelebilir.',
        'Die Presse fragt nach '+(losses(state,3)>=2?'den jüngsten Niederlagen':'dem Saisonziel')+'. Deine Aussage kann nach dem nächsten Spiel wieder Thema werden.');
      choices = [
        option('Bir sonraki maçta üç puan hedefle','Drei Punkte im nächsten Spiel anpeilen',{fans:2,trust:1},{promise:'win'}),
        option('Performans sözü ver, sonucu garanti etme','Leistung versprechen, kein Ergebnis garantieren',{trust:2,morale:1},{promise:'performance'}),
        option('Beklentiyi düşür, baskıyı azalt','Erwartungen senken und Druck reduzieren',{fans:-1,morale:2},{promise:'calm'})
      ];
    } else if (id === 'press_review') {
      type = '📰'; who = tx('BASIN SORUMLUSU','PRESSESPRECHER');
      var result = context.won ? tx('Takım kazandı.','Das Team hat gewonnen.') : context.draw ? tx('Takım berabere kaldı.','Das Team spielte unentschieden.') : tx('Takım kaybetti.','Das Team hat verloren.');
      title = tx('Verdiğin söz yeniden gündemde','Deine Aussage wird erneut aufgegriffen');
      body = result+' '+tx('Basın, maç öncesi açıklamanı hatırlatıyor. Nasıl karşılık verelim?','Die Presse erinnert an deine Aussage vor dem Spiel. Wie reagieren wir?');
      choices = context.won ? [
        option('Oyuncuları öne çıkar','Die Spieler in den Mittelpunkt stellen',{fans:2,morale:2,trust:1},{promise:'resolve'}),
        option('Hedefi koru, abartılı kutlama yapma','Das Ziel bestätigen, nicht übertreiben',{trust:2}),
        option('Taraftara teşekkür et','Den Fans danken',{fans:3,trust:1})
      ] : [
        option('Sonucu kabul et, hedefi koru','Ergebnis annehmen und am Ziel festhalten',{trust:2,morale:1},{promise:'resolve'}),
        option('Sorumluluğu üstlen','Die Verantwortung übernehmen',{fans:1,trust:1,morale:1},{promise:'resolve'}),
        option('Takıma baskı yap, hemen cevap iste','Das Team unter Druck setzen',{coach:-1,morale:-2,trust:-1},{promise:'resolve'})
      ];
    } else if (id === 'player_incident') {
      type = '📰'; who = tx('KULÜP İLETİŞİMİ','VEREINSKOMMUNIKATION');
      title = tx('Yıldız oyuncu hakkında gece haberi','Bericht über einen Starspieler');
      body = tx(context.playerName+' gece geç saatte dışarıda görüntülendi. Haber maç öncesi büyüyor; oyuncuyla ve taraftarlarla nasıl ilgilenelim?',
        context.playerName+' wurde spät in der Nacht gesehen. Die Nachricht verbreitet sich vor dem Spiel. Wie gehen wir mit dem Spieler und den Fans um?');
      choices = [
        option('Disiplin uyarısı ver, bir maç dinlendir','Verwarnung aussprechen und ein Spiel pausieren lassen',{morale:-2,trust:1,coach:-1},{suspendPlayer:context.playerId}),
        option('Taraftara açıkla, iletişim bütçesi ayır · €250K','Fans informieren und Kommunikationsbudget einsetzen · 250.000 €',{cash:-250000,fans:2,trust:1}),
        option('Oyuncuyu kamuoyu önünde destekle','Den Spieler öffentlich unterstützen',{fans:-2,morale:2,coach:1})
      ];
    } else if (id === 'fatigue') {
      type = '🩺'; who = tx('SAĞLIK EKİBİ','MEDIZINISCHES TEAM');
      title = tx('Kondisyon ekibinden rotasyon uyarısı','Das Trainerteam empfiehlt Rotation');
      body = tx(context.playerName+' son maçlardan sonra düşük kondisyonla çalışıyor. Maç yaklaşırken onu dinlendirmek mi, antrenman yükünü azaltmak mı istersin?',
        context.playerName+' trainiert nach den letzten Spielen mit niedriger Fitness. Soll der Spieler vor dem nächsten Spiel pausieren oder nur leichter trainieren?');
      choices = [
        option('Bir sonraki maçta dinlendir','Im nächsten Spiel schonen',{morale:1,coach:1},{restPlayer:context.playerId}),
        option('Antrenman yükünü azalt','Trainingsbelastung reduzieren',{trust:1},{lightTrain:context.playerId}),
        option('Kadro kararını hocaya bırak','Die Entscheidung dem Trainer überlassen',{coach:2},{})
      ];
    } else if (id === 'milestone') {
      type = '🏟'; who = tx('KULÜP DANIŞMANI','VEREINSBERATER');
      title = tx('Kulüp yeni bir dönüm noktasında','Der Klub erreicht einen Meilenstein');
      body = tx(state.club+' bu kariyerde '+state.round+' lig maçını geride bıraktı. Bu dönüm noktasını oyuncular ve taraftarlarla nasıl değerlendirelim?',
        state.club+' hat in dieser Karriere '+state.round+' Ligaspiele absolviert. Wie soll der Klub diesen Meilenstein mit Spielern und Fans begehen?');
      choices = [
        option('Taraftarlarla küçük bir buluşma','Kleines Treffen mit den Fans',{cash:-200000,fans:4,trust:1}),
        option('Akademi oyuncularına açık antrenman','Offenes Training für Nachwuchsspieler',{facility:1,morale:2,trust:1}),
        option('Kutlamayı ertele, maça odaklan','Feier verschieben und aufs Spiel konzentrieren',{coach:1,trust:1})
      ];
    } else if (id === 'former_player') {
      type = '↩️'; who = tx('SPORTİF DİREKTÖR','SPORTDIREKTOR');
      title = tx('Eski oyuncunun yükselişi konuşuluyor','Ein ehemaliger Spieler macht Schlagzeilen');
      body = tx(context.playerName+' başka bir kulüpte iyi bir dönem geçiriyor. Taraftarlar eski transfer kararını tartışıyor. Nasıl yanıt verelim?',
        context.playerName+' erlebt bei einem anderen Verein eine starke Phase. Die Fans diskutieren den damaligen Transfer. Wie reagieren wir?');
      choices = [
        option('Kararı savun, kulübün planını anlat','Entscheidung erklären und den Plan verteidigen',{trust:1}),
        option('Oyuncuyu tebrik et, kapıyı kapatma','Dem Spieler gratulieren und die Tür offen lassen',{fans:2,trust:1}),
        option('Konuyu büyütme, geleceğe odaklan','Thema nicht vergrößern, nach vorn schauen',{fans:-1,coach:1})
      ];
    } else if (id === 'training_fatigue') {
      type = '🧩'; who = tx('TEKNİK EKİP','TRAINERTEAM');
      title = tx('Haftalık çalışma planı tartışılıyor','Der Trainingsplan steht zur Debatte');
      body = tx('Kondisyon ortalaması '+averageFit(state)+'%. Teknik ekip, maç takvimi sıkışmadan önce kısa bir toparlanma çalışması istiyor.',
        'Die durchschnittliche Fitness beträgt '+averageFit(state)+' %. Das Trainerteam empfiehlt eine kurze Regeneration vor dem nächsten Spiel.');
      choices = [
        option('Bir günü toparlanmaya ayır','Einen Tag der Regeneration widmen',{morale:2,coach:1}),
        option('Taktik çalışmasını sürdür','Taktiktraining fortsetzen',{coach:2,trust:1}),
        option('Oyuncuların yükünü bireysel ayarla','Belastung individuell anpassen',{trust:1,morale:1})
      ];
    } else {
      title = tx('Kulüp gündeminde yeni bir başlık','Ein neues Vereinsthema');
      body = tx('Yönetim ekibi, kulübün öncelikleri hakkında kararını bekliyor.','Das Managementteam wartet auf deine Entscheidung über die Prioritäten des Vereins.');
      choices = [option('Takımın yanında dur','Das Team unterstützen',{morale:1,trust:1})];
    }
    return { person: type, who: who, title: title, body: body, choices: choices, __storyEventV21: { id: id, context: context } };
  }

  function derbyEligible(state) { return isDerby(state); }
  var SCENARIOS = [
    { id:'academy_report', category:'academy', cooldown:18, eligible:function(s){return !!(engine(s).threads.academy && Number(s.day)>=engine(s).threads.academy.dueDay)}, priority:10 },
    { id:'press_review', category:'press', cooldown:20, eligible:function(s){var p=engine(s).pressPromise;return !!(p && Number(s.round)>p.round && history(s)[p.round])}, priority:10 },
    { id:'player_incident', category:'press', cooldown:70, eligible:function(s){return Number(s.round)>=2&&(s.players||[]).length>=11&&seed((s.club||'')+'|'+(s.seasonCode||'')+'|'+Number(s.day||0)+'|player-incident-v1')()<0.12}, priority:3 },
    { id:'finance_review', category:'finance', cooldown:35, eligible:function(s){return Number(s.cash)<7000000 && Number(s.round)>1}, priority:8 },
    { id:'board_confidence', category:'staff', cooldown:30, eligible:function(s){return Number(s.trust)<48 || losses(s,3)>=2 || Number(s.managerStability16||70)<42}, priority:8 },
    { id:'supporters', category:'fans', cooldown:32, eligible:function(s){return Number(s.fans)<58 || (losses(s,3)>=2 && Number(s.fans)<72)}, priority:7 },
    { id:'derby', category:'derby', cooldown:55, eligible:derbyEligible, priority:9 },
    { id:'academy_project', category:'academy', cooldown:55, eligible:function(s){return Number(s.facility||0)<88 && !engine(s).threads.academy && Number(s.round)>=2}, priority:4 },
    { id:'press_promise', category:'press', cooldown:36, eligible:function(s){return !engine(s).pressPromise && Number(s.round)>=3 && (losses(s,3)>=2 || wins(s,3)>=2 || isDerby(s))}, priority:7 },
    { id:'fatigue', category:'squad', cooldown:30, eligible:function(s){return averageFit(s)<70 && Number(s.round)>=2}, priority:8 },
    { id:'training_fatigue', category:'training', cooldown:42, eligible:function(s){return averageFit(s)<78 && Number(s.round)>=1}, priority:3 },
    { id:'former_player', category:'transfer', cooldown:50, eligible:function(s){return !!lastOutgoing(s) && Number(s.day)>(Number(lastOutgoing(s).day)||0)+12}, priority:3 },
    { id:'milestone', category:'milestone', cooldown:60, eligible:function(s){return Number(s.round)>=5 && Number(s.round)%5===0}, priority:4 },
    { id:'sponsor_offer', category:'commercial', cooldown:60, eligible:function(s){return !(s.sponsorContract && s.sponsorContract.active) && Number(s.round)>=2 && Number(s.day)>=(Number(engine(s).cooldowns.sponsor_offer)||0)}, priority:2, staticKey:'sponsor' }
  ];

  function scenarioById(id) { return SCENARIOS.find(function (item) { return item.id === id; }); }
  function chooseScenario(state) {
    var data = engine(state), candidates = SCENARIOS.filter(function (item) {
      return ready(state, item.id, item.cooldown) && item.eligible(state);
    });
    if (!candidates.length) return null;
    var r = seed((state.club||'club')+'|'+(state.seasonCode||'')+'|'+state.day+'|'+data.total+'|story-v21');
    candidates.forEach(function (item) { item.__storyScore = (item.priority || 0) + r() * 2; });
    candidates.sort(function (a,b) { return b.__storyScore - a.__storyScore; });
    if (candidates[0].category === data.lastCategory && candidates.length > 1) {
      var other = candidates.find(function (item) { return item.category !== data.lastCategory; });
      if (other) return other;
    }
    return candidates[0];
  }
  function chooseContext(id, state) {
    if (id === 'player_incident') {
      var player = (state.players || []).slice().sort(function(a,b){return (Number(b.rate)||0)-(Number(a.rate)||0)})[0];
      return player ? {playerId:player.id||player.name,playerName:player.name} : {};
    }
    if (id === 'fatigue') {
      var player = (state.players || []).slice().sort(function(a,b){return (Number(a.condition)||80)-(Number(b.condition)||80)})[0];
      return player ? {playerId:player.id||player.name, playerName:player.name} : {};
    }
    if (id === 'former_player') {
      var row = lastOutgoing(state);
      return {playerName:row && row.name || tx('Eski oyuncu','Ehemaliger Spieler')};
    }
    if (id === 'press_review') {
      var match = history(state)[engine(state).pressPromise.round];
      return {won:Number(match.h)>Number(match.a),draw:Number(match.h)===Number(match.a)};
    }
    return {};
  }
  function recordEvent(state, scenario, context) {
    var data = engine(state), day = Number(state.day)||0;
    data.total++;
    data.recent.unshift({id:scenario.id,category:scenario.category,day:day});
    data.recent = data.recent.slice(0,LAST);
    data.lastCategory = scenario.category;
    data.cooldowns[scenario.id] = day + scenario.cooldown;
    data.nextDay = day + 4 + Math.floor(seed((state.club||'')+'|'+day+'|'+data.total)()*4);
    if (scenario.staticKey === 'sponsor') data.cooldowns.sponsor_offer = day + 60;
    if (scenario.id === 'press_review') data.pressPromise = null;
    return data;
  }
  function showScenario(scenario, state) {
    var context = chooseContext(scenario.id,state);
    var data = recordEvent(state,scenario,context);
    if (scenario.staticKey) {
      api.setDialogByKey(scenario.staticKey);
    } else {
      data.pending = {id:scenario.id,context:context,day:Number(state.day)||0};
      api.setDialog(prompt(scenario.id,context));
    }
    api.setScreen('office');
    api.save();
    api.render();
  }
  function restorePending() {
    var state=api.getState();
    if(!state)return false;
    var data=engine(state),pending=data.pending;
    if(!pending || api.getDialog())return false;
    var scenario=scenarioById(pending.id);
    if(!scenario)return false;
    api.setDialog(prompt(pending.id,pending.context||{}));
    api.setScreen('office');
    return true;
  }

  api.wrapDay(function (previous) {
    return function () {
      var before=api.getState(),beforeDay=before&&Number(before.day);
      var result=previous.apply(this,arguments);
      var state=api.getState();
      if(!state || Number(state.day)===beforeDay || state.seasonFinished || api.getDialog())return result;
      var data=engine(state);
      if(!Number.isFinite(Number(data.nextDay)))data.nextDay=Number(state.day)+3;
      if(Number(state.day)<Number(data.nextDay))return result;
      var scenario=chooseScenario(state);
      if(!scenario){data.nextDay=Number(state.day)+2;api.save();return result}
      showScenario(scenario,state);
      return result;
    };
  });

  api.wrapRender(function (previous) {
    return function () {
      restorePending();
      return previous.apply(this,arguments);
    };
  });

  document.addEventListener('click',function(event){
    var button=event.target.closest('[data-answer]');
    if(!button)return;
    var dialogue=api.getDialog(),meta=dialogue&&dialogue.__storyEventV21;
    if(!meta)return;
    var state=api.getState(),data=state&&engine(state),index=Number(button.dataset.answer);
    if(!state||!data||!data.pending||data.pending.id!==meta.id)return;
    var selected=dialogue.choices[index],choiceMeta=selected&&selected[5]||{},day=Number(state.day)||0;
    if (!selected || !api.canAffordChoice(index)) return;
    data.pending=null;
    if(choiceMeta.thread==='academy'&&choiceMeta.set)data.threads.academy={started:day,dueDay:day+7};
    if(choiceMeta.thread==='academy'&&choiceMeta.extendDays)data.threads.academy={started:data.threads.academy&&data.threads.academy.started||day,dueDay:day+Number(choiceMeta.extendDays)};
    if(choiceMeta.thread==='academy'&&choiceMeta.clear)delete data.threads.academy;
    if(choiceMeta.freezeDays)state.spendingFreezeUntilDay=day+Number(choiceMeta.freezeDays);
    if(choiceMeta.promise==='win'||choiceMeta.promise==='performance'||choiceMeta.promise==='calm'){
      data.pressPromise={round:Number(state.round)||0,type:choiceMeta.promise,day:day};
    }
    if(choiceMeta.promise==='resolve')data.pressPromise=null;
    if(choiceMeta.suspendPlayer){
      var disciplined=(state.players||[]).find(function(p){return String(p.id||p.name)===String(choiceMeta.suspendPlayer)});
      if(disciplined)disciplined.suspendedUntilRound=(Number(state.round)||0)+1;
    }
    if(choiceMeta.restPlayer){
      var rested=(state.players||[]).find(function(p){return String(p.id||p.name)===String(choiceMeta.restPlayer)});
      if(rested){rested.restUntilRound17=Number(state.round)||0;rested.condition=clamp((Number(rested.condition)||80)+3,0,100)}
    }
    if(choiceMeta.lightTrain){
      var lighter=(state.players||[]).find(function(p){return String(p.id||p.name)===String(choiceMeta.lightTrain)});
      if(lighter)lighter.condition=clamp((Number(lighter.condition)||80)+2,0,100);
    }
    api.save();
  },true);

  restorePending();
  if (api.getState() && engine(api.getState()).pending) api.render();
})();