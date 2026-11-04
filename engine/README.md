# EvoFootball match engine bridge

`evofootball-entry.ts` adapts the vendored EvoFootball Arena v0.25.1 match world to Club President's career data. The 6v6 world uses the selected goalkeeper, defender, midfielder, two wingers, and striker. It returns the match events and minute-by-minute statistics used by the existing commentary, score, reports, and saves. Its 3D renderer replays captured simulation states at major moments.

The compiled browser bundle is `assets/evofootball-engine.js`. It includes Three.js 0.186.1 and the EvoFootball renderer; their MIT notices are in `vendor/evofootball-arena/`.

The engine seed is derived from the career, fixture, clubs, and tactics. Re-simulating after an intervention preserves already-played events and replaces the remaining events. Existing career storage is not reset.
