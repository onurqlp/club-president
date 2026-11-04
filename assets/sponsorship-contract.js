(function () {
  'use strict';
  var api = window.CP_OFFPITCH_API;
  if (!api) return;

  function isGerman() {
    try { return localStorage.getItem('cp-ui-language-2026') === 'de'; }
    catch (error) { return false; }
  }
  function tx(tr, de) { return isGerman() ? de : tr; }
  function money(amount) {
    return new Intl.NumberFormat(isGerman() ? 'de-DE' : 'tr-TR', {
      style: 'currency', currency: 'EUR', maximumFractionDigits: 0
    }).format(Math.max(0, Number(amount) || 0));
  }
  function activeContract(state) {
    var contract = state && state.sponsorContract;
    return contract && contract.active && contract.totalAmount > 0 ? contract : null;
  }
  function historyItem(state, contract) {
    var list = state.sponsorDeals || [];
    if (Number.isInteger(contract.historyIndex) && list[contract.historyIndex]) return list[contract.historyIndex];
    return list.slice().reverse().find(function (item) {
      return item.day === contract.signedDay && item.status === 'active';
    });
  }

  api.wrapDay(function (previous) {
    return function () {
      var state = api.getState();
      var before = state && state.day;
      var result = previous.apply(this, arguments);
      state = api.getState();
      if (!state || state.day === before) return result;

      var changed = false;
      var contract = activeContract(state);
      if (contract) {
        contract.installmentsPaid = Math.max(0, Number(contract.installmentsPaid) || 0);
        contract.installmentsTotal = Math.max(1, Number(contract.installmentsTotal) || 8);
        contract.paidAmount = Math.max(0, Number(contract.paidAmount) || 0);
        contract.nextPaymentDay = Number(contract.nextPaymentDay) || (state.day + 7);
        while (contract.active &&
               contract.installmentsPaid < contract.installmentsTotal &&
               state.day >= contract.nextPaymentDay) {
          var remaining = Math.max(0, contract.totalAmount - contract.paidAmount);
          var lastInstallment = contract.installmentsPaid === contract.installmentsTotal - 1;
          var payment = lastInstallment
            ? remaining
            : Math.min(remaining, Math.max(1, Number(contract.installmentAmount) || 0));
          if (!payment) {
            contract.active = false;
            break;
          }
          state.cash += payment;
          contract.paidAmount += payment;
          contract.installmentsPaid += 1;
          contract.nextPaymentDay += 7;
          var item = historyItem(state, contract);
          if (item) {
            item.installmentsPaid = contract.installmentsPaid;
            item.paidAmount = contract.paidAmount;
          }
          if (contract.installmentsPaid >= contract.installmentsTotal ||
              contract.paidAmount >= contract.totalAmount) {
            contract.paidAmount = contract.totalAmount;
            contract.active = false;
            contract.completedDay = state.day;
            if (item) {
              item.status = 'completed';
              item.completedDay = state.day;
              item.paidAmount = contract.totalAmount;
            }
            api.notice(tx('SPONSORLUK SÖZLEŞMESİ TAMAMLANDI', 'SPONSORVERTRAG ABGESCHLOSSEN'),
              tx('Toplam ', 'Insgesamt ') + money(contract.totalAmount) + tx(' sponsorluk geliri tahsil edildi.', ' Sponsoringeinnahmen ausgezahlt.'));
          } else {
            api.notice(tx('SPONSOR ÖDEMESİ TAHSİL EDİLDİ', 'SPONSORRATE EINGEGANGEN'),
              money(payment) + tx(' haftalık ödeme kasaya girdi · ', ' Wochenrate eingegangen · ') +
              contract.installmentsPaid + '/' + contract.installmentsTotal + tx(' taksit.', ' Raten.'));
          }
          changed = true;
        }
      }

      contract = activeContract(state);
      if (contract && api.getDialogKey() === 'sponsor') {
        var press = api.getDialogByKey('press');
        if (press) {
          api.setDialogByKey('press');
          var latest = state.news && state.news[0];
          if (latest && latest.title === 'Yönetim kararı bekleniyor') latest.body = press.title;
          changed = true;
        }
      }
      if (changed) {
        api.save();
        api.render();
      }
      return result;
    };
  });

  api.wrapRender(function (previous) {
    return function () {
      var result = previous.apply(this, arguments);
      var state = api.getState();
      var contract = activeContract(state);
      if (!contract || api.getScreen() !== 'office') return result;
      var dayPanel = document.querySelector('#content .day');
      if (!dayPanel || dayPanel.querySelector('.cp-sponsor-contract')) return result;

      var total = Number(contract.totalAmount) || 0;
      var paid = Math.min(total, Number(contract.paidAmount) || 0);
      var progress = total ? Math.max(0, Math.min(100, paid / total * 100)) : 0;
      var nextIn = Math.max(0, (Number(contract.nextPaymentDay) || state.day) - state.day);
      var weeks = Number(contract.installmentsTotal) || 8;
      var paidWeeks = Number(contract.installmentsPaid) || 0;
      var card = '<section class="cp-sponsor-contract" aria-live="polite">' +
        '<div class="cp-sponsor-head"><b>🤝 ' + tx('AKTİF SPONSOR', 'AKTIVER SPONSOR') +
        '</b><strong>' + money(total) + '</strong></div>' +
        '<div class="cp-sponsor-track"><i style="width:' + progress.toFixed(1) + '%"></i></div>' +
        '<small>' + money(paid) + ' ' + tx('tahsil edildi', 'ausgezahlt') + ' · ' +
        paidWeeks + '/' + weeks + ' ' + tx('haftalık ödeme', 'Wochenraten') + '</small>' +
        '<small>' + tx('Sıradaki ödeme', 'Nächste Zahlung') + ': ' + nextIn + ' ' +
        tx('oyun günü sonra', 'Spieltage') + '</small></section>';
      dayPanel.insertAdjacentHTML('beforeend', card);
      return result;
    };
  });
})();
