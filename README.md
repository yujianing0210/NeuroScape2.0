# NeuroScape

## Questionnaire study flow

The local study UI keeps Questionnaire v1.1 inside the participant flow. After calibration, hand the device to the participant for **Calibration Reflection** (C1–C3). Before each prescribed condition, the participant completes the neutral **Session 1/2** M1 screen; EEG timing and meditation audio begin only after that response is saved. At session end, core EEG/audio artifacts are uploaded before the participant completes M1 post, Q1–Q6, and the comfort check. The session receives `_COMPLETE.json` only after that questionnaire is saved.

After both counterbalanced conditions, the participant completes F1–F3 without seeing true condition labels. The handoff screen then tells them to return the device. The researcher can open the participant dashboard from that screen or Study Home. The dashboard maps Session 1/2 to Adaptive/Non-Adaptive, shows raw item values and transparent differences, and can be printed with **Print / Save PDF**.

Study progress reloads when a pseudonymous participant ID is entered. If saving fails, keep the questionnaire open and press **Submit** again; do not restart the meditation. Generated files are local:

Study Home recommends the counterbalanced order from the numeric participant ID: odd IDs use **A/B (Non-Adaptive → Adaptive)** and even IDs use **B/A (Adaptive → Non-Adaptive)**. An investigator may override this before Session 1 starts; the recommended order, actual order, and assignment source are saved in `participant-study.json`. The order is locked once a session starts.

```text
study-results/P007/
  participant-study.json
  questionnaire-long.csv
  participant-report.json
  eeg-comparison-long.csv
  session-.../
    manifest.json
    questionnaire.json
    questionnaire.csv
    eeg-epochs.csv
    ...
    _COMPLETE.json
```

Questionnaire answers are used only for persistence, reporting, and interview support. They are not passed to EEG interpretation, planning, or adaptive audio.

### Developer Quick Test Mode

Open **Developer / Testing** on Study Home and enable **Quick Test Mode**. It is OFF by default. In this mode, explicit skip buttons replace the five-minute calibration and ten-minute meditation waits, while C1–C3, M1, Q1–Q6, comfort, F1–F3, persistence, session finalization, and reports follow the normal study sequence. Each stage displays a developer quick summary for manual QA.

Quick Test records use `studyMode: "quick_test"`; questionnaire and EEG comparison CSV exports include `study_mode`, and each session contains `quick-test-metadata.json`. No synthetic physiological EEG values are created. Use dedicated pseudonymous IDs for testing: the app prevents production and Quick Test data from sharing the same participant record.

Individual session summaries and the participant report show Theta, Beta, and real-time log-TBR with the persisted calibration log-TBR baseline overlaid on the same track. The sound-exposure lanes and adaptive D1/D2 markers use the same fixed 0–10 minute axis. The participant report loads each session's saved recording and applies shared participant-level Y ranges across the two conditions; invalid EEG windows appear as gaps.

Module 01/02 Phase 1 development and test instructions: [docs/MODULE_01_02_PHASE1.md](docs/MODULE_01_02_PHASE1.md).

Audio-library items intentionally deferred for later asset curation are tracked in [docs/TBD_AUDIO_LIBRARY_GAPS.md](docs/TBD_AUDIO_LIBRARY_GAPS.md).

NeuroScape is a neuroadaptive spatial-audio meditation runtime. Modules 03 and 04 are implemented: semantic plans become authoritative numerical world snapshots in Module 03, then Module 04 validates, visualizes, spatializes, records, and replays those snapshots in the browser.

```text
Module 01 → NeuroState ┐
Module 02 → SceneJourneyPlan → Module 03 → RuntimeWorldState
                              └───────────────┬───────────────┘
                                              ↓
                               Module 04 Runtime Store
                         React + Three.js + Web Audio/HRTF
```

`RuntimeWorldState` is the only spatial source of truth. The browser never interprets EEG, executes planner reasoning, or simulates source movement.

## Quick start

```bash
npm install
npm run calibration:setup
npm run dev
```

Python 3.11+ is required for Muse calibration and live EEG. See
[Muse calibration and live adaptive integration](docs/EEG_CALIBRATION_LIVE_INTEGRATION.md)
for Mind Monitor setup, profile handoff, and the live 10-second epoch pipeline.
The existing mock modes remain available without EEG hardware.

Put `OPENAI_API_KEY` in a repository-root `.env` file (see `.env.example`). `npm run dev` loads it only in the localhost backend; the key is never bundled into Vite or sent to the browser.

Open the displayed Vite URL, enter a participant ID and duration, then select
**Start Muse calibration**. Development-only mock and diagnostic entry points
remain under the collapsed **Developer tools** section. Adaptive sessions
automatically save study artifacts under `study-results/` and also expose a ZIP
download on the Summary page.

## Set up on another computer

Install Git, Node.js 20.19+ (Node 22 LTS recommended), npm, and Python 3.11+.
Then run:

```bash
git clone -b feature/module-01-02-rebuild https://github.com/yujianing0210/NeuroScape2.0.git
cd NeuroScape2.0
npm install
npm run calibration:setup
cp .env.example .env
```

Edit `.env` and replace `your_openai_api_key_here` with a valid API key. Start
all three local services with:

```bash
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`).
For real EEG, connect the Mind Monitor phone and computer to a private Wi-Fi
that permits device-to-device UDP. In Mind Monitor, enable RAW EEG and OSC
streaming, then use the IPv4 address shown on the calibration page and UDP port
`5000`. macOS/Windows may ask for permission for Python to accept incoming
network traffic; allow it. Do not copy another researcher's `.env`, `.venv`,
`study-results`, or `eeg-calibration/data/sessions` directories.

## Validation

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

See [End-to-End Development Guide](docs/END_TO_END_DEVELOPMENT.md) for architecture, protocol, audio assets, demo operation, diagnostics, and upstream integration.

The source-of-truth specifications in `SystemDesign/` and legacy visual references in `UIreference/` are preserved unchanged.
