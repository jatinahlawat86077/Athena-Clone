const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helpers for reading and writing data
function readQuestions() {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) {
      fs.writeFileSync(QUESTIONS_FILE, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    const data = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading questions.json:', err);
    return [];
  }
}

function saveQuestions(questions) {
  const tempPath = `${QUESTIONS_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(questions, null, 2), 'utf-8');
  fs.renameSync(tempPath, QUESTIONS_FILE);
}

function readSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading sessions.json:', err);
    return [];
  }
}

function saveSessions(sessions) {
  const tempPath = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(sessions, null, 2), 'utf-8');
  fs.renameSync(tempPath, SESSIONS_FILE);
}

// Fisher-Yates shuffle
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ==========================================
// STUDENT ENDPOINTS
// ==========================================

/**
 * POST /exam/start
 * Requires non-empty userId and name.
 * Creates session with all question IDs shuffled, durationSeconds: 600, endsAt, and in-progress status.
 * Returns session ID, duration, and deadline.
 */
app.post('/exam/start', (req, res) => {
  const { userId, name } = req.body;

  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'Valid userId is required' });
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid name is required' });
  }

  const questions = readQuestions();
  if (questions.length === 0) {
    return res.status(500).json({ error: 'No questions available in the question bank' });
  }

  const allQuestionIds = questions.map((q) => q.id);
  const shuffledIds = shuffle(allQuestionIds);

  const durationSeconds = 600;
  const now = new Date();
  const endsAt = new Date(now.getTime() + durationSeconds * 1000).toISOString();
  const sessionId = `ses_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const newSession = {
    sessionId,
    userId: userId.trim(),
    name: name.trim(),
    startedAt: now.toISOString(),
    durationSeconds,
    endsAt,
    submittedAt: null,
    status: 'in-progress',
    attempted: 0,
    correct: 0,
    wrong: 0,
    answers: [],
    questionIds: shuffledIds,
    proctoringEvents: []
  };

  const sessions = readSessions();
  sessions.push(newSession);
  saveSessions(sessions);

  return res.status(201).json({
    sessionId,
    durationSeconds,
    endsAt
  });
});

/**
 * GET /exam/session/:sessionId/questions
 * Returns 404 for unknown session; otherwise returns only questions assigned
 * to that session, in the saved randomized order, without correctAnswer.
 */
app.get('/exam/session/:sessionId/questions', (req, res) => {
  const { sessionId } = req.params;
  const sessions = readSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const questions = readQuestions();
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  // Return questions in session.questionIds order, omitting correctAnswer
  const assignedQuestions = session.questionIds
    .map((id) => questionMap.get(id))
    .filter(Boolean)
    .map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options
    }));

  return res.json(assignedQuestions);
});

/**
 * GET /exam/mcq
 * Return all question-bank items in file order with only id, question, and options.
 */
app.get('/exam/mcq', (req, res) => {
  const questions = readQuestions();
  const publicQuestions = questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options
  }));
  return res.json(publicQuestions);
});

/**
 * GET /exam/mcq/:id
 * Return one question-bank item with only id, question, and options; :id returns 404 when absent.
 */
app.get('/exam/mcq/:id', (req, res) => {
  const id = Number(req.params.id);
  const questions = readQuestions();
  const question = questions.find((q) => q.id === id);

  if (!question) {
    return res.status(404).json({ error: 'Question not found' });
  }

  return res.json({
    id: question.id,
    question: question.question,
    options: question.options
  });
});

/**
 * POST /exam/answer
 * Requires session ID, assigned question ID, and valid selected option index.
 * Rejects non-active sessions, duplicate answers, unassigned questions, and expired attempts.
 * Updates attempted/correct/wrong on the server.
 * If an answer arrives after endsAt, immediately submits session, persists it, and returns 409.
 */
app.post('/exam/answer', (req, res) => {
  const { sessionId, questionId, selectedAnswer } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }

  const parsedQuestionId = Number(questionId);
  if (isNaN(parsedQuestionId)) {
    return res.status(400).json({ error: 'Valid questionId is required' });
  }

  const parsedSelectedAnswer = Number(selectedAnswer);
  if (
    selectedAnswer === undefined ||
    selectedAnswer === null ||
    isNaN(parsedSelectedAnswer) ||
    parsedSelectedAnswer < 0 ||
    parsedSelectedAnswer > 3 ||
    !Number.isInteger(parsedSelectedAnswer)
  ) {
    return res.status(400).json({ error: 'Selected answer must be an integer between 0 and 3' });
  }

  const sessions = readSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const now = new Date();
  const deadline = new Date(session.endsAt);

  // If already submitted
  if (session.status === 'submitted') {
    return res.status(400).json({
      error: 'Session has already been submitted',
      result: {
        attempted: session.attempted,
        correct: session.correct,
        wrong: session.wrong
      }
    });
  }

  // Check deadline expiration
  if (session.status !== 'in-progress' || now > deadline) {
    session.status = 'submitted';
    session.submittedAt = session.submittedAt || now.toISOString();
    saveSessions(sessions);

    return res.status(409).json({
      error: 'Time expired: session has been submitted',
      message: 'Assessment time limit has expired. Session automatically submitted.',
      result: {
        attempted: session.attempted,
        correct: session.correct,
        wrong: session.wrong
      }
    });
  }

  // Verify question is assigned to this session
  if (!session.questionIds.includes(parsedQuestionId)) {
    return res.status(400).json({ error: 'Question is not assigned to this session' });
  }

  // Verify not already answered (reject duplicate)
  const isDuplicate = session.answers.some((a) => a.questionId === parsedQuestionId);
  if (isDuplicate) {
    return res.status(400).json({ error: 'Question has already been answered' });
  }

  // Check correctness against question bank
  const questions = readQuestions();
  const question = questions.find((q) => q.id === parsedQuestionId);
  if (!question) {
    return res.status(404).json({ error: 'Question not found in question bank' });
  }

  const isCorrect = parsedSelectedAnswer === question.correctAnswer;

  session.answers.push({
    questionId: parsedQuestionId,
    selectedAnswer: parsedSelectedAnswer,
    isCorrect,
    answeredAt: now.toISOString()
  });

  // Server authorities scoring
  session.attempted = session.answers.length;
  session.correct = session.answers.filter((a) => a.isCorrect).length;
  session.wrong = session.answers.filter((a) => !a.isCorrect).length;

  saveSessions(sessions);

  return res.json({
    success: true,
    attempted: session.attempted,
    correct: session.correct,
    wrong: session.wrong
  });
});

/**
 * POST /exam/proctoring-event
 * Records only 'fullscreen-exit', 'focus-loss', 'camera-unavailable', or 'snapshot-failure',
 * and only for an active session.
 */
app.post('/exam/proctoring-event', (req, res) => {
  const { sessionId, type } = req.body;
  const allowedEvents = ['fullscreen-exit', 'focus-loss', 'camera-unavailable', 'snapshot-failure'];

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }

  if (!type || !allowedEvents.includes(type)) {
    return res.status(400).json({
      error: `Invalid event type. Allowed types: ${allowedEvents.join(', ')}`
    });
  }

  const sessions = readSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const now = new Date();
  const deadline = new Date(session.endsAt);

  if (session.status !== 'in-progress' || now > deadline) {
    return res.status(400).json({ error: 'Cannot record proctoring event: session is not active' });
  }

  session.proctoringEvents.push({
    type,
    occurredAt: now.toISOString()
  });

  saveSessions(sessions);

  return res.json({ success: true });
});

/**
 * GET /exam/session/:sessionId
 * Returns the stored session for that student flow, including answers and progress;
 * returns 404 when absent. Do not reuse for examiner review.
 * Does not trigger expiration.
 */
app.get('/exam/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sessions = readSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  return res.json(session);
});

/**
 * POST /exam/submit
 * Requires session ID, returns 404 when absent, submits an active session,
 * and returns { message, result: { attempted, correct, wrong } }.
 * Repeat submission returns that same saved result. Explicit submission is always
 * permitted and idempotent, even after deadline.
 */
app.post('/exam/submit', (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }

  const sessions = readSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.status !== 'submitted') {
    session.status = 'submitted';
    session.submittedAt = new Date().toISOString();
    saveSessions(sessions);
  }

  return res.json({
    message: 'Exam submitted successfully',
    result: {
      attempted: session.attempted,
      correct: session.correct,
      wrong: session.wrong
    }
  });
});

// ==========================================
// EXAMINER ENDPOINTS (AUTHENTICATED)
// ==========================================

// Examiner Authentication Middleware
function checkExaminerAuth(req, res, next) {
  const configuredPassword = process.env.EXAMINER_PASSWORD;

  if (!configuredPassword) {
    return res.status(503).json({ error: 'Examiner password not configured on server' });
  }

  const providedPassword = req.headers['x-examiner-password'];
  if (!providedPassword || providedPassword !== configuredPassword) {
    return res.status(401).json({ error: 'Unauthorized: Invalid examiner password' });
  }

  next();
}

/**
 * GET /examiner/sessions
 * Returns safe review data: identity, timing, result counts, status, event count, and events.
 * Never return answer selections or camera files.
 */
app.get('/examiner/sessions', checkExaminerAuth, (req, res) => {
  const sessions = readSessions();

  const safeSessions = sessions.map((s) => ({
    sessionId: s.sessionId,
    userId: s.userId,
    name: s.name,
    startedAt: s.startedAt,
    durationSeconds: s.durationSeconds,
    endsAt: s.endsAt,
    submittedAt: s.submittedAt,
    status: s.status,
    attempted: s.attempted,
    correct: s.correct,
    wrong: s.wrong,
    eventCount: (s.proctoringEvents || []).length,
    proctoringEvents: s.proctoringEvents || []
  }));

  return res.json(safeSessions);
});

/**
 * GET /examiner/questions
 * Returns full editable question bank, including correctAnswer, after authentication.
 */
app.get('/examiner/questions', checkExaminerAuth, (req, res) => {
  const questions = readQuestions();
  return res.json(questions);
});

/**
 * PUT /examiner/questions/:id
 * Requires non-empty question text, exactly four non-empty options, and correct-answer index 0-3.
 * Reject edits when the question is assigned to an active session.
 */
app.put('/examiner/questions/:id', checkExaminerAuth, (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Valid question ID is required' });
  }

  const { question, options, correctAnswer } = req.body;

  // Validation
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question text must be a non-empty string' });
  }

  if (!Array.isArray(options) || options.length !== 4) {
    return res.status(400).json({ error: 'Options must be an array of exactly 4 strings' });
  }

  const hasEmptyOption = options.some((opt) => !opt || typeof opt !== 'string' || !opt.trim());
  if (hasEmptyOption) {
    return res.status(400).json({ error: 'All 4 options must be non-empty strings' });
  }

  const parsedCorrectAnswer = Number(correctAnswer);
  if (
    correctAnswer === undefined ||
    correctAnswer === null ||
    isNaN(parsedCorrectAnswer) ||
    parsedCorrectAnswer < 0 ||
    parsedCorrectAnswer > 3 ||
    !Number.isInteger(parsedCorrectAnswer)
  ) {
    return res.status(400).json({ error: 'Correct answer index must be an integer between 0 and 3' });
  }

  const questions = readQuestions();
  const questionIndex = questions.findIndex((q) => q.id === id);

  if (questionIndex === -1) {
    return res.status(404).json({ error: 'Question not found' });
  }

  // Reject edits when question is assigned to an active session
  const sessions = readSessions();
  const now = new Date();
  const isAssignedToActive = sessions.some((s) => {
    const isActive = s.status === 'in-progress' && new Date(s.endsAt) > now;
    return isActive && Array.isArray(s.questionIds) && s.questionIds.includes(id);
  });

  if (isAssignedToActive) {
    return res.status(409).json({
      error: 'Cannot edit question: question is currently assigned to an active in-progress assessment session'
    });
  }

  // Apply updates
  questions[questionIndex] = {
    id,
    question: question.trim(),
    options: options.map((opt) => opt.trim()),
    correctAnswer: parsedCorrectAnswer
  };

  saveQuestions(questions);

  return res.json({
    success: true,
    question: questions[questionIndex]
  });
});

// Start listening if not running as a required module (e.g., during tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[ALSI Athena Backend] Listening on port ${PORT}`);
    console.log(`[ALSI Athena Backend] Data directory: ${DATA_DIR}`);
  });
}

module.exports = app;
