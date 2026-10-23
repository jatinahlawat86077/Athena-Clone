# Athena Cloe — Classroom-Scale Secure Assessment Platform

**Athena Cloe** is a secure assessment platform designed for local classroom evaluation. It provides two Electron experiences backed by a single local Express API:

1. **Student Assessment Kiosk:** A fullscreen, timed multiple-choice exam with camera/fullscreen readiness gates, keyboard navigation, and real-time observability telemetry.
2. **Examiner Console:** A password-protected administrative interface for reviewing student attempts, auditing observational signals, and managing the question bank.

---

## Architecture Overview

```text
alsiAthena/
├── package.json                 # Root launch scripts and npm workspaces
├── README.md                    # Setup and run guide
├── PRODUCT.md                   # Product constraints and invigilation philosophy
├── backend/
│   ├── server.js                # Express API (Scoring authority, proctoring, examiner routes)
│   └── data/
│       ├── questions.json       # Question bank persistence
│       └── sessions.json        # Assessment sessions persistence
└── proctoring-tool/
    ├── app/
    │   ├── app.js               # Electron main process (Kiosk & Admin modes, 1s/5s intervals)
    │   └── preload.js           # Narrow renderer IPC bridge (contextBridge)
    └── src/
        ├── App.jsx              # Unified React application (Student + Examiner flows)
        └── App.css              # "Lockdown Console" design system
```

---

## Quick Start & Run Commands

Ensure **Node.js (v18+)** and **npm** are installed.

### 1. Installation

Run this once at the project root to install dependencies across all workspaces:

```bash
npm install
```

### 2. Launch Student Kiosk Mode

Starts the Express backend on port `3000`, launches the Vite development server on port `5173`, waits for Vite to become ready, and opens the fullscreen kiosk Electron window:

```bash
npm run student
```

- Window size: `1000×1000`, fullscreen and kiosk mode enabled.
- Requires candidate name, optical camera check, and document fullscreen verification before starting.
- Automatically closes the student window when the student clicks **Close quiz** after submission.

### 3. Launch Examiner Admin Console

Prompts for the `EXAMINER_PASSWORD` interactively in your terminal, starts the backend and Vite services, and opens the window in normal mode:

```bash
npm run admin
```

- Window size: approximately `1100×900`, standard window mode.
- Direct URL hash: `http://localhost:5173/#examiner`.
- Access requires entering the examiner password matching the server's `EXAMINER_PASSWORD` environment variable.

### Automatic Child Process Cleanup

When either Electron window is closed, the root launcher cleanly stops all spawned background Vite and Express backend processes (`SIGTERM`/cleanup hooks).

---

## Backend API Contract

The Express server runs on port `3000` with CORS and JSON body parsing.

### Student Endpoints (Unauthenticated)

| Method & Path | Description |
| --- | --- |
| `POST /exam/start` | Creates a new session with shuffled question IDs, `durationSeconds: 600`, and calculated `endsAt`. |
| `GET /exam/session/:sessionId/questions` | Returns assigned questions in session's randomized order **without `correctAnswer`**. |
| `GET /exam/mcq` & `GET /exam/mcq/:id` | Returns public question bank items without `correctAnswer`. |
| `POST /exam/answer` | Evaluates and stores an answer. Server acts as authority for scoring and deadline enforcement. Rejects duplicates, unassigned questions, and expired attempts (returns `409` on deadline expiration). |
| `POST /exam/proctoring-event` | Records observations: `fullscreen-exit`, `focus-loss`, `camera-unavailable`, or `snapshot-failure`. |
| `GET /exam/session/:sessionId` | Retrieves stored student session state. |
| `POST /exam/submit` | Finalizes session and returns `{ message, result: { attempted, correct, wrong } }`. Idempotent for repeat submissions. |

### Examiner Endpoints (Authenticated via `x-examiner-password`)

| Method & Path | Description |
| --- | --- |
| `GET /examiner/sessions` | Returns safe audit data (identity, scores, timestamps, event log). **Never exposes answer selections or camera files.** |
| `GET /examiner/questions` | Returns full editable question bank, including `correctAnswer`. |
| `PUT /examiner/questions/:id` | Updates question text, 4 options, and correct answer index. **Returns `409 Conflict` if the question is currently assigned to an active exam.** |

---

## Security Model & Known Scope Limitations

1. **Classroom Demo Environment:** Athena Cloe is engineered for local classroom environments and proctored computer labs.
2. **Persistence Layer:** Flat JSON files (`questions.json`, `sessions.json`) are intentionally used as the lightweight storage layer.
3. **No Automatic Penalties:** Observational signals (focus loss, fullscreen exit) support human examiner review and are **never** treated as automated proof of cheating.
4. **Shared Password:** Examiner access uses a shared administrative password provided via environment variable; it is not a multi-tenant identity provider.
