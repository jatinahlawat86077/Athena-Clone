# ALSI Athena — Product Constraints & System Specification

## 1. Product Philosophy & Proctoring Principles

ALSI Athena communicates **confident control and observability**, rather than treating recorded telemetry as proof of cheating.

### Key Tenets:
1. **Observations, Not Accusations:**
   The application observes window focus, fullscreen state, camera feed availability, and periodic snapshot continuity. These events are recorded as objective temporal occurrences (`proctoringEvents`), not automated cheating scores or penalties.
2. **Human Examiner Authority:**
   The system never flags, disqualifies, or terminates a student attempt automatically based on heuristic observations. The examiner console presents an auditable chronological timeline so human invigilators can evaluate context (e.g. temporary network flickers or accidental OS notifications).
3. **Calm, High-Contrast UI ("Lockdown Console"):**
   The interface uses a dark ink palette, electric blue for active verification, amber for time reminders and observations, and crimson strictly for critical deadline expirations or conflict warnings.

---

## 2. Security & Architectural Boundaries

### Server as Single Authority
- **Answer Scoring:** The student client never scores answers or receives `correctAnswer` in any request or payload. The Express server validates each option against `questions.json` and tallies `attempted`, `correct`, and `wrong`.
- **Deadline Enforcement:** Client clocks are not trusted. The server calculates `endsAt` at session creation (`now + durationSeconds`). If an answer payload arrives after `endsAt`, the server immediately finalizes the session, persists the result, and responds with `HTTP 409 Conflict`.
- **Active Session Lock:** The examiner question editor rejects modifications (`HTTP 409 Conflict`) to any question currently assigned to an active, in-progress session. This prevents race conditions and ensures scoring fairness.

### Privacy & Safe Data Boundaries
- **Examiner Session Schema:** The `GET /examiner/sessions` endpoint deliberately omits individual answer choices (`answers`) and camera image files. Examiners review aggregate outcomes and observation logs, maintaining candidate privacy.
- **Local Ephemeral Snapshots:** Camera snapshots requested every 5 seconds are saved directly to `app/user-camera-snap/<timestamp>.jpg` on the host machine. They have no public HTTP retrieval endpoints.

---

## 3. Explicit Non-Goals

To maintain simplicity, high reliability, and focus on classroom pedagogy:
- **No Cloud Database:** Flat JSON storage (`questions.json`, `sessions.json`) is the intentional, transparent persistence mechanism.
- **No Third-Party Auth / OAuth:** Examiner authentication utilizes the server's `EXAMINER_PASSWORD` environment variable without external identity providers or JWT tokens.
- **No Automated Invigilation Decisions:** No algorithmic cheating scores, biometric facial analysis, or AI cheating classification.
- **No Multi-Tenant Examiner Synchronization:** Designed for a single invigilator station presiding over a local classroom.
- **No Question Versioning Engine:** In this teaching application, question editing modifies the question bank in-place, protected by active-session locks.
