const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.EXAMINER_PASSWORD = 'test-secret-password-123';
process.env.PORT = '3001';

const app = require('../backend/server.js');
let server;

function request(method, pathName, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path: pathName,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runComprehensiveTests() {
  console.log('====================================================');
  console.log('🚀 ALSI ATHENA — BACKEND ACCEPTANCE CHECKS SUITE');
  console.log('====================================================');

  server = app.listen(3001);
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    // -------------------------------------------------------------
    // Check 1: Examiner Authentication & Authorization
    // -------------------------------------------------------------
    console.log('[Check 1] Examiner Authentication (401, 503, 200)...');
    
    // Missing header
    const noAuth = await request('GET', '/examiner/sessions');
    assert.strictEqual(noAuth.status, 401, 'Missing password header must return 401');

    // Wrong password header
    const wrongAuth = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'invalid-password'
    });
    assert.strictEqual(wrongAuth.status, 401, 'Invalid password header must return 401');

    // Valid password
    const validAuth = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(validAuth.status, 200, 'Valid password header must return 200');
    assert(Array.isArray(validAuth.body), 'Sessions must be returned as array');

    // Test 503 when EXAMINER_PASSWORD is unset
    const savedPassword = process.env.EXAMINER_PASSWORD;
    delete process.env.EXAMINER_PASSWORD;
    const unconfiguredAuth = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(unconfiguredAuth.status, 503, 'Unconfigured password must return 503');
    process.env.EXAMINER_PASSWORD = savedPassword; // Restore

    // -------------------------------------------------------------
    // Check 2: Session Creation & Question Randomization
    // -------------------------------------------------------------
    console.log('[Check 2] Session Creation & Question Randomization...');
    const s1 = await request('POST', '/exam/start', {}, { userId: 'STU-001', name: 'Student One' });
    assert.strictEqual(s1.status, 201);
    assert(s1.body.sessionId);
    assert.strictEqual(s1.body.durationSeconds, 600);
    assert(s1.body.endsAt);

    const s2 = await request('POST', '/exam/start', {}, { userId: 'STU-002', name: 'Student Two' });
    assert.strictEqual(s2.status, 201);

    // Fetch questions for both sessions
    const s1Questions = await request('GET', `/exam/session/${s1.body.sessionId}/questions`);
    const s2Questions = await request('GET', `/exam/session/${s2.body.sessionId}/questions`);
    assert.strictEqual(s1Questions.status, 200);
    assert.strictEqual(s2Questions.status, 200);

    // Verify stable per-session order
    const s1QuestionsRepeat = await request('GET', `/exam/session/${s1.body.sessionId}/questions`);
    assert.deepStrictEqual(
      s1Questions.body.map((q) => q.id),
      s1QuestionsRepeat.body.map((q) => q.id),
      'Question order must be stable per session'
    );

    // -------------------------------------------------------------
    // Check 3: Student Question Responses Omit correctAnswer; Examiner Includes It
    // -------------------------------------------------------------
    console.log('[Check 3] Question Privacy: Student vs Examiner payloads...');
    for (const q of s1Questions.body) {
      assert.strictEqual(q.correctAnswer, undefined, 'Student payload MUST NOT contain correctAnswer');
      assert.strictEqual(typeof q.id, 'number');
      assert.strictEqual(typeof q.question, 'string');
      assert(Array.isArray(q.options) && q.options.length === 4);
    }

    const exQuestions = await request('GET', '/examiner/questions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(exQuestions.status, 200);
    for (const q of exQuestions.body) {
      assert(
        typeof q.correctAnswer === 'number' && q.correctAnswer >= 0 && q.correctAnswer <= 3,
        'Examiner payload MUST include correctAnswer (0-3)'
      );
    }

    // Public MCQ endpoints also omit correctAnswer
    const publicAll = await request('GET', '/exam/mcq');
    assert.strictEqual(publicAll.status, 200);
    assert.strictEqual(publicAll.body[0].correctAnswer, undefined);

    const publicSingle = await request('GET', `/exam/mcq/${publicAll.body[0].id}`);
    assert.strictEqual(publicSingle.status, 200);
    assert.strictEqual(publicSingle.body.correctAnswer, undefined);

    // -------------------------------------------------------------
    // Check 4: Answer Validation, Scoring & Expiration (409)
    // -------------------------------------------------------------
    console.log('[Check 4] Answer Validation, Scoring & Expiration...');
    const qTarget = s1Questions.body[0];
    const targetBankQ = exQuestions.body.find((q) => q.id === qTarget.id);

    // 1. Submit correct answer
    const ansCorrect = await request('POST', '/exam/answer', {}, {
      sessionId: s1.body.sessionId,
      questionId: qTarget.id,
      selectedAnswer: targetBankQ.correctAnswer
    });
    assert.strictEqual(ansCorrect.status, 200);
    assert.strictEqual(ansCorrect.body.attempted, 1);
    assert.strictEqual(ansCorrect.body.correct, 1);
    assert.strictEqual(ansCorrect.body.wrong, 0);

    // 2. Reject duplicate answer
    const ansDup = await request('POST', '/exam/answer', {}, {
      sessionId: s1.body.sessionId,
      questionId: qTarget.id,
      selectedAnswer: targetBankQ.correctAnswer
    });
    assert.strictEqual(ansDup.status, 400, 'Duplicate answer must return 400');

    // 3. Reject unassigned question
    const ansUnassigned = await request('POST', '/exam/answer', {}, {
      sessionId: s1.body.sessionId,
      questionId: 999999,
      selectedAnswer: 0
    });
    assert.strictEqual(ansUnassigned.status, 400, 'Unassigned question must return 400');

    // 4. Reject out of bounds option index
    const ansOOB = await request('POST', '/exam/answer', {}, {
      sessionId: s1.body.sessionId,
      questionId: s1Questions.body[1].id,
      selectedAnswer: 4
    });
    assert.strictEqual(ansOOB.status, 400, 'Option index > 3 must return 400');

    // 5. Submit incorrect answer
    const wrongOpt = (exQuestions.body.find((q) => q.id === s1Questions.body[1].id).correctAnswer + 1) % 4;
    const ansWrong = await request('POST', '/exam/answer', {}, {
      sessionId: s1.body.sessionId,
      questionId: s1Questions.body[1].id,
      selectedAnswer: wrongOpt
    });
    assert.strictEqual(ansWrong.status, 200);
    assert.strictEqual(ansWrong.body.attempted, 2);
    assert.strictEqual(ansWrong.body.correct, 1);
    assert.strictEqual(ansWrong.body.wrong, 1);

    // 6. Test Deadline Expiration -> 409
    console.log('   Testing Deadline Expiration on answer payload...');
    // Create an expired session directly in sessions.json
    const sessionsPath = path.join(__dirname, '..', 'backend', 'data', 'sessions.json');
    const diskSessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    const expiredSessionId = 'expired_ses_test_123';
    diskSessions.push({
      sessionId: expiredSessionId,
      userId: 'STU-EXPIRED',
      name: 'Expired Student',
      startedAt: new Date(Date.now() - 700000).toISOString(),
      durationSeconds: 600,
      endsAt: new Date(Date.now() - 100000).toISOString(), // expired 100s ago
      submittedAt: null,
      status: 'in-progress',
      attempted: 0,
      correct: 0,
      wrong: 0,
      answers: [],
      questionIds: [1, 2, 3],
      proctoringEvents: []
    });
    fs.writeFileSync(sessionsPath, JSON.stringify(diskSessions, null, 2));

    const expiredAnsRes = await request('POST', '/exam/answer', {}, {
      sessionId: expiredSessionId,
      questionId: 1,
      selectedAnswer: 0
    });
    assert.strictEqual(expiredAnsRes.status, 409, 'Expired answer must return 409 Conflict');
    assert(expiredAnsRes.body.result, 'Expired response must include final saved result');
    assert.strictEqual(expiredAnsRes.body.result.attempted, 0);

    // Verify session is now marked submitted on disk
    const updatedSessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    const expiredCheck = updatedSessions.find((s) => s.sessionId === expiredSessionId);
    assert.strictEqual(expiredCheck.status, 'submitted');
    assert(expiredCheck.submittedAt);

    // Subsequent answers to that submitted session are rejected
    const postExpiredAns = await request('POST', '/exam/answer', {}, {
      sessionId: expiredSessionId,
      questionId: 2,
      selectedAnswer: 0
    });
    assert.strictEqual(postExpiredAns.status, 400, 'Answer to submitted session must return 400');

    // -------------------------------------------------------------
    // Check 5: Proctoring Telemetry
    // -------------------------------------------------------------
    console.log('[Check 5] Proctoring Telemetry Events...');
    const allowedTypes = ['fullscreen-exit', 'focus-loss', 'camera-unavailable', 'snapshot-failure'];

    for (const evtType of allowedTypes) {
      const evtRes = await request('POST', '/exam/proctoring-event', {}, {
        sessionId: s1.body.sessionId,
        type: evtType
      });
      assert.strictEqual(evtRes.status, 200, `Allowed event '${evtType}' must return 200`);
    }

    // Disallowed event type
    const badEvt = await request('POST', '/exam/proctoring-event', {}, {
      sessionId: s1.body.sessionId,
      type: 'user-cheated'
    });
    assert.strictEqual(badEvt.status, 400, 'Disallowed event type must return 400');

    // Event on expired/submitted session
    const evtOnExpired = await request('POST', '/exam/proctoring-event', {}, {
      sessionId: expiredSessionId,
      type: 'focus-loss'
    });
    assert.strictEqual(evtOnExpired.status, 400, 'Event on non-active session must return 400');

    // -------------------------------------------------------------
    // Check 6: Active Session Question Edit Lock (409 Conflict)
    // -------------------------------------------------------------
    console.log('[Check 6] Active-Session Question Edit Lock (409 Conflict)...');
    // Session s1 is active and has assigned questions
    const assignedQId = s1Questions.body[0].id;
    const editLockRes = await request(
      'PUT',
      `/examiner/questions/${assignedQId}`,
      { 'x-examiner-password': 'test-secret-password-123' },
      {
        question: 'Should be rejected because session s1 is active',
        options: ['Opt 1', 'Opt 2', 'Opt 3', 'Opt 4'],
        correctAnswer: 0
      }
    );
    assert.strictEqual(editLockRes.status, 409, 'Editing question in active session must return 409');

    // -------------------------------------------------------------
    // Check 7: Submission & Idempotency
    // -------------------------------------------------------------
    console.log('[Check 7] Exam Submission & Idempotency...');
    const submitRes = await request('POST', '/exam/submit', {}, {
      sessionId: s1.body.sessionId
    });
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitRes.body.result.attempted, 2);
    assert.strictEqual(submitRes.body.result.correct, 1);
    assert.strictEqual(submitRes.body.result.wrong, 1);

    // Repeat submit returns identical result
    const repeatRes = await request('POST', '/exam/submit', {}, {
      sessionId: s1.body.sessionId
    });
    assert.strictEqual(repeatRes.status, 200);
    assert.deepStrictEqual(repeatRes.body.result, submitRes.body.result);

    // -------------------------------------------------------------
    // Check 8: Safe Examiner Session Review Schema
    // -------------------------------------------------------------
    console.log('[Check 8] Safe Examiner Review Data Schema...');
    const safeReviewRes = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(safeReviewRes.status, 200);
    const auditedS1 = safeReviewRes.body.find((s) => s.sessionId === s1.body.sessionId);
    assert(auditedS1);
    assert.strictEqual(auditedS1.answers, undefined, 'Examiner review schema MUST NEVER include answers');
    assert.strictEqual(auditedS1.eventCount, 4);
    assert.strictEqual(auditedS1.proctoringEvents.length, 4);

    console.log('====================================================');
    console.log('🎉 ALL 8 BACKEND ACCEPTANCE CHECKS PASSED PERFECTLY!');
    console.log('====================================================');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runComprehensiveTests().catch((err) => {
  console.error('\n❌ Acceptance Check Failure:', err);
  process.exit(1);
});
