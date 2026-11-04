/**
 * Match.step phase profiler — the perf regression gate (docs/PROBE-CONTRACTS.md
 * §3 hard gate, §5.5). Buckets the per-tick cost by phase so we can SEE which
 * phase grows as the substrate rebuild adds perception/prediction/affordance/
 * candidate compute inside `decide`.
 *
 * ⚠ INVARIANTS (why this is safe):
 *  - OFF by default (`enabled = false`). Fingerprint & determinism runs never
 *    touch it — `mark()` returns 0 without reading the clock, `add()`/`stepDone()`
 *    early-return. When off the only cost is a handful of boolean checks per tick.
 *  - PURE-OBSERVATIONAL. Timing is wall-clock and NEVER feeds back into the
 *    simulation — no value here is read by any sim/AI/evolution code path, so a
 *    profiled run produces byte-identical results to an unprofiled one (asserted
 *    by scripts/perf-baseline.ts). Uses NO Math.random / Date; only performance.now,
 *    and only when enabled.
 */

const profNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : 0;

const SAMPLE_CAP = 300_000; // per-step samples for percentiles; caps memory

class Profiler {
  enabled = false;
  private totals: Record<string, number> = {};
  private counts: Record<string, number> = {};
  private steps = 0;
  private cur = 0; // accumulator for the current step
  private samples: number[] = [];
  private sample = false;

  /** Clears accumulators. `sample: true` records per-step totals for percentiles. */
  reset(opts: { sample?: boolean } = {}): void {
    this.totals = {};
    this.counts = {};
    this.steps = 0;
    this.cur = 0;
    this.samples = [];
    this.sample = opts.sample ?? false;
  }

  /** Timestamp for a phase start — 0 (no clock read) when disabled. */
  mark(): number {
    return this.enabled ? profNow() : 0;
  }

  /** Close a phase started at `t0`. No-op when disabled. */
  add(phase: string, t0: number): void {
    if (!this.enabled) return;
    const dt = profNow() - t0;
    this.totals[phase] = (this.totals[phase] ?? 0) + dt;
    this.counts[phase] = (this.counts[phase] ?? 0) + 1;
    this.cur += dt;
  }

  /** End of a timed (playing) tick — banks the step's total. No-op when disabled. */
  stepDone(): void {
    if (!this.enabled) return;
    if (this.cur > 0) {
      this.steps++;
      if (this.sample && this.samples.length < SAMPLE_CAP) this.samples.push(this.cur);
    }
    this.cur = 0;
  }

  report(): ProfileReport {
    const phaseNames = Object.keys(this.totals);
    const grand = phaseNames.reduce((a, p) => a + this.totals[p], 0);
    const phases = phaseNames
      .map((p) => ({
        phase: p,
        totalMs: this.totals[p],
        calls: this.counts[p],
        pctOfTick: grand > 0 ? (this.totals[p] / grand) * 100 : 0,
        usPerCall: this.counts[p] > 0 ? (this.totals[p] / this.counts[p]) * 1000 : 0,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
    const s = [...this.samples].sort((a, b) => a - b);
    const pct = (q: number): number =>
      s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
    return {
      steps: this.steps,
      grandMs: grand,
      usPerStep: this.steps > 0 ? (grand / this.steps) * 1000 : 0,
      stepP50Us: pct(0.5) * 1000,
      stepP95Us: pct(0.95) * 1000,
      stepP99Us: pct(0.99) * 1000,
      sampled: s.length,
      phases,
    };
  }
}

export interface ProfileReport {
  steps: number;
  grandMs: number;
  usPerStep: number;
  stepP50Us: number;
  stepP95Us: number;
  stepP99Us: number;
  sampled: number;
  phases: Array<{ phase: string; totalMs: number; calls: number; pctOfTick: number; usPerCall: number }>;
}

/** The single shared profiler. Import as `prof` in the sim; toggle `enabled` in probes. */
export const PROFILER = new Profiler();
