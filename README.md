# NeuroScape 2.0

NeuroScape is a local-first research prototype for EEG-informed, spatial-audio
meditation. It combines Muse / Mind Monitor calibration, a constrained adaptive
planner, an authoritative scene runtime, Web Audio spatialization, study
questionnaires, and reproducible session artifacts in one application.

> NeuroScape is a research tool, not a medical device. EEG-derived values are
> participant-specific operational signals and must not be interpreted as
> diagnoses or objective psychological labels.

## Current study flow

The participant-facing workflow uses Questionnaire 2.0 and two counterbalanced
conditions:

1. Enter a pseudonymous participant ID and confirm the condition order.
2. Complete Muse calibration and the C1-C3 calibration reflection.
3. Complete the M1 pre-session item, then run Session 1.
4. Complete M1 post, Q1-Q6, and the comfort check.
5. Repeat the pre/session/post flow for Session 2.
6. Complete F1-F3, return the device to the researcher, and review or print the
   participant report.

Odd numeric participant IDs default to **A/B (Non-Adaptive -> Adaptive)**;
even IDs default to **B/A (Adaptive -> Non-Adaptive)**. An investigator may
override the recommendation before Session 1 begins. The chosen order is locked
after a session starts and is persisted in `participant-study.json`.

Questionnaire responses are used only for persistence, reporting, and interview
support. They are never sent to EEG interpretation, planning, or adaptive audio.

### Developer Quick Test Mode

Open **Developer / Testing** on Study Home to enable Quick Test Mode. It is off
by default. Explicit skip controls replace the five-minute calibration and
ten-minute session waits, while questionnaires, persistence, finalization, and
reports follow the production sequence.

Quick Test records use `studyMode: "quick_test"` and must use dedicated test
participant IDs. The application prevents Quick Test and production data from
sharing one participant record. Quick Test does not synthesize physiological
EEG values.

## What is in this version

- Live Muse OSC intake, calibration, quality review, and 10-second log-TBR
  epochs.
- Adaptive and fixed non-adaptive ten-minute study conditions.
- Deterministic, constrained plan generation with separate Decision 1 and
  Decision 2 stages.
- Authoritative `RuntimeWorldState` snapshots shared by Three.js and Web Audio.
- Asset-authored event motion, deterministic local motion, motion-bound
  lifecycles, and burst playback distributed across the event lifecycle.
- Asset-aware ambient and event envelopes with safe handling for short sounds,
  replacement, and removal.
- Local recording, replay, participant comparison, EEG / TBR timelines, sound
  exposure lanes, and printable reports.
- Offline mock and deterministic replay paths for development without EEG
  hardware.

`RuntimeWorldState` is the only spatial source of truth. The browser does not
reinterpret EEG, run planner reasoning, or independently simulate source
movement.

```text
Muse / Mind Monitor
        |
        v
Module 01: calibration + NeuroState
        |
        v
Module 02: constrained adaptive planner -> SceneJourneyPlan
        |
        v
Module 03: runtime scene controller -> RuntimeWorldState
        |
        v
Module 04: React + Three.js + Web Audio / HRTF
        |
        v
Study recorder, replay, comparison, and reports
```

## Requirements

- Git
- Node.js `20.19+` (Node 22 LTS recommended) and npm
- Python `3.11+` for calibration and live EEG
- Muse 2 with Mind Monitor for real EEG sessions (optional for mock development)
- An OpenAI API key for the live adaptive planner (optional for offline mock)

## Install

```bash
git clone -b main https://github.com/yujianing0210/NeuroScape2.0.git
cd NeuroScape2.0
npm install
npm run calibration:setup
```

Create the local environment file:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Add `OPENAI_API_KEY` to `.env` for live planning. The key is loaded only by the
localhost study-recorder / planner service; it is not bundled into Vite or sent
to the browser.

If Python is installed under a nonstandard executable name, set
`NEUROSCAPE_PYTHON` before running `npm run calibration:setup`.

## Run

```bash
npm run dev
```

This starts:

- Muse calibration and OSC service: `http://127.0.0.1:8000`
- Mind Monitor OSC listener: UDP `5000`
- Study recorder and OpenAI proxy: `http://127.0.0.1:8787`
- Vite frontend: normally `http://localhost:5173`

For real EEG, connect the Mind Monitor phone and computer to a private network
that permits device-to-device UDP. Enable raw EEG and OSC streaming in Mind
Monitor, then use the IPv4 address displayed by the calibration page and port
`5000`. Allow Python to receive local network traffic if the operating system
prompts for permission.

See [Muse calibration and live adaptive integration](docs/EEG_CALIBRATION_LIVE_INTEGRATION.md)
for the calibration protocol, profile acceptance policy, and live epoch path.

## Local data and privacy

Study data is intentionally stored locally and excluded from Git:

```text
eeg-calibration/data/sessions/<calibration-id>/
study-results/<participant-id>/
  participant-study.json
  questionnaire-long.csv
  participant-report.json
  eeg-comparison-long.csv
  session-.../
    manifest.json
    questionnaire.json
    questionnaire.csv
    eeg-epochs.csv
    quick-test-metadata.json   # Quick Test only
    _COMPLETE.json
```

Use pseudonymous participant IDs. Do not copy another researcher's `.env`,
`.venv`, `study-results`, `eeg-calibration/data/sessions`, or generated
participant PDF reports into a shared repository.

A session receives `_COMPLETE.json` only after its required artifacts and
questionnaire have been saved. If a questionnaire save fails, keep the page open
and submit again; do not restart the meditation.

## Repository structure

| Path | Responsibility |
| --- | --- |
| `eeg-calibration/` | Muse OSC intake, calibration protocol, signal processing, and profile persistence |
| `packages/contracts/` | Shared plans, runtime states, recordings, and canonical audio metadata |
| `packages/adaptive-planner/` | NeuroState interpretation, base plans, constrained decisions, patching, and semantic materialization |
| `module-03-runtime-scene-controller/` | Numerical scene state, lifecycle, trajectories, gains, and validation |
| `frontend/` | Study UI, Three.js, Web Audio / HRTF, recording, replay, and reporting |
| `study-recorder-server/` | Local artifact storage and OpenAI proxy |
| `study-control/` | Approved non-adaptive control trajectory and manifest |
| `data/mock/` | Explicit development-only calibration and raw EEG fixtures |
| `docs/` | Architecture, implementation notes, and operator guidance |
| `SystemDesignMarkdown/` | Source system-design specifications |
| `UI1.0reference/` | Legacy UI reference material |

## Validation

Run the complete project checks before a study build:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

The main end-to-end and operator references are:

- [End-to-End Development Guide](docs/END_TO_END_DEVELOPMENT.md)
- [Module 01/02 Phase 1](docs/MODULE_01_02_PHASE1.md)
- [EEG Calibration and Live Integration](docs/EEG_CALIBRATION_LIVE_INTEGRATION.md)
- [Audio Library Gaps](docs/TBD_AUDIO_LIBRARY_GAPS.md)
- [Motion-Bound Event Playback](docs/NeuroScape_Codex_Instruction_Step1_Motion_Bound_Event_Playback.md)
- [Asset-Aware Fades](docs/NeuroScape_Codex_Instruction_Step2_Asset_Aware_Fades.md)
