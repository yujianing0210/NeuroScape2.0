# NeuroScape Codex Instruction — Step 1
## Motion-Bound Event Playback

### Target repository / branch
- Repository: `yujianing0210/NeuroScape2.0`
- Branch to inspect and modify: `debug-0831-01`
- Work only locally and do not update the current branch.
- Before editing, inspect the current implementation and tests for the files/functions mentioned below. Preserve existing architecture and public interfaces wherever possible.

---

## 1. Goal

Fix the current mismatch between **short event audio clips** and their intended **spatial motion lifecycle**.

At present, many event sounds (e.g. birds) are only audible for one short clip, often ~1–2 seconds. This is too short for the listener to perceive an authored motion such as:
- far → near,
- near → far,
- overhead pass,
- orbit / arc,
- drift.

The intended behavior is:

> **Spatial motion duration defines the event lifecycle. Short clips should repeat or burst naturally within that lifecycle so that the audible sound remains present long enough to complete the authored trajectory.**

This is a deterministic runtime/materialization change. Do **not** add new LLM calls or ask the LLM to output trajectory coordinates, playback count, gain curves, or DSP parameters.

---

## 2. Non-goals / hard constraints

Do **NOT** modify the following behavior unless a type compatibility change is absolutely necessary:

- Decision 1 schema or prompt
- Decision 2 schema or prompt
- EEG interpretation
- adaptation cadence / trigger timing
- scene-node selection
- journey progression / adjacency rules
- listener locomotion logic
- scene-transition footstep logic
- HRTF renderer architecture
- API / network request count
- session duration logic
- semantic candidate-selection logic

Preserve the architecture:

> **LLM = semantic decision**  
> **deterministic code = physical/spatial realization**

This patch must not introduce a new asynchronous planning stage.

---

## 3. Current code issue to verify before editing

In `packages/adaptive-planner/src/semantic-materializer.ts`, inspect `insertedElement()`.

The current event materialization creates a trajectory whose start and end both use the same semantic `locationId`, even though the audio library already contains authored `default_motion` metadata for some assets.

Therefore, adaptive events can remain effectively stationary even though the runtime can execute real motion.

In `module-03-runtime-scene-controller/src/controllers/EventController.ts`, verify that:

- `item.motion` is already supported,
- `motionTrajectory()` already handles:
  - `stationary`
  - `drift`
  - curved motion used by pass-by / orbit / approach-recede
- runtime world position and velocity are updated continuously.

Do not replace this runtime system. Reuse it.

---

## 4. Required implementation

### 4.1 Resolve authored `default_motion` into runtime event motion

Create a small deterministic resolver/helper rather than adding asset-specific `if` statements throughout controllers.

Conceptual API:

```ts
resolveEventMotion(asset, context): {
  motion?: EventMotion;
  durationMs: number;
}
```

Use the existing audio-library metadata as the authoritative source.

Map supported authored motion types to the existing runtime `EventPlanItem.motion` / `EventMotion` representation.

At minimum support the currently authored motion types found in the library, including where applicable:

- none / stationary
- drift
- overhead pass → runtime pass-by style motion
- approach / recede / approach-recede
- local random movement

For `local_random`, use a deterministic local trajectory derived from authored metadata. Do **not** introduce nondeterministic `Math.random()` behavior that makes replay/debugging inconsistent. If needed, derive a deterministic direction from asset ID / element ID or use a fixed authored small drift/orbit pattern.

### 4.2 Motion duration is authoritative for moving short events

For an event with meaningful authored motion:

```text
event duration = authored motion duration
```

or the validated resolved motion lifecycle if a longer existing authored lifecycle is intentionally required.

Do not let the source WAV duration terminate the spatial event.

The event must remain active until the planned motion ends.

### 4.3 Add / resolve a “repeat to fill motion” playback behavior

Short clips such as bird calls should stay audible across the motion lifecycle.

Preferred behavior:

> repeat the loaded buffer while the event is active, then truncate/stop at the planned event end.

Avoid making `repeatCount` the authoritative event lifecycle.

It is acceptable to implement this using the existing playback policy if the current `loop` / `durationPolicy: loop-until-end` semantics can safely express it.

If a new playback-policy value is necessary, keep the change minimal and backwards compatible, e.g.:

```ts
mode: 'repeat-to-fill-motion'
```

or an equivalent deterministic policy.

Do not add a new network request to calculate buffer duration.

The audio buffer is already loaded locally by the audio layer; use existing local playback mechanisms.

### 4.4 Preserve discrete burst semantics where appropriate

Do not blindly loop every event.

Use the existing `playback_contract` as the source of truth.

Expected high-level behavior:

| Event behavior | Intended playback |
|---|---|
| bird / short moving chirps | repeat across motion lifecycle |
| owl | authored burst across motion lifecycle |
| brief one-shot transient | play once |
| long bed | keep existing long-bed behavior |

Do not change long environmental ambient behavior in this step; that belongs to Step 2.

### 4.5 Owl behavior

For `forest_soft_owl_far_01`:

- preserve the authored 2-or-3-hoot concept,
- distribute those hoots over the motion lifecycle rather than firing the whole burst immediately,
- support both 2 and 3 repeats deterministically,
- do not use uncontrolled randomness.

If the existing contract exposes `repeat_count_options: [2,3]`, choose between them using a deterministic session/use-based or stable element-based rule.

### 4.6 Gain should reinforce motion, without replacing HRTF motion

Moving sounds should still move spatially through the existing HRTF path.

For repeated moving sounds, allow overall repeat gain to follow source proximity / motion direction:

- approaching → generally increasing gain
- receding → generally decreasing gain
- approach-recede → increase toward closest point, then decrease
- overhead pass → gain may peak around closest/central point

Prefer deriving this deterministically from the planned trajectory or distance rather than manually hard-coding arbitrary per-asset gain arrays.

Important:
- preserve existing gain ceilings / safe-gain metadata,
- do not multiply gain in a way that can exceed `max_safe_gain`,
- avoid double-counting distance attenuation if `plannedDistanceGain()` already handles the same dimension.

If the existing continuous distance-gain logic already creates the desired loudness change, keep per-repeat gain subtle or omit it. HRTF position must remain the primary spatial mechanism.

---

## 5. Suggested files to inspect / modify

Likely relevant:

- `packages/adaptive-planner/src/semantic-materializer.ts`
- `packages/contracts/src/audio-library.ts`
- `packages/contracts/src/audio_library.json`
- playback-policy contract/type files
- `frontend/src/audio/SourceManager.ts`
- `frontend/src/audio/PlaybackScheduler.ts`
- `frontend/src/audio/GainManager.ts`
- existing relevant tests

Try **not** to change `EventController.ts` unless required. It already knows how to execute `item.motion`; the main missing connection is materialization + playback lifecycle.

Do not refactor unrelated code.

---

## 6. Latency / performance requirements

This patch must not materially increase adaptive-system latency.

### Must remain unchanged
- number of LLM calls
- Decision 1 → Decision 2 flow
- API round trips
- adaptation polling/cadence
- EEG processing cadence

### Allowed local work
- resolving authored motion metadata
- computing motion duration
- computing a deterministic repeat/burst policy
- scheduling already-loaded Web Audio buffers
- existing per-frame position/gain updates

### Do not
- call the LLM per audio repeat
- reload the same buffer for every repeat
- fetch metadata from a network endpoint during playback
- create a timer loop with expensive allocation every audio frame
- recreate `PannerNode`s on every repeat if the current source can be reused
- decode the same audio file repeatedly

Use the existing asset cache / audio-buffer lifecycle.

---

## 7. Required acceptance tests

Add or update automated tests where practical.

### A. Bird pass-by
Given a bird asset with:
- clip shorter than the authored motion duration,
- authored overhead/pass-by motion,

verify:

- materialized event contains real `motion`,
- start and end spatial positions differ,
- event duration follows the motion duration,
- playback remains active across the motion,
- audio can repeat rather than ending after the first clip,
- event terminates at planned end.

### B. Approaching event
Verify:
- position changes from farther to nearer,
- overall perceived/resolved gain does not decrease contrary to the authored approach, unless capped.

### C. Receding event
Verify:
- position changes from nearer to farther,
- gain does not increase contrary to the authored recede.

### D. Owl
Verify:
- 2 or 3 hoots are supported,
- hoots are distributed across the motion lifecycle,
- behavior is deterministic/replayable,
- gain remains within safe limits.

### E. One-shot event regression
Verify a true one-shot transient does **not** become an infinite/repeating sound.

### F. System regression
Verify:
- Decision 1 / Decision 2 schemas unchanged unless minimally necessary,
- scene transition behavior still works,
- footsteps still use current listener-moving logic,
- session completion timing is unchanged,
- audio sources are cleaned up at event end,
- no additional API call is introduced.

---

## 8. Manual perceptual test

After automated tests, add a minimal local/debug test method if the repo already has an appropriate test harness.

Listen for:

### Before
A bird clip plays once for ~1–2 seconds; motion is difficult or impossible to perceive.

### After
The same bird remains audible over approximately the authored 6–8 second trajectory and clearly moves through space.

The desired perceptual result is:

> “a bird moves through the environment”

rather than:

> “the system played a bird sound effect.”

Avoid excessive repetition that sounds like an alarm or machine loop. If clips have an authored repeat gap, preserve/use it.

---

## 9. Implementation quality

Please:

1. inspect existing types/tests before changing them;
2. make the smallest coherent patch;
3. reuse existing playback and HRTF abstractions;
4. centralize lifecycle resolution in a deterministic helper;
5. avoid duplicated sound-ID-specific logic;
6. document any compatibility fallback;
7. run typecheck/tests relevant to modified packages;
8. report exactly which files changed and why.

At the end, provide:

- concise implementation summary,
- changed files,
- tests run and results,
- any remaining edge cases,
- confirmation that no new LLM/API call or adaptation-stage latency was introduced.
