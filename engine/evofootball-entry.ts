import { Match } from '../vendor/evofootball-arena/src/sim/Match';
import { buildRenderState, type RenderState } from '../vendor/evofootball-arena/src/render3d/RenderStateAdapter';
import { ThreeMatchRenderer } from '../vendor/evofootball-arena/src/render3d/ThreeMatchRenderer';
import { stylePreset } from '../vendor/evofootball-arena/src/render3d/stylePresets';
import { DT, HALF_L, HALF_W } from '../vendor/evofootball-arena/src/sim/constants';
import { randomGenome } from '../vendor/evofootball-arena/src/evolution/genome';
import { Rng } from '../vendor/evofootball-arena/src/utils/rng';
import type { PlayerAttributes } from '../vendor/evofootball-arena/src/evolution/playerGenome';
import type { TacticalGenome } from '../vendor/evofootball-arena/src/evolution/genome';
import type { MatchEvent, TeamInfo, TeamMatchStats } from '../vendor/evofootball-arena/src/sim/types';

type ClubPlayer = Record<string, any>;
type MatchInput = { club: string; opponent: string; clubKey?: string; seed: string; tactic: string; enemyTactic: string; players: ClubPlayer[]; opponentPlayers: ClubPlayer[]; colors?: string[]; minute?: number };
type LegacyEvent = { m: number; type: string; team: number; x: number; y: number; fromX: number; fromY: number; msg: string; player?: string; playerId?: string; completed?: number; passes?: number; xg?: number; onTarget?: boolean; id: string };
type LegacyStat = { pos: number; passes: number; completed: number; shots: number; on: number; xg: number; corners: number; cards: number; lost: number };
type EngineResult = { events: LegacyEvent[]; statsHistory: Array<{ minute: number; stats: LegacyStat[] }>; score: [number, number]; duration: number; userIds: string[]; userPlayers: ClubPlayer[]; opponentPlayers: ClubPlayer[]; replays: Record<string, RenderState[]> };
type ReplayTarget = { id: string; time: number; before: RenderState[] };

const REPLAY_PRE_ROLL_FRAMES = 36; // Six samples per second, about 3.5 seconds before the event.
const REPLAY_POST_TICKS = 180; // Three seconds after the event at the 60 Hz simulation step.

const roleSlots = ['GK', 'DF', 'MF', 'WG', 'WG', 'ST'];
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const stat = (value: unknown, fallback = 68): number => clamp(((Number(value) || fallback) - 35) / 60, 0.12, 0.94);
const seedOf = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
const color = (value: unknown, fallback: number): number => {
  const v = String(value || '');
  const m = v.match(/[0-9a-f]{6}/i);
  return m ? parseInt(m[0], 16) : fallback;
};
const position = (p: ClubPlayer): string => String(p.pos || p.position || '').toUpperCase();
const quality = (p: ClubPlayer): number => Number(p.rate || p.rating || 65);
const displayFlags = { actionLabels: false, heatmap: false, formation: false, passLines: false, shotVector: false, marking: false, chasers: false, perception: false, perceptionGaze: false, perceptionLowAwareness: false };

function selectSix(players: ClubPlayer[]): ClubPlayer[] {
  const pool = (players || []).slice().sort((a, b) => quality(b) - quality(a));
  const used = new Set<ClubPlayer>();
  const find = (re: RegExp, side?: 'left' | 'right'): ClubPlayer | undefined => {
    const candidates = pool.filter(p => !used.has(p) && re.test(position(p)));
    if (side) candidates.sort((a, b) => Number(position(b).includes(side === 'left' ? 'L' : 'R')) - Number(position(a).includes(side === 'left' ? 'L' : 'R')));
    return candidates[0];
  };
  const patterns = [/^(GK|GK\.|KL|GK\/)/, /^(CB|DC|DFC|DEF|LB|RB|LWB|RWB|DF)/, /^(DM|CDM|CM|MC|MF|AM|CAM)/, /^(LW|LM|WL|W|WG|AML)/, /^(RW|RM|WR|AMR)/, /^(ST|CF|FW|SP|S)/];
  const selected: ClubPlayer[] = [];
  selected.push(find(patterns[0]) || pool.find(p => /GK|KL|KEEPER/.test(position(p))) || pool[0]);
  selected[0] && used.add(selected[0]);
  selected.push(find(patterns[1]) || pool.find(p => !used.has(p)) || selected[0]);
  selected[1] && used.add(selected[1]);
  selected.push(find(patterns[2]) || pool.find(p => !used.has(p)) || selected[1]);
  selected[2] && used.add(selected[2]);
  selected.push(find(patterns[3], 'left') || pool.find(p => !used.has(p)) || selected[2]);
  selected[3] && used.add(selected[3]);
  selected.push(find(patterns[4], 'right') || pool.find(p => !used.has(p)) || selected[3]);
  selected[4] && used.add(selected[4]);
  selected.push(find(patterns[5]) || pool.find(p => !used.has(p)) || selected[4]);
  return selected.slice(0, 6);
}

function attrs(p: ClubPlayer, role: string): PlayerAttributes {
  const base = stat(quality(p));
  const technique = stat(p.technique || p.passing, base * 60 + 35);
  const pace = stat(p.pace || p.speed, base * 60 + 35);
  return {
    pace, passing: stat(p.passing, technique * 60 + 35), dribbling: stat(p.dribbling, technique * 60 + 35),
    finishing: stat(p.finishing, role === 'ST' ? base * 60 + 38 : base * 60 + 28),
    defending: stat(p.defending, role === 'DF' ? base * 60 + 38 : base * 60 + 26),
    strength: stat(p.strength, base * 60 + 30), stamina: stat(p.stamina, p.condition || base * 60 + 35),
    reflexes: stat(p.reflexes || p.goalkeeping, role === 'GK' ? base * 60 + 42 : 45),
    positioning: stat(p.decisions || p.positioning, base * 60 + 35),
  };
}

function genomeFor(rng: Rng, style: string): TacticalGenome {
  const g = randomGenome(rng);
  if (/hücum|attack/i.test(style)) { g.shootBias = 0.72; g.tempo = 0.72; g.riskTolerance = 0.68; g.attackingWidth = 0.72; }
  if (/savunma|derin|defend/i.test(style)) { g.shootBias = 0.34; g.defensiveCompactness = 0.76; g.formationDepth = 0.32; g.staminaConservation = 0.72; }
  if (/pres|press/i.test(style)) { g.pressIntensity = 0.78; g.tempo = 0.7; g.transitionPress = 0.68; }
  if (/kontra|counter|geçiş/i.test(style)) { g.counterAttackBias = 0.82; g.riskTolerance = 0.73; g.staminaConservation = 0.58; }
  return g;
}

function makeTeam(input: MatchInput, side: 0 | 1, seed: number): TeamInfo {
  const isUser = side === 0;
  const players = selectSix(isUser ? input.players : input.opponentPlayers);
  const rng = new Rng((seed + side * 0x9e3779b9) >>> 0);
  const style = isUser ? input.tactic : input.enemyTactic;
  const colorList = input.colors || [];
  const primary = color(colorList[isUser ? 0 : 1], isUser ? 0x18234e : 0xf1ead7);
  const secondary = color(colorList[isUser ? 1 : 0], isUser ? 0xf6d17b : 0x253240);
  return {
    id: `${isUser ? 'club' : 'opponent'}-${seed}`, name: isUser ? input.club : input.opponent,
    short: (isUser ? input.club : input.opponent).slice(0, 3).toUpperCase(), colors: { primary, secondary },
    playerNames: roleSlots.map((_, i) => String(players[i]?.name || `${isUser ? 'Oyuncu' : 'Rakip'} ${i + 1}`)),
    squad: roleSlots.map((role, i) => attrs(players[i] || {}, role)), genome: genomeFor(rng, style),
    coachName: 'Teknik Direktör', morale: isUser ? 0.7 : 0.5, elo: 1000,
  };
}

function statRow(s: TeamMatchStats, totalPossession: number): LegacyStat {
  return {
    pos: totalPossession ? s.possessionTime / totalPossession * 100 : 0,
    passes: s.passes, completed: s.passesCompleted, shots: s.shots, on: s.shotsOnTarget,
    xg: s.xg, corners: s.corners, cards: s.yellows + s.reds, lost: s.miscontrols + s.offsides,
  };
}

function localized(event: MatchEvent, actor: string, sideName: string): string {
  const lang = (() => { try { return localStorage.getItem('cp-ui-language-2026') === 'de'; } catch { return false; } })();
  const tr: Record<string, string> = {
    goal: `${actor} golü buldu!`, shot: `${actor} şutunu çekti.`, save: 'Kaleci kritik bir kurtarış yaptı.', woodwork: 'Şut direkten döndü!',
    tackle: `${actor} topa müdahale etti.`, interception: `${actor} pası kesti.`, keypass: `${actor} tehlikeli pası çıkardı.`,
    corner: `${sideName} köşe vuruşu kullanacak.`, foul: 'Hakem faul düdüğünü çaldı.', card: 'Hakem kartına başvurdu.',
    kickoff: 'Hakemin düdüğüyle maç başladı.', halftime: 'İlk yarı sona erdi.', fulltime: 'Hakem maçı bitirdi.', info: event.text,
  };
  const de: Record<string, string> = {
    goal: `${actor} trifft!`, shot: `${actor} schießt.`, save: 'Der Torwart pariert stark.', woodwork: 'Der Schuss prallt vom Pfosten ab!',
    tackle: `${actor} geht zum Ball.`, interception: `${actor} fängt den Pass ab.`, keypass: `${actor} spielt den gefährlichen Pass.`,
    corner: `${sideName} bekommt einen Eckball.`, foul: 'Der Schiedsrichter pfeift Foul.', card: 'Der Schiedsrichter zeigt eine Karte.',
    kickoff: 'Anstoß, das Spiel läuft.', halftime: 'Halbzeit.', fulltime: 'Abpfiff.', info: event.text,
  };
  return (lang ? de : tr)[event.type] || event.text;
}

export function simulate(input: MatchInput): EngineResult {
  const seed = seedOf(`${input.seed}|${input.clubKey || input.club}|${input.opponent}|${input.tactic}|${input.enemyTactic}`);
  const userPlayers = selectSix(input.players), opponentPlayers = selectSix(input.opponentPlayers);
  const match = new Match({ seed, teamA: makeTeam(input, 0, seed), teamB: makeTeam(input, 1, seed), derby: false });
  const events: LegacyEvent[] = [];
  let prevX = 50, prevY = 50, lastMinute = -1;
  let nextStatMinute = 0;
  const statsHistory: EngineResult['statsHistory'] = [];
  const replays: EngineResult['replays'] = Object.create(null);
  const replayRing: RenderState[] = [];
  let activeReplay: { events: ReplayTarget[]; frames: RenderState[]; untilStep: number } | null = null;
  const oldXg = [0, 0], oldOnTarget = [0, 0];
  const track = (minute: number): void => {
    const total = match.teams[0].stats.possessionTime + match.teams[1].stats.possessionTime;
    const stats = [statRow(match.teams[0].stats, total), statRow(match.teams[1].stats, total)];
    statsHistory.push({ minute, stats });
  };
  const addEvent = (event: MatchEvent, actorHint?: string): LegacyEvent => {
    const team = event.side === 1 ? 1 : 0;
    const x = clamp((match.ball.pos.x / HALF_L + 1) * 50, 4, 96);
    const y = clamp((match.ball.pos.y / HALF_W + 1) * 50, 5, 95);
    const players = selectSix(team === 0 ? input.players : input.opponentPlayers);
    const named = players.find(p => event.text.toLowerCase().includes(String(p.name || '').toLowerCase()))?.name;
    const actor = String(named || actorHint || match.ball.lastTouch?.name || match.ball.owner?.name || (team ? input.opponent : input.club));
    const typeMap: Record<string, string> = { woodwork: 'shot', keypass: 'pass', info: 'info', kickoff: 'begin', halftime: 'half', fulltime: 'end' };
    const legacy: LegacyEvent = {
      m: Math.max(0, event.minute), type: typeMap[event.type] || event.type, team, x, y,
      fromX: prevX, fromY: prevY, msg: localized(event, actor, team ? input.opponent : input.club),
      player: actor, playerId: String(players.find(p => p.name === actor)?.id || actor),
      xg: event.type === 'shot' ? Math.max(0, match.teams[team].stats.xg - oldXg[team]) : undefined,
      onTarget: event.type === 'shot' ? match.teams[team].stats.shotsOnTarget > oldOnTarget[team] : ['goal', 'save', 'woodwork'].includes(event.type),
      id: `evo-${seed}-${event.t}-${event.type}`,
    };
    if (event.type === 'shot') { oldXg[team] = match.teams[team].stats.xg; oldOnTarget[team] = match.teams[team].stats.shotsOnTarget; }
    events.push(legacy);
    prevX = x; prevY = y;
    return legacy;
  };
  const captureStart = (id: string): void => {
    const time = match.simTime;
    const before = replayRing.filter(frame => frame.t < time).slice(-REPLAY_PRE_ROLL_FRAMES);
    if (!activeReplay) activeReplay = { events: [], frames: [], untilStep: steps + REPLAY_POST_TICKS };
    activeReplay.events.push({ id, time, before });
    activeReplay.untilStep = Math.max(activeReplay.untilStep, steps + REPLAY_POST_TICKS);
  };
  const commitReplay = (): void => {
    if (!activeReplay) return;
    for (const event of activeReplay.events) {
      const after = activeReplay.frames.filter(frame => frame.t >= event.time && frame.t <= event.time + 3);
      replays[event.id] = event.before.concat(after);
    }
    activeReplay = null;
  };
  let oldPasses = [0, 0], oldCompleted = [0, 0], oldDribbles = [0, 0];
  let eventPos = 0;
  const maxSteps = Math.ceil(60 * 60 * 92);
  let steps = 0;
  while (!match.finished && steps++ < maxSteps) {
    const beforeMinute = match.minute();
    match.step(DT);
    const minute = match.minute();
    if (steps % 6 === 0) {
      const frame = buildRenderState(match, false);
      replayRing.push(frame);
      if (replayRing.length > REPLAY_PRE_ROLL_FRAMES) replayRing.shift();
      if (activeReplay) {
        if (steps <= activeReplay.untilStep) activeReplay.frames.push(frame);
        else commitReplay();
      }
    }
    const stats = match.teams.map(t => t.stats);
    for (let side = 0; side < 2; side++) {
      const passDelta = stats[side].passes - oldPasses[side];
      const completedDelta = stats[side].passesCompleted - oldCompleted[side];
      const dribbleDelta = stats[side].dribbles - oldDribbles[side];
      if (passDelta || completedDelta) {
        const teamName = side ? input.opponent : input.club;
        const x = clamp((match.ball.pos.x / HALF_L + 1) * 50, 4, 96), y = clamp((match.ball.pos.y / HALF_W + 1) * 50, 5, 95);
        const players = selectSix(side ? input.opponentPlayers : input.players);
        const owner = match.ball.owner;
        const actor = owner?.name || players[events.length % 6]?.name || teamName;
        const passEvent: LegacyEvent = { m: minute, type: 'pass', team: side, x, y, fromX: prevX, fromY: prevY, msg: completedDelta ? `${actor} pası takım arkadaşına ulaştırdı.` : `${actor} pas denedi; rakip araya girdi.`, player: actor, playerId: String(players.find(p => p.name === actor)?.id || actor), passes: passDelta, completed: completedDelta, id: `evo-${seed}-p-${match.simTime}-${side}` };
        events.push(passEvent);
        if (side === 0 ? x >= 82 : x <= 18) captureStart(passEvent.id);
        prevX = x; prevY = y;
      }
      if (dribbleDelta > oldDribbles[side]) {
        const players = selectSix(side ? input.opponentPlayers : input.players), actor = match.ball.owner?.name || players[events.length % 6]?.name || (side ? input.opponent : input.club);
        const dribbleEvent: LegacyEvent = { m: minute, type: 'dribble', team: side, x: prevX, y: prevY, fromX: prevX, fromY: prevY, msg: `${actor} topla ilerliyor.`, player: actor, playerId: String(players.find(p => p.name === actor)?.id || actor), id: `evo-${seed}-d-${match.simTime}-${side}` };
        events.push(dribbleEvent);
        if (side === 0 ? prevX >= 82 : prevX <= 18) captureStart(dribbleEvent.id);
      }
      oldPasses[side] = stats[side].passes; oldCompleted[side] = stats[side].passesCompleted; oldDribbles[side] = stats[side].dribbles;
    }
    while (eventPos < match.events.length) {
      const source = match.events[eventPos++];
      const event = addEvent(source);
      if (['goal', 'shot', 'save', 'woodwork', 'card', 'corner', 'keypass'].includes(source.type)) captureStart(event.id);
    }
    while (nextStatMinute <= minute) { track(nextStatMinute); nextStatMinute++; }
    if (minute !== beforeMinute) lastMinute = minute;
  }
  if (!match.finished) throw new Error(`EvoFootball match exceeded ${maxSteps} simulation steps`);
  commitReplay();
  if (lastMinute < 90) track(90);
  events.sort((a, b) => a.m - b.m);
  const score = match.getResult().score;
  return { events, statsHistory, score, duration: match.duration,
    userIds: userPlayers.map(p => String(p.id || p.name)), userPlayers, opponentPlayers, replays };
}

let replayRenderer: ThreeMatchRenderer | null = null;
let replayHost: HTMLElement | null = null;
let replayFrame = 0;
function playHighlight(host: HTMLElement, eventId: string): boolean {
  const frames = (window as any).CP_EVO_REPLAYS?.[eventId] as RenderState[] | undefined;
  if (!frames || frames.length < 2 || !host) return false;
  try {
    if (!replayRenderer || replayHost !== host) {
      replayRenderer?.dispose();
      replayRenderer = new ThreeMatchRenderer(host, stylePreset('coherence', 'night'));
      replayRenderer.setFxQuality('low');
      replayRenderer.setCameraMode('broadcast');
      replayHost = host;
      if (!document.getElementById('cp-evo-render-style')) {
        const style = document.createElement('style'); style.id = 'cp-evo-render-style';
        style.textContent = '.goal-banner{position:absolute;z-index:5;top:12px;left:50%;transform:translateX(-50%);padding:8px 18px;background:#07151be8;border:1px solid #baf361;color:#eff7ed;text-align:center;pointer-events:none}.gb-title{font-weight:900;font-size:25px}.gb-sub{font-size:11px;color:#b6c8b9}.goal-banner.hidden,.score-bug.hidden,.pitch-vignette.hidden,.tacmap.hidden{display:none}.score-bug{position:absolute;right:10px;top:10px;z-index:4;background:#07151bd9;padding:7px 10px;border:1px solid #73907f;color:#eef7eb}.pitch-vignette{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 55px #00100d66}.tacmap{position:absolute;right:8px;bottom:8px;width:135px;height:90px;z-index:3}#cp3d-stage .gl-canvas{width:100%;height:100%;display:block}'; document.head.appendChild(style);
      }
    }
    cancelAnimationFrame(replayFrame);
    const started = performance.now(), duration = 4300;
    const draw = (now: number): void => {
      if (!replayRenderer || !host.isConnected) { replayFrame = 0; return; }
      const ratio = Math.min(1, Math.max(0, (now - started) / duration));
      const ix = Math.min(frames.length - 1, Math.floor(ratio * (frames.length - 1)));
      const before = frames[Math.max(0, ix - 1)];
      const dt = before ? Math.max(1 / 60, Math.min(0.1, frames[ix].t - before.t)) : 1 / 60;
      replayRenderer.update(frames[ix], dt, displayFlags, null);
      if (ratio < 1) replayFrame = requestAnimationFrame(draw); else replayFrame = 0;
    };
    replayFrame = requestAnimationFrame(draw);
    return true;
  } catch (error) { console.warn('EvoFootball 3D highlight fell back to broadcast renderer', error); return false; }
}
function stopRenderer(): void {
  cancelAnimationFrame(replayFrame); replayFrame = 0;
  replayRenderer?.dispose(); replayRenderer = null; replayHost = null;
}

(window as any).CP_EVO_ENGINE = { version: 'evofootball-arena@0.25.1', format: '6v6', simulate, playHighlight, stopRenderer };
window.dispatchEvent(new Event('cp:evo-engine-ready'));
