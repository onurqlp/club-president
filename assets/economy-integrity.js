(function () {
  'use strict';
  var api = window.CP_OFFPITCH_API;
  if (!api) return;

  function state() { return api.getState(); }
  function t(tr, de) {
    try { return localStorage.getItem('cp-ui-language-2026') === 'de' ? de : tr; }
    catch (_) { return tr; }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function ledger(s) {
    if (!Array.isArray(s.financeLedger)) s.financeLedger = [];
    return s.financeLedger;
  }
  function findTx(s, id) {
    return ledger(s).find(function (x) { return x.id === id; });
  }
  function book(s, id, type, cashDelta, budgetDelta, details) {
    var prior = findTx(s, id);
    if (prior) return prior;
    var row = {
      id: id, type: type, day: Number(s.day) || 0, date: s.date || '',
      cashDelta: Math.round(Number(cashDelta) || 0),
      budgetDelta: Math.round(Number(budgetDelta) || 0),
      details: details || ''
    };
    ledger(s).unshift(row);
    return row;
  }
  function ensureContract(s) {
    var c = s && s.sponsorContract;
    if (!c) return null;
    if (!c.id) {
      var ix = Number.isInteger(c.historyIndex) ? c.historyIndex : (s.sponsorDeals || []).length - 1;
      c.id = 'sponsor-' + (s.ix || 0) + '-' + String(c.season || s.seasonCode || 'career') + '-' +
        String(c.signedDay || 0) + '-' + String(Math.max(0, ix));
    }
    c.installmentsPaid = Math.max(0, Number(c.installmentsPaid) || 0);
    c.installmentsTotal = Math.max(1, Number(c.installmentsTotal) || 8);
    c.paidAmount = Math.max(0, Number(c.paidAmount) || 0);
    c.nextPaymentDay = Number(c.nextPaymentDay) || ((Number(c.signedDay) || 0) + 7);
    if (c.paidAmount > 0) {
      var deals = s.sponsorDeals || [];
      var item = Number.isInteger(c.historyIndex) ? deals[c.historyIndex] : null;
      if (item && !item.id) item.id = c.id;
      var advanceId = c.id + ':advance';
      var advance = Number(c.advancePaid || (item && item.advancePaid)) || Math.min(c.paidAmount, Math.round((Number(c.totalAmount) || 0) * .2));
      if (!findTx(s, advanceId)) book(s, advanceId, 'sponsor-advance', advance, 0, c.name || 'Sponsor advance');
      var historical = Math.max(0, c.paidAmount - advance), per = Math.max(0, Number(c.installmentAmount) || 0);
      for (var n = 1; n <= c.installmentsPaid; n++) {
        var paymentId = c.id + ':installment:' + n;
        var amount = n === c.installmentsTotal ? historical : Math.min(per, historical);
        if (!findTx(s, paymentId)) book(s, paymentId, 'sponsor-installment', amount, 0, c.name || 'Sponsor installment');
        historical = Math.max(0, historical - amount);
      }
    }
    return c;
  }
  function contractHistory(s, c) {
    var deals = s.sponsorDeals || [];
    if (Number.isInteger(c.historyIndex) && deals[c.historyIndex]) return deals[c.historyIndex];
    return deals.slice().reverse().find(function (x) {
      return x.day === c.signedDay && (x.status === 'active' || x.status === 'completed');
    });
  }
  function settleSponsor(s, targetDay) {
    var c = ensureContract(s);
    if (!c || !c.active || !(Number(c.totalAmount) > 0)) return 0;
    var totalPaid = 0, turns = 0, item = contractHistory(s, c);
    while (c.active && c.installmentsPaid < c.installmentsTotal &&
           targetDay >= c.nextPaymentDay && turns++ < 64) {
      var remaining = Math.max(0, c.totalAmount - c.paidAmount);
      var last = c.installmentsPaid === c.installmentsTotal - 1;
      var payment = last ? remaining : Math.min(remaining, Math.max(1, Number(c.installmentAmount) || 0));
      if (!payment) { c.active = false; break; }
      var number = c.installmentsPaid + 1, id = c.id + ':installment:' + number;
      var prior = findTx(s, id);
      if (prior) payment = Math.max(0, Number(prior.cashDelta) || payment);
      else {
        s.cash = (Number(s.cash) || 0) + payment;
        book(s, id, 'sponsor-installment', payment, 0, c.name || 'Sponsor installment');
      }
      c.paidAmount = Math.min(c.totalAmount, c.paidAmount + payment);
      c.installmentsPaid = number;
      c.nextPaymentDay += 7;
      totalPaid += prior ? 0 : payment;
      if (item) {
        item.installmentsPaid = c.installmentsPaid;
        item.paidAmount = c.paidAmount;
      }
      if (c.installmentsPaid >= c.installmentsTotal || c.paidAmount >= c.totalAmount) {
        c.paidAmount = c.totalAmount;
        c.active = false;
        c.completedDay = targetDay;
        if (item) {
          item.status = 'completed';
          item.completedDay = targetDay;
          item.paidAmount = c.totalAmount;
        }
      }
    }
    if (totalPaid && typeof api.notice === 'function') {
      api.notice(c.active ? t('SPONSOR ÖDEMELERİ TAHSİL EDİLDİ', 'SPONSORRATEN EINGEGANGEN') :
        t('SPONSORLUK SÖZLEŞMESİ TAMAMLANDI', 'SPONSORVERTRAG ABGESCHLOSSEN'),
        money(totalPaid) + t(' toplam ödeme kasaya işlendi.', ' insgesamt wurden ausgezahlt.'));
    }
    return totalPaid;
  }
  function money(value) {
    return typeof window.cash === 'function' ? window.cash(value) :
      new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(Number(value) || 0) + ' €';
  }
  function transactionLabel(kind) {
    var map = {
      'sponsor-advance': t('Sponsor imza avansı', 'Sponsoring-Anzahlung'),
      'sponsor-installment': t('Sponsor taksidi', 'Sponsoringrate'),
      'scout-weekly-budget': t('Scout haftalık bütçesi', 'Wöchentliches Scoutbudget'),
      'club-weekly-operations': t('Personel ve tesis gideri', 'Personal- und Anlagenkosten'),
      'liability-payment': t('Transfer taksidi', 'Transfer-Rate'),
      'player-sale': t('Oyuncu satışı', 'Spielerverkauf'),
      'player-purchase': t('Oyuncu transferi', 'Spielerverpflichtung'),
      'match-income': t('Maç günü geliri', 'Spieltageinnahmen'),
      'season-prize': t('Sezon ödülü ve bütçe', 'Saisonprämie und Budget')
    };
    return map[kind] || kind;
  }
  function ensureScout(s) {
    return typeof window.cpScoutInit19 === 'function' ? window.cpScoutInit19() : (s.scout19 || null);
  }
  function advanceScoutAt(s, day, finalDay, silent) {
    var q = ensureScout(s);
    if (!q) return { changed: false, cost: 0, reports: 0, stopped: false };
    var originalDay = s.day, cost = 0, reportCount = 0, changed = false, stopped = false;
    s.day = day;
    if (day > 0 && day % 7 === 0 && Number(q.weekly) > 0) {
      var spendId = 'scout-week:' + String(s.ix || 0) + ':' + day;
      if (!findTx(s, spendId)) {
        if ((Number(s.cash) || 0) >= q.weekly) {
          s.cash -= q.weekly;
          q.spent = (Number(q.spent) || 0) + q.weekly;
          book(s, spendId, 'scout-weekly-budget', -q.weekly, 0, t('Haftalık gözlem bütçesi', 'Wöchentliches Scoutbudget'));
          cost += q.weekly;
        } else {
          q.weekly = 0;
          stopped = true;
        }
        changed = true;
      }
    }
    if (q.weekly >= 50000 && typeof window.cpScoutProspect19 === 'function') {
      q.staff.forEach(function (staff) {
        if (!staff.task) return;
        var next = Number(staff.nextDay) || day + 5, guard = 0;
        while (next <= day && guard++ < 12) {
          var current = s.day;
          s.day = next;
          var prospects = staff.ability >= 76 ? 3 : 2;
          for (var i = 0; i < prospects; i++) {
            var prospect = window.cpScoutProspect19(staff, staff.task);
            prospect.reportDay = next;
            prospect.reportDate = typeof window.nextDate === 'function'
              ? window.nextDate(s.date, next - finalDay) : s.date;
            prospect.reportId = 'scout-report:' + String(s.ix || 0) + ':' + next + ':' + staff.name;
            q.prospects.unshift(prospect);
          }
          s.day = current;
          q.reports.unshift({
            id: 'scout-report:' + String(s.ix || 0) + ':' + next + ':' + staff.name,
            day: next, date: typeof window.nextDate === 'function'
              ? window.nextDate(s.date, next - finalDay) : s.date,
            scout: staff.name, count: prospects, focus: staff.task
          });
          reportCount += prospects;
          next += 5;
          changed = true;
        }
        staff.nextDay = next;
      });
      q.reports = q.reports.slice(0, 30);
      q.prospects = q.prospects.slice(0, 60);
    }
    s.day = originalDay;
    if (stopped && !silent && typeof api.notice === 'function') {
      api.notice(t('SCOUT BÜTÇESİ DURDURULDU', 'SCOUTBUDGET PAUSIERT'),
        t('Kasa haftalık bütçeyi karşılamadı. Görevler korunuyor; bütçeyi yeniden ayırabilirsin.', 'Das Guthaben reicht nicht für das Wochenbudget. Die Aufgaben bleiben gespeichert.'));
    }
    if (cost && !silent && typeof api.notice === 'function') {
      api.notice(t('SCOUT BÜTÇESİ HARCANDI', 'SCOUTBUDGET ABGERECHNET'),
        money(cost) + t(' haftalık gözlem gideri işlendi.', ' Wochenbudget wurde abgebucht.'));
    }
    return { changed: changed, cost: cost, reports: reportCount, stopped: stopped };
  }
  function archiveOffer(m, offer, status, reason) {
    if (!m || !offer) return;
    m.offerArchive = Array.isArray(m.offerArchive) ? m.offerArchive : [];
    if (m.offerArchive.some(function (x) { return x.id === offer.id; })) return;
    var copy = Object.assign({}, offer, { status: status || offer.status, resolvedDay: state().day, reason: reason || '' });
    m.offerArchive.unshift(copy);
    m.offerArchive = m.offerArchive.slice(0, 40);
  }
  function expireOffers(s) {
    if (!s || typeof window.marketState !== 'function') return false;
    var m = window.marketState(), changed = false;
    m.offerArchive = Array.isArray(m.offerArchive) ? m.offerArchive : [];
    (m.incoming || []).forEach(function (offer) {
      if (offer.status !== 'open') return;
      if (!Number.isFinite(Number(offer.expiresDay))) offer.expiresDay = (Number(offer.day) || s.day) + 19;
      if (!offer.expiresDate && typeof window.nextDate === 'function')
        offer.expiresDate = window.nextDate(offer.created || s.date, 19);
      if (s.day >= offer.expiresDay) {
        offer.status = 'expired';
        offer.resolvedDay = s.day;
        archiveOffer(m, offer, 'expired', t('Teklifin son günü geçti', 'Angebot abgelaufen'));
        if (typeof api.notice === 'function')
          api.notice(t('TRANSFER TEKLİFİ SÜRESİ DOLDU', 'TRANSFERANGEBOT ABGELAUFEN'),
            (window.clubs && window.clubs[offer.clubIx] ? window.clubs[offer.clubIx][0] : '') + ' · ' +
            t('Oyuncu ve kulüp için yeni teklif gerekebilir.', 'Ein neues Angebot kann erforderlich sein.'));
        changed = true;
      }
    });
    return changed;
  }
  function ensureOfferDates(s) {
    if (!s || typeof window.marketState !== 'function') return false;
    var m = window.marketState(), changed = false;
    (m.incoming || []).forEach(function (offer) {
      if (!Number.isFinite(Number(offer.expiresDay))) {
        offer.expiresDay = (Number(offer.day) || s.day) + 19;
        offer.expiresDate = typeof window.nextDate === 'function'
          ? window.nextDate(offer.created || s.date, 19) : s.date;
        changed = true;
      }
    });
    return changed;
  }

  // Every financial movement has a stable, persisted transaction key.
  var oldSponsorAction = window.cpSponsorAction114;
  if (typeof oldSponsorAction === 'function') {
    window.cpSponsorAction114 = function (key) {
      var before = state(), oldId = before && before.sponsorContract && before.sponsorContract.id;
      var result = oldSponsorAction.apply(this, arguments), s = state();
      var c = s && ensureContract(s);
      if (key === 'sign' && c && c.id !== oldId) {
        var advanceId = c.id + ':advance';
        if (!findTx(s, advanceId)) book(s, advanceId, 'sponsor-advance',
          Number(c.paidAmount) || 0, 0, c.name || 'Sponsor signing advance');
        api.save();
      }
      return result;
    };
  }

  var oldScoutAdvance = window.cpScoutAdvance19;
  if (typeof oldScoutAdvance === 'function') {
    window.cpScoutAdvance19 = function () {
      var s = state();
      if (!s) return;
      var result = advanceScoutAt(s, Number(s.day) || 0, Number(s.day) || 0, false);
      if (result.changed) { api.save(); api.render(); }
    };
  }

  var oldRequestOffers = window.requestOffers;
  if (typeof oldRequestOffers === 'function') {
    window.requestOffers = function () {
      var s = state();
      if (!s) return oldRequestOffers.apply(this, arguments);
      var changed = expireOffers(s);
      var before = new Set((window.marketState().incoming || []).map(function (x) { return x.id; }));
      var result = oldRequestOffers.apply(this, arguments);
      var m = window.marketState();
      (m.incoming || []).forEach(function (offer) {
        if (before.has(offer.id)) return;
        offer.expiresDay = Number(s.day) + 19;
        offer.expiresDate = typeof window.nextDate === 'function' ? window.nextDate(offer.created || s.date, 19) : s.date;
        changed = true;
      });
      if (changed) api.save();
      return result;
    };
  }

  var oldIncomingResponse = window.incomingResponse;
  if (typeof oldIncomingResponse === 'function') {
    window.incomingResponse = function (id, action) {
      var s = state(), m = s && window.marketState();
      if (!s || !m) return oldIncomingResponse.apply(this, arguments);
      var expiredNow = expireOffers(s);
      if (expiredNow) { api.save(); api.render(); }
      var offer = m.incoming.find(function (x) { return x.id === id && x.status === 'open'; });
      if (!offer) return;
      if (!Number.isFinite(Number(offer.expiresDay))) {
        offer.expiresDay = (Number(offer.day) || s.day) + 19;
        offer.expiresDate = typeof window.nextDate === 'function' ? window.nextDate(offer.created || s.date, 19) : s.date;
      }
      if (s.day >= offer.expiresDay) {
        expireOffers(s); api.save(); api.render();
        api.toast(t('Teklifin süresi doldu; artık yanıtlanamaz.', 'Das Angebot ist abgelaufen und kann nicht mehr beantwortet werden.'));
        return;
      }
      var result = oldIncomingResponse.apply(this, arguments);
      if (offer.status !== 'open') archiveOffer(m, offer, offer.status,
        offer.status === 'accepted' ? t('Ön anlaşma veya tamamlanan satış', 'Vorvertrag oder abgeschlossener Transfer') : '');
      if (action === 'accept' && window.isWindow(s.date) && offer.status === 'accepted' &&
          s.players.some(function (p) { return p.id === offer.playerId; })) {
        offer.status = 'blocked';
        offer.reason = t('Minimum kadro derinliği korunamadı', 'Mindestkadergröße wurde unterschritten');
        archiveOffer(m, offer, 'blocked', offer.reason);
        api.save(); api.render();
      }
      return result;
    };
  }

  var oldCompleteSale = window.completeSale;
  if (typeof oldCompleteSale === 'function') {
    window.completeSale = function (offer) {
      var s = state(), txId = offer && 'transfer-out:' + offer.id;
      if (s && txId && findTx(s, txId)) return true;
      var cashBefore = s && Number(s.cash) || 0, budgetBefore = s && Number(s.budget) || 0;
      var result = oldCompleteSale.apply(this, arguments);
      s = state();
      if (result && s && offer) {
        book(s, txId, 'player-sale', (Number(s.cash) || 0) - cashBefore,
          (Number(s.budget) || 0) - budgetBefore, offer.playerId || '');
        api.save();
      }
      return result;
    };
  }

  var oldBeginDeal = window.beginDeal;
  if (typeof oldBeginDeal === 'function') {
    window.beginDeal = function (id) {
      var result = oldBeginDeal.apply(this, arguments), s = state();
      if (s && s.pendingDeal && !s.pendingDeal.economyId) {
        s.financeSerial = (Number(s.financeSerial) || 0) + 1;
        s.pendingDeal.economyId = 'transfer-in:' + String(s.ix || 0) + ':' +
          String(s.seasonCode || 'career') + ':' + s.financeSerial;
        api.save();
      }
      return result;
    };
  }

  var oldFinalizeDeal = window.finalizeDeal;
  if (typeof oldFinalizeDeal === 'function') {
    window.finalizeDeal = function () {
      var s = state(), d = s && s.pendingDeal;
      if (!s || !d) return oldFinalizeDeal.apply(this, arguments);
      if (!d.economyId) {
        s.financeSerial = (Number(s.financeSerial) || 0) + 1;
        d.economyId = 'transfer-in:' + String(s.ix || 0) + ':' + String(s.seasonCode || 'career') + ':' + s.financeSerial;
      }
      var beforeCount = s.players.length, cashBefore = Number(s.cash) || 0, budgetBefore = Number(s.budget) || 0;
      var result = oldFinalizeDeal.apply(this, arguments);
      s = state();
      if (s && s.players.length > beforeCount) {
        var buyId = d.economyId;
        book(s, buyId, 'player-purchase', (Number(s.cash) || 0) - cashBefore,
          (Number(s.budget) || 0) - budgetBefore, s.players[s.players.length - 1].id || d.id || '');
        (s.liabilities || []).forEach(function (liability, i) {
          if (!liability.id) {
            s.financeSerial = (Number(s.financeSerial) || 0) + 1;
            liability.id = 'liability:' + buyId + ':' + i;
          }
        });
        api.save();
      }
      return result;
    };
  }

  function logSponsorDelta(before, after) {
    if (!after) return;
    var c = ensureContract(after);
    if (!c) return;
    var oldPaid = before && before.id === c.id ? Number(before.installmentsPaid) || 0 : Number(c.installmentsPaid) || 0;
    var nowPaid = Number(c.installmentsPaid) || 0;
    if (nowPaid <= oldPaid) return;
    var delta = Math.max(0, (Number(c.paidAmount) || 0) - (before && before.id === c.id ? Number(before.paidAmount) || 0 : 0));
    var per = Number(c.installmentAmount) || 0;
    for (var n = oldPaid + 1; n <= nowPaid; n++) {
      var amount = n === c.installmentsTotal ? Math.max(0, delta) : Math.min(per, delta);
      book(after, c.id + ':installment:' + n, 'sponsor-installment', amount, 0, c.name || 'Sponsor installment');
      delta -= amount;
    }
  }

  function snapshotLiabilities(s) {
    (s.liabilities || []).forEach(function (x, i) {
      if (!x.id) x.id = 'liability:' + String(s.ix || 0) + ':' + String(s.seasonCode || 'career') + ':' + i + ':' + String(x.name || '');
    });
    return (s.liabilities || []).map(function (x) { return { id: x.id, left: Number(x.left) || 0, monthly: Number(x.monthly) || 0 }; });
  }

  var oldDay = window.day;
  if (typeof oldDay === 'function') {
    window.day = function () {
      var s = state();
      if (!s) return oldDay.apply(this, arguments);
      var dayBefore = Number(s.day) || 0, cashBefore = Number(s.cash) || 0, wageBefore = Number(s.wage) || 0;
      var priorContract = s.sponsorContract && Object.assign({}, s.sponsorContract);
      var priorLiabilities = snapshotLiabilities(s);
      var result = oldDay.apply(this, arguments);
      s = state();
      if (!s || Number(s.day) === dayBefore) return result;
      if (s.day > 0 && s.day % 7 === 0) {
        var weekly = Math.round(wageBefore / 4) + 150000;
        book(s, 'club-operations:' + String(s.ix || 0) + ':' + dayBefore + '>' + s.day,
          'club-weekly-operations', -weekly, 0, t('Personel ve tesis gideri', 'Personal- und Anlagenkosten'));
      }
      if (s.day % 30 === 0) {
        var afterById = new Map(snapshotLiabilities(s).map(function (x) { return [x.id, x]; }));
        priorLiabilities.forEach(function (before) {
          var after = afterById.get(before.id);
          if (after && after.left < before.left)
            book(s, before.id + ':payment:' + s.day, 'liability-payment', -before.monthly, 0, before.id);
        });
      }
      logSponsorDelta(priorContract, s.sponsorContract);
      expireOffers(s); ensureOfferDates(s);
      api.save();
      return result;
    };
  }

  var oldFinish = window.finish;
  if (typeof oldFinish === 'function') {
    window.finish = function () {
      var s = state(), season = s && (s.seasonCode || 'career'), round = s && s.round, before = s && Number(s.cash) || 0;
      var result = oldFinish.apply(this, arguments);
      s = state();
      if (s && round !== undefined && s.round > round)
        book(s, 'match-income:' + String(s.ix || 0) + ':' + season + ':' + round,
          'match-income', (Number(s.cash) || 0) - before, 0, t('Maç günü geliri', 'Spieltageinnahmen'));
      if (s) api.save();
      return result;
    };
  }

  var oldNextSeason = window.nextSeason;
  if (typeof oldNextSeason === 'function') {
    window.nextSeason = function () {
      var s = state(), previousDay = s && Number(s.day) || 0, oldSeason = s && (s.seasonCode || 'career');
      var cashBefore = s && Number(s.cash) || 0, budgetBefore = s && Number(s.budget) || 0;
      var result = oldNextSeason.apply(this, arguments);
      s = state();
      if (!s || s.day <= previousDay) return result;
      var finalDay = Number(s.day) || previousDay;
      var scoutSummary = { changed: false, cost: 0, reports: 0, stopped: false };
      for (var d = previousDay + 1; d <= finalDay; d++) {
        var step = advanceScoutAt(s, d, finalDay, true);
        scoutSummary.changed = scoutSummary.changed || step.changed;
        scoutSummary.cost += step.cost;
        scoutSummary.reports += step.reports;
        scoutSummary.stopped = scoutSummary.stopped || step.stopped;
      }
      var sponsorPaid = settleSponsor(s, finalDay);
      expireOffers(s);
      book(s, 'season-prize:' + String(s.ix || 0) + ':' + oldSeason, 'season-prize',
        (Number(s.cash) || 0) - cashBefore, (Number(s.budget) || 0) - budgetBefore, oldSeason);
      if (scoutSummary.cost) api.notice(t('SEZON ARASI SCOUT GİDERİ', 'SCOUTKOSTEN IN DER SAISONPAUSE'),
        money(scoutSummary.cost) + t(' kesildi; rapor ve görev ilerlemesi korundu.', ' abgebucht; Berichte und Aufgaben wurden fortgeführt.'));
      if (scoutSummary.reports) api.notice(t('SEZON ARASI SCOUT RAPORLARI', 'SCOUTBERICHTE IN DER SAISONPAUSE'),
        scoutSummary.reports + t(' oyuncu raporu üretildi.', ' Spielerberichte wurden erstellt.'));
      if (scoutSummary.stopped) api.notice(t('SCOUT BÜTÇESİ DURDURULDU', 'SCOUTBUDGET PAUSIERT'),
        t('Kasa haftalık scout giderini karşılayamadı; görevler saklandı.', 'Das Guthaben reichte nicht; die Scoutaufgaben bleiben gespeichert.'));
      if (sponsorPaid) api.notice(t('SPONSOR ÖDEMELERİ TAMAMLANDI', 'SPONSORZAHLUNGEN VERARBEITET'), money(sponsorPaid));
      api.save(); api.render();
      return result;
    };
  }

  var oldPanel = window.marketPanel;
  if (typeof oldPanel === 'function') {
    window.marketPanel = function () {
      var s = state(), changed = expireOffers(s) | ensureOfferDates(s), html = oldPanel.apply(this, arguments);
      if (changed) api.save();
      var m = s && window.marketState(), history = m && m.offerArchive || [];
      if (!history.length) return html;
      var rows = history.slice(0, 5).map(function (x) {
        var player = (s.players || []).find(function (p) { return p.id === x.playerId; });
        var club = window.clubs && window.clubs[x.clubIx] ? window.clubs[x.clubIx][0] : '';
        var status = x.status === 'expired' ? t('SÜRESİ DOLDU', 'ABGELAUFEN') :
          x.status === 'blocked' ? t('KADRO NEDENİYLE DURDU', 'KADERBEDINGT GESTOPPT') :
          x.status === 'completed' ? t('TAMAMLANDI', 'ABGESCHLOSSEN') :
          x.status === 'rejected' ? t('REDDEDİLDİ', 'ABGELEHNT') : t('ÖN ANLAŞMA', 'VORVERTRAG');
        return '<div class="cp-offer"><span><b>' + esc(club) + ' · ' + esc(player && player.name || x.playerId) +
          '</b><small>' + money(x.fee) + ' · ' + status + (x.reason ? ' · ' + esc(x.reason) : '') + '</small></span></div>';
      }).join('');
      var panel = '<div class="career-panel cp-offer-history"><h3>' + t('SON TEKLİF DURUMLARI', 'LETZTE ANGEBOTSSTATUS') +
        '</h3><div class="cp-offers">' + rows + '</div></div>';
      return html.replace('<div class="cp-market-status">', panel + '<div class="cp-market-status">');
    };
  }

  api.wrapRender(function (previous) {
    return function () {
      var result = previous.apply(this, arguments), s = state();
      if (!s) return result;
      var contract = ensureContract(s), sponsorCard = document.querySelector('#content .cp-sponsor-contract');
      if (contract && contract.active && sponsorCard && !sponsorCard.querySelector('.cp-economy-contract-details')) {
        var remaining = Math.max(0, (Number(contract.totalAmount) || 0) - (Number(contract.paidAmount) || 0));
        var nextAmount = Math.min(remaining, Number(contract.installmentAmount) || 0);
        sponsorCard.insertAdjacentHTML('beforeend', '<small class="cp-economy-contract-details">' + t('Kalan: ', 'Offen: ') + money(remaining) + ' · ' + t('Sonraki taksit: ', 'Nächste Rate: ') + money(nextAmount) + '</small>');
      }
      if (api.getScreen() !== 'office') return result;
      var panel = document.querySelector('#content .day');
      if (!panel || panel.querySelector('.cp-economy-summary')) return result;
      var entries = ledger(s).slice(0, 4).map(function (x) {
        var delta = Number(x.cashDelta) || 0;
        return '<div class="cp-economy-row"><span><b>' + esc(transactionLabel(x.type)) + '</b><small>' +
          esc(x.date || '') + ' · ' + esc(x.details || '') + '</small></span><strong class="' +
          (delta >= 0 ? 'plus' : 'minus') + '">' + (delta >= 0 ? '+' : '−') + money(Math.abs(delta)) + '</strong></div>';
      }).join('');
      var news = (s.news || []).slice(0, 3).map(function (x) {
        return '<div class="cp-economy-news"><b>' + esc(x.title) + '</b><span>' + esc(x.body) + '</span></div>';
      }).join('');
      var pending = api.getDialogKey && api.getDialogKey();
      var summary = '<section class="cp-economy-summary"><div class="panel-hd"><b>📊 ' +
        t('KULÜP VE EKONOMİ ÖZETİ', 'VEREINS- UND FINANZÜBERSICHT') + '</b><span class="eyebrow">' +
        (pending ? t('KARAR BEKLİYOR', 'ENTSCHEIDUNG OFFEN') : t('GÜNCEL', 'AKTUELL')) +
        '</span></div><div class="cp-economy-body"><div><h4>' + t('SON MALİ İŞLEMLER', 'LETZTE FINANZVORGÄNGE') +
        '</h4>' + (entries || '<small>' + t('Henüz kayıtlı mali işlem yok.', 'Noch keine Finanzvorgänge.') + '</small>') +
        '</div><div><h4>' + t('YÖNETİM GÜNDEMİ', 'VEREINSMELDUNGEN') + '</h4>' +
        (news || '<small>' + t('Yeni kulüp bildirimi yok.', 'Keine neuen Vereinsmeldungen.') + '</small>') +
        '</div></div></section>';
      panel.insertAdjacentHTML('beforeend', summary);
      return result;
    };
  });

  document.body.insertAdjacentHTML('beforeend', '<style>' +
    '.cp-economy-summary{margin-top:12px;border:1px solid #496c60;border-radius:10px;background:#0b2028;overflow:hidden}' +
    '.cp-economy-body{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:12px}' +
    '.cp-economy-body h4{margin:0 0 8px;color:#baf361;font:800 12px Barlow Condensed,sans-serif}' +
    '.cp-economy-row,.cp-economy-news{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #28434a;font-size:11px}' +
    '.cp-economy-row span,.cp-economy-news{min-width:0}.cp-economy-row small,.cp-economy-news span{display:block;color:#aabcb8;font-size:10px;margin-top:3px}' +
    '.cp-economy-row .plus{color:#baf361}.cp-economy-row .minus{color:#ffb19f}.cp-offer-history{border-color:#b69b61}' +
    '@media(max-width:650px){.cp-economy-body{grid-template-columns:1fr;gap:10px}.cp-economy-body{padding:9px}}' +
  '</style>');
})();
