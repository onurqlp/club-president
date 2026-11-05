(function(){
'use strict';
var API=window.CP_OFFPITCH_API;
function state(){try{return API&&API.getState()}catch(e){return null}}
function id(p){return String(p&&(p.id||p.name)||'')}
function role(p){var x=p&&p.pos||'';return x==='KL'?'gk':['STP','SLB','SĞB'].includes(x)?'def':['DOS','MO'].includes(x)?'mid':['SNT','SLK','SĞK'].includes(x)?'att':'other'}
function toast(s){if(API&&API.toast)API.toast(s)}
function render(){if(API&&API.render)API.render()}
function save(){if(API&&API.save)API.save()}

function setupTheme(){
 document.documentElement.setAttribute('data-cp-theme','brand');
 var old=document.getElementById('cp-theme-toggle');if(old)old.remove();
}

function swap(inId,outId){
 var st=state(),ps=st&&st.players;if(!st||!Array.isArray(ps))return false;
 var a=ps.find(function(p){return id(p)===String(inId)}),b=ps.find(function(p){return id(p)===String(outId)});
 if(!a||!b||role(a)!==role(b)){toast('Aynı pozisyon grubundan oyuncu seç.');return false}
 if(Number(a.condition||0)<55||a.injured||a.injuryUntilRound>st.round||a.suspendedUntilRound>st.round||a.restUntilRound17>=st.round){toast('Bu oyuncu şu an ilk 11 için uygun değil.');return false}
 var xi=Array.isArray(st.startingXIIds)?st.startingXIIds.slice():[],ai=xi.indexOf(id(a)),bi=xi.indexOf(id(b));
 if(ai>=0||bi<0){toast('Listeden yedek bir oyuncu seçip sahadaki oyuncuya dokun.');return false}
 xi[bi]=id(a);st.startingXIIds=xi;save();render();toast(a.name+' ilk 11’de '+b.name+' yerine başladı.');return true
}
function roster(){
 var grid=document.querySelector('.roster-grid');if(!grid||grid.dataset.uxReady)return;
 var panel=grid.closest('.panel');if(!panel)return;grid.dataset.uxReady='1';
 var tools=document.createElement('div');tools.className='cp-roster-tools';tools.innerHTML='<input type="search" aria-label="Kadroda oyuncu ara" placeholder="Oyuncu veya mevki ara…"><select aria-label="Kadro sıralaması"><option value="rate">Güce göre</option><option value="condition">Kondisyona göre</option><option value="name">Ada göre</option></select><span class="cp-roster-count" aria-live="polite"></span>';panel.insertBefore(tools,grid);
 var input=tools.querySelector('input'),sort=tools.querySelector('select'),count=tools.querySelector('.cp-roster-count');
 var st=state(),ps=st&&st.players||[];
 Array.prototype.forEach.call(grid.querySelectorAll('.roster-player'),function(row){
  var p=ps.find(function(x){return id(x)===row.dataset.prof});
  row.dataset.uxName=((p&&p.name)||row.innerText).toLocaleLowerCase('tr');row.dataset.uxPos=((p&&p.pos)||'').toLocaleLowerCase('tr');row.dataset.uxRate=String(Number(p&&p.rate)||0);row.dataset.uxCondition=String(Number(p&&p.condition)||0);row.draggable=true;
  row.setAttribute('aria-label',(p&&p.name||'Oyuncu')+'; sürükleyerek sahadaki aynı pozisyon grubundaki oyuncuyla değiştir');
  if(!row.querySelector('[data-cp-pick]')){var pick=document.createElement('span');pick.className='cp-roster-pick';pick.setAttribute('data-cp-pick','');pick.setAttribute('role','button');pick.setAttribute('tabindex','0');pick.textContent='İlk 11’e seç';row.appendChild(pick)}
 });
 function arrange(){var rows=Array.prototype.slice.call(grid.querySelectorAll('.roster-player')),q=input.value.trim().toLocaleLowerCase('tr'),key=sort.value;rows.sort(function(a,b){if(key==='name')return a.dataset.uxName.localeCompare(b.dataset.uxName,'tr');var k=key==='rate'?'uxRate':'uxCondition';return (Number(b.dataset[k])||0)-(Number(a.dataset[k])||0)});rows.forEach(function(r){grid.appendChild(r);r.hidden=!!q&&!((r.dataset.uxName+' '+r.dataset.uxPos).includes(q))});count.textContent=rows.filter(function(r){return !r.hidden}).length+' / '+rows.length+' oyuncu · yedek oyuncuyu sahadaki mevkiye sürükle veya “İlk 11’e seç”e dokun'}
 input.addEventListener('input',arrange);sort.addEventListener('change',arrange);arrange()
}
function nav(){var bar=document.getElementById('nav');if(!bar||bar.querySelector('.cp-more-nav'))return;var btn=document.createElement('button');btn.type='button';btn.className='cp-more-nav';btn.setAttribute('aria-expanded','false');btn.innerHTML='<b>⋯</b><span>Daha fazla</span>';var menu=document.createElement('div');menu.className='cp-more-menu';menu.setAttribute('role','menu');['board','calendar','phone','world'].forEach(function(x){var source=bar.querySelector('[data-sc="'+x+'"]');if(source){var b=document.createElement('button');b.type='button';b.dataset.sc=x;b.setAttribute('role','menuitem');b.innerHTML='<b>'+source.querySelector('b').textContent+'</b><span>'+source.querySelector('small').textContent+'</span>';menu.appendChild(b)}});bar.appendChild(menu);bar.appendChild(btn);btn.addEventListener('click',function(){var open=menu.classList.toggle('open');btn.setAttribute('aria-expanded',String(open))});document.addEventListener('click',function(e){if(!bar.contains(e.target)){menu.classList.remove('open');btn.setAttribute('aria-expanded','false')}});menu.addEventListener('click',function(e){if(e.target.closest('[data-sc]')){menu.classList.remove('open');btn.setAttribute('aria-expanded','false')}})}
var selected=null;
document.addEventListener('dragstart',function(e){var row=e.target.closest('.roster-player');if(!row)return;selected=row.dataset.prof;if(e.dataTransfer){e.dataTransfer.setData('text/plain',selected);e.dataTransfer.effectAllowed='move'}});
document.addEventListener('dragover',function(e){if(e.target.closest('.ppl'))e.preventDefault()});
document.addEventListener('drop',function(e){var target=e.target.closest('.ppl');if(!target)return;e.preventDefault();var from=e.dataTransfer&&e.dataTransfer.getData('text/plain')||selected;selected=null;if(from)swap(from,target.dataset.prof)});
document.addEventListener('click',function(e){
 var pick=e.target.closest('[data-cp-pick]'),starter=e.target.closest('.ppl');
 if(pick){var row=pick.closest('.roster-player');if(!row)return;document.querySelectorAll('.cp-roster-player-selected').forEach(function(x){x.classList.remove('cp-roster-player-selected')});selected=row.dataset.prof;row.classList.add('cp-roster-player-selected');toast('Şimdi sahadaki değiştirmek istediğin oyuncuya dokun.');e.preventDefault();e.stopPropagation();return}
 if(starter&&selected){var from=selected;selected=null;document.querySelectorAll('.cp-roster-player-selected').forEach(function(x){x.classList.remove('cp-roster-player-selected')});e.preventDefault();e.stopImmediatePropagation();swap(from,starter.dataset.prof)}
},true);
function recommend(){
 var box=document.querySelector('.cp-subs-inner'),out=document.getElementById('cp-out'),inn=document.getElementById('cp-in');if(!box||!out||!inn||box.querySelector('.cp-quick-sub'))return;
 var card=document.createElement('div');card.className='cp-quick-sub';card.innerHTML='<p><b>Akıllı değişiklik önerisi</b><br>En yorgun ilk 11 oyuncusu için aynı pozisyondan daha dinç bir yedek bulur. Son karar sende.</p><button type="button" class="btn dark">ÖNERİYİ GÖSTER</button>';box.prepend(card);
 card.querySelector('button').addEventListener('click',function(){var st=state(),ps=st&&st.players||[],starters=Array.prototype.slice.call(out.options).slice(1).map(function(o){return ps.find(function(p){return id(p)===o.value})}).filter(Boolean),bench=Array.prototype.slice.call(inn.options).slice(1).map(function(o){return ps.find(function(p){return id(p)===o.value})}).filter(Boolean);starters.sort(function(a,b){return (Number(a.condition)||0)-(Number(b.condition)||0)});var choice=null;for(var i=0;i<starters.length&&!choice;i++){var subs=bench.filter(function(p){return role(p)===role(starters[i])}).sort(function(a,b){return (Number(b.condition)||0)-(Number(a.condition)||0)});if(subs.length&&Number(starters[i].condition||85)<78&&Number(subs[0].condition||0)>Number(starters[i].condition||0)+5)choice=[starters[i],subs[0]]}if(!choice){toast('Şu an kondisyon farkı belirgin olan uygun bir değişiklik yok.');return}out.value=id(choice[0]);inn.value=id(choice[1]);card.querySelector('p').innerHTML='<b>Öneri: '+choice[0].name+' → '+choice[1].name+'</b><br>Kondisyon: '+Math.round(choice[1].condition||0)+'% / '+Math.round(choice[0].condition||0)+'%. “Oyuncu değiştir”e basınca uygulanır.'})
}
document.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&e.target.closest('[data-cp-pick]')){e.preventDefault();e.target.closest('[data-cp-pick]').click()}},true);
setupTheme();
var queued=false;function enhance(){if(queued)return;queued=true;requestAnimationFrame(function(){queued=false;nav();roster();recommend();var d=document.querySelector('.cp-subs');if(d&&document.body.classList.contains('cp-match-active')&&!d.dataset.userClosed)d.open=true})}
new MutationObserver(enhance).observe(document.body,{subtree:true,childList:true});document.addEventListener('toggle',function(e){if(e.target.matches('.cp-subs')&&!e.target.open)e.target.dataset.userClosed='1'},true);enhance()
})();