# NeuroScape Codex Instruction — Step 2
## Asset-Aware Gradual Fade-In / Fade-Out

### Target repository / branch
- Repository: `yujianing0210/NeuroScape2.0`
- Branch to inspect and modify: `debug-0831-01`
- Execute this **after Step 1 (Motion-Bound Event Playback)** has been completed and verified.
- Preserve the Step 1 behavior.

---

## 1. Goal

Fix the current perceptual problem that sounds can appear or disappear too abruptly.

The system should use **different envelope durations for different perceptual sound roles**:

### Short discrete event sounds
Examples:
- bird chirps
- owl calls
- small animal / insect events

These may retain relatively short fades (roughly sub-second to ~1 second), because the underlying sounds are themselves short and discrete.

### Environmental / continuous sounds
Examples:
- stream
- waterfall
- ocean waves
- other long localized ambient beds

These should enter and leave much more gradually so that the listener perceives:

> approaching / entering / leaving an acoustic environment

rather than:

> a sound being switched on or off.

The implementation must be deterministic and local. Do **not** change LLM reasoning or add API calls.

---

## 2. Non-goals / hard constraints

Do **NOT** alter:

- Decision 1
- Decision 2
- EEG interpretation
- semantic asset selection
- scene graph / adjacency
- adaptation cadence
- journey progression
- listener movement
- footstep selection
- HRTF architecture
- event-motion behavior added in Step 1
- session timing
- number of API / LLM requests

This patch is strictly about **gain envelopes and transition smoothing**.

Do not turn this task into a broad audio-engine refactor.

---

## 3. Current issue to verify before editing

Inspect:

`module-03-runtime-scene-controller/src/controllers/EventController.ts`

The current implementation uses a generic:

```ts
SHORT_EVENT_ENVELOPE = {
  fadeInMs: 750,
  fadeOutMs: 1000,
  minimumAudiblePlateauMs: 3000
}
```

and `envelope()` scales this generic envelope according to event duration.

However, the audio library already contains asset-specific authored metadata such as:

```text
fade_in_sec
fade_out_sec
```

Some assets (e.g. water-related environmental sounds) are authored with substantially longer fades, but those values are not consistently executed by runtime controllers.

Also inspect:

- `AmbientController.ts`
- materialization / playback-policy code
- audio-library contract
- patch transition handling (`INSERT`, `SUPPRESS`, `REPLACE`)
- `GainManager.ts`
- `TransitionController.ts`

Identify every path where a sound can:
- begin,
- be suppressed,
- be replaced,
- naturally end,
- end with the session.

The goal is consistent fade behavior across those paths.

---

## 4. Required implementation

### 4.1 Introduce one deterministic envelope resolver

Avoid spreading asset-specific `if (assetId === ...)` rules across controllers.

Create a small helper / resolver, e.g. conceptually:

```ts
resolveAudioEnvelope(asset, lifecycleContext): {
  fadeInMs: number;
  fadeOutMs: number;
}
```

Priority order:

```text
1. valid asset-specific authored fade_in_sec / fade_out_sec
2. sensible category / playback-contract default
3. current generic fallback
```

The asset library should remain the preferred source of truth.

Do not add LLM-generated fade values.

### 4.2 Preserve short fades for short discrete events

Bird / owl / insect / rustle-style event sounds should not get multi-second fades that erase the transient.

A reasonable fallback category behavior is approximately:

```text
short discrete event:
fade-in  ~0.3–0.75 s
fade-out ~0.5–1.0 s
```

Do not force these exact numbers if good authored metadata already exists.

The important requirement is:

> Step 2 must not make motion-bound short events from Step 1 feel sluggish or inaudible.

### 4.3 Long environmental sounds need gradual fades

For long environmental/localized beds, honor longer authored values.

Target perceptual class:

- stream: typically several seconds
- waterfall: typically several seconds
- ocean waves: typically several seconds
- long environmental foundation beds: gradual transition

If authored values are present, use them.

Where metadata is missing, use conservative category defaults rather than the short-event envelope.

A sensible fallback could be on the order of:

```text
localized environmental bed:
fade-in  4–6 s
fade-out 4–6 s
```

Ocean / very broad environmental beds may reasonably use longer authored values (e.g. ~6–8 s), but do not globally force those values onto every ambient sound.

### 4.4 Respect lifecycle duration and preserve an audible plateau

Prevent invalid cases such as:

```text
duration = 8 s
fade-in = 6 s
fade-out = 6 s
```

The resolver must proportionally clamp fades when necessary.

Recommended invariant:

```text
fadeInMs + fadeOutMs <= durationMs - minimumPlateauMs
```

or a proportional equivalent.

For long environmental sounds, preserve a meaningful stable section when possible.

For very short discrete events, allow the existing short-event logic to scale fades down safely.

Do not permit negative/NaN durations.

### 4.5 Apply fades to all relevant lifecycle paths

Ensure gradual fade-out is honored when a sound:

- reaches planned end,
- is explicitly `SUPPRESS`ed,
- is `REPLACE`d,
- is removed due to a scene transition,
- ends at a controlled lifecycle boundary.

Avoid abrupt:

```text
gain > 0 → source.stop()
```

when a fade window is available.

However:
- emergency cleanup / dispose at full session teardown may remain immediate if required for correctness,
- do not delay session completion just to finish a long fade beyond the session boundary.

### 4.6 Environmental scene transition behavior

For stream / waterfall / ocean-like foundations, the intended perceptual result is:

```text
distant / quiet
→ gradually present
→ stable environmental presence
→ gradually distant
→ gone
```

Use gain automation / existing transition infrastructure.

Do not simulate this by asking the LLM to make repeated `ADJUST` decisions.

One semantic insert/suppress action should be sufficient; runtime performs the smooth envelope.

### 4.7 Preserve loop behavior

Long environmental sounds may already use looping / long-bed playback.

Do not break this.

Fade-in/fade-out is a gain-envelope concern and should be layered over existing loop behavior.

Do not reload/decode the buffer on every loop.

If the current loop seam itself is audible, do **not** expand scope into a full crossfade-loop implementation unless a trivial existing mechanism already supports it. This instruction focuses on **entry/exit fades**, not loop-seam redesign.

---

## 5. Specific assets / behaviors to verify

At minimum inspect and test the current canonical IDs corresponding to:

- stream ambient bed used by the current library
- waterfall / water-drop context
- ocean waves
- bird event
- owl event

Do not assume an old asset name exists; use the canonical IDs in the current `audio_library.json`.

The requested perceptual behavior is:

### Bird / owl
- short envelope,
- no abrupt click/onset,
- no excessively slow fade.

### Stream / waterfall / ocean
- clearly gradual entry,
- clearly gradual exit,
- no ~1-second “switch on/off” feeling.

---

## 6. Suggested files to inspect / modify

Likely relevant:

- `module-03-runtime-scene-controller/src/controllers/EventController.ts`
- `module-03-runtime-scene-controller/src/controllers/AmbientController.ts`
- `module-03-runtime-scene-controller/src/controllers/TransitionController.ts`
- `packages/contracts/src/audio-library.ts`
- `packages/contracts/src/audio_library.json`
- `packages/adaptive-planner/src/semantic-materializer.ts` only if envelope values must be carried into the runtime plan
- `frontend/src/audio/GainManager.ts`
- existing tests

Prefer one shared resolver or a contract-level resolved envelope rather than duplicating logic in EventController and AmbientController.

Do not refactor unrelated audio code.

---

## 7. Latency / performance requirements

This change should use Web Audio gain automation / the existing transition controller.

It must **not materially increase adaptive-system latency**.

### Must remain unchanged
- LLM request count
- network traffic
- adaptation interval
- EEG analysis cadence
- scene-planning cadence

### Expected cost
Only lightweight local operations:
- resolve two envelope durations,
- schedule gain ramps,
- use existing source/loop playback.

### Do not
- schedule hundreds of JS timers to approximate fades,
- update gain with high-frequency React state,
- make a new planner call for gradual fades,
- load metadata over network during playback,
- reload/decode audio to perform a fade,
- create a new audio source every few milliseconds.

Prefer Web Audio parameter automation / existing `TransitionController` and `GainManager`.

---

## 8. Required acceptance tests

### A. Short event envelope
For a bird event:
- fade remains short,
- event remains audible,
- Step 1 motion-bound repeat behavior still works,
- no abrupt click/pop is introduced.

### B. Long environmental fade-in
For stream / waterfall / ocean-like bed:
- authored or resolved fade-in is several seconds where appropriate,
- gain rises gradually,
- it does not reach full gain after only ~0.75–1 second unless explicitly authored that way.

### C. Long environmental fade-out
When the same source is suppressed/replaced:
- gain decreases over the resolved fade duration,
- source is stopped/removed only after the fade completes or at the hard session boundary.

### D. Fade clamping
Given a lifecycle shorter than `fadeIn + fadeOut + plateau`:
- fades are reduced proportionally,
- no overlap/negative plateau bug,
- no NaN/negative timing.

### E. Replacement
For ambient foundation replacement:
- outgoing source fades out,
- incoming source fades in,
- existing scene-transition semantics remain unchanged.

Do not require perfect equal-power crossfade unless existing infrastructure already supports it.

### F. Regression
Verify:
- Step 1 event motion is unchanged,
- footsteps still function,
- long beds still loop,
- session ends on time,
- sources are cleaned up,
- no additional LLM/API call occurs.

---

## 9. Manual perceptual test

Use headphones / the existing spatial-audio test setup.

### Stream / waterfall / ocean

Before:
```text
silence → ENVIRONMENT ON
```

After:
```text
silence
→ faint
→ increasingly present
→ full environmental presence
```

On exit:

```text
full
→ moderate
→ distant
→ silence
```

The transition should feel like spatial arrival/departure, not UI toggling.

### Bird
The short event should still retain a crisp identity. Do not make the bird “fade in for 5 seconds.”

---

## 10. Implementation quality

Please:

1. inspect current metadata and controller paths first;
2. keep the patch localized;
3. use authored metadata as source of truth;
4. centralize fallback/clamping logic;
5. preserve Step 1 behavior;
6. run typecheck and relevant tests;
7. add tests for both short and long envelopes;
8. report every changed file.

At the end, provide:

- implementation summary,
- changed files,
- exact envelope-resolution rules,
- tests run and results,
- any assets whose metadata needed correction,
- confirmation that LLM/API request count and adaptation latency are unchanged.
