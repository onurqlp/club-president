(function () {
  'use strict';
  var api = window.CP_OFFPITCH_API;
  if (!api) return;

  function isGerman() {
    try { return localStorage.getItem('cp-ui-language-2026') === 'de'; }
    catch (error) { return false; }
  }
  function tx(tr, de) { return isGerman() ? de : tr; }
  function hasChoice() {
    var prompt = api.getDialog();
    return !!(api.getState() && prompt && Array.isArray(prompt.choices) && prompt.choices.length);
  }
  function returnToDecision() {
    api.setScreen('office');
    api.render();
    api.toast(tx('Önce başkanlık kararını yanıtla. Karar kaydedilene kadar gün ilerlemez.', 'Beantworte zuerst die Präsidiumsanfrage. Der Tag kann erst danach fortgesetzt werden.'));
  }

  api.wrapSave(function (previous) {
    return function () {
      var state = api.getState();
      if (state) state.pendingDecisionKey = api.getDialogKey();
      return previous.apply(this, arguments);
    };
  });

  api.wrapDay(function (previous) {
    return function () {
      if (hasChoice()) return returnToDecision();
      return previous.apply(this, arguments);
    };
  });

  api.wrapRender(function (previous) {
    return function () {
      var result = previous.apply(this, arguments);
      if (!api.getState()) return result;
      var pending = hasChoice();
      if (pending) {
        var label = tx('KARAR BEKLİYOR ›', 'ENTSCHEIDUNG OFFEN ›');
        var buttons = document.querySelectorAll('[data-a="day"], [data-a="quickDay"], [data-a="toMatch"], [data-a="nextSeason"], [data-a="play"], [data-a="fast"], #nav [data-sc="match"]');
        var blockedLabel = tx('Önce açık başkanlık kararını yanıtla', 'Beantworte zuerst die offene Präsidiumsanfrage');
        var blockedHint = tx('Bu işlem için önce açık başkanlık kararını yanıtla.', 'Beantworte zuerst die offene Präsidiumsanfrage, bevor du fortfährst.');
        buttons.forEach(function (button) {
          if (button.matches('[data-a="day"], [data-a="quickDay"], [data-a="toMatch"]')) button.textContent = label;
          button.setAttribute('aria-label', blockedLabel);
          button.setAttribute('aria-disabled', 'true');
          button.setAttribute('data-cp-decision-blocked', '');
          button.title = blockedHint;
        });
        var dialogue = document.querySelector('.dialogue');
        if (dialogue && !dialogue.querySelector('.cp-decision-ribbon')) {
          dialogue.insertAdjacentHTML('afterbegin', '<div class="cp-decision-ribbon">🔔 ' + tx('ÖNCELİKLİ KARAR · YANITLAMADAN İLERLEMEZ', 'ENTSCHEIDUNG OFFEN · VOR DEM WEITERGEHEN BEANTWORTEN') + '</div>');
        }
        var inbox = document.querySelector('.phone-list');
        if (inbox && !inbox.querySelector('.cp-decision-return')) {
          inbox.insertAdjacentHTML('afterbegin', '<button type="button" class="cp-decision-return" data-cp-decision-return><span>🔔</span><span><b>' + tx('Yanıt bekleyen başkanlık kararı', 'Offene Präsidiumsanfrage') + '</b><small>' + tx('Kararı aç ve günü güvenle ilerlet', 'Anfrage öffnen und danach den Tag fortsetzen') + '</small></span><strong>›</strong></button>');
        }
      }
      return result;
    };
  });

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-a="day"], [data-a="quickDay"], [data-a="toMatch"], [data-a="nextSeason"], [data-a="play"], [data-a="fast"], [data-sc="match"]');
    if (target && hasChoice()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      returnToDecision();
      return;
    }
    var resume = event.target.closest('[data-a="resume"]');
    if (resume) {
      window.setTimeout(function () {
        var state = api.getState();
        if (state && state.pendingDecisionKey && api.restorePendingDecision()) api.render();
      }, 0);
      return;
    }
    var openDecision = event.target.closest('[data-cp-decision-return]');
    if (openDecision && hasChoice()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      returnToDecision();
    }
  }, true);

  api.restorePendingDecision();
})();
