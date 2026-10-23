const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Set test environment
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

async function runTests() {
  console.log('--- Starting Backend Verification Tests ---');

  // Start server on 3001
  server = app.listen(3001);
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    // 1. Examiner Auth Tests
    console.log('[1/7] Testing Examiner Authentication...');
    const noAuth = await request('GET', '/examiner/sessions');
    assert.strictEqual(noAuth.status, 401, 'Should reject unauthenticated examiner request with 401');

    const wrongAuth = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'wrong-password'
    });
    assert.strictEqual(wrongAuth.status, 401, 'Should reject wrong password with 401');

    const goodAuth = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(goodAuth.status, 200, 'Should accept valid examiner password with 200');
    assert(Array.isArray(goodAuth.body), 'Examiner sessions should be an array');

    // 2. Start two sessions & verify question randomization and omission of correctAnswer
    console.log('[2/7] Testing Session Start & Question Randomization...');
    const ses1Res = await request('POST', '/exam/start', {}, { userId: 'student_1', name: 'Alice Smith' });
    assert.strictEqual(ses1Res.status, 201, 'Start session 1 should succeed');
    const ses1Id = ses1Res.body.sessionId;
    assert(ses1Res.body.endsAt, 'Session should have endsAt');

    const ses2Res = await request('POST', '/exam/start', {}, { userId: 'student_2', name: 'Bob Jones' });
    assert.strictEqual(ses2Res.status, 201, 'Start session 2 should succeed');
    const ses2Id = ses2Res.body.sessionId;

    const q1Res = await request('GET', `/exam/session/${ses1Id}/questions`);
    assert.strictEqual(q1Res.status, 200);
    const q2Res = await request('GET', `/exam/session/${ses2Id}/questions`);
    assert.strictEqual(q2Res.status, 200);

    // Verify correctAnswer is omitted
    for (const q of q1Res.body) {
      assert.strictEqual(q.correctAnswer, undefined, 'Student questions MUST NOT include correctAnswer');
      assert(q.id && q.question && Array.isArray(q.options) && q.options.length === 4);
    }

    // Verify stable per-session order
    const q1ResRepeat = await request('GET', `/exam/session/${ses1Id}/questions`);
    const q1Ids = q1Res.body.map((q) => q.id);
    const q1RepeatIds = q1ResRepeat.body.map((q) => q.id);
    assert.deepStrictEqual(q1Ids, q1RepeatIds, 'Questions order must be stable per session');

    // Verify examiner questions include correctAnswer
    const exQuestionsRes = await request('GET', '/examiner/questions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(exQuestionsRes.status, 200);
    for (const q of exQuestionsRes.body) {
      assert(typeof q.correctAnswer === 'number', 'Examiner questions MUST include correctAnswer');
    }

    // 3. Testing Answer submission & scoring
    console.log('[3/7] Testing Answer Scoring & Validation...');
    const firstQ = q1Res.body[0];
    const exQ = exQuestionsRes.body.find((q) => q.id === firstQ.id);

    // Submit correct answer
    const ans1Res = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: firstQ.id,
      selectedAnswer: exQ.correctAnswer
    });
    assert.strictEqual(ans1Res.status, 200);
    assert.strictEqual(ans1Res.body.attempted, 1);
    assert.strictEqual(ans1Res.body.correct, 1);
    assert.strictEqual(ans1Res.body.wrong, 0);

    // Reject duplicate answer
    const dupRes = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: firstQ.id,
      selectedAnswer: exQ.correctAnswer
    });
    assert.strictEqual(dupRes.status, 400, 'Duplicate answer must be rejected with 400');

    // Reject unassigned question
    const unassignedRes = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: 99999,
      selectedAnswer: 0
    });
    assert.strictEqual(unassignedRes.status, 400, 'Unassigned question must be rejected with 400');

    // Reject invalid option index
    const secondQ = q1Res.body[1];
    const invalidOptRes = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: secondQ.id,
      selectedAnswer: 5
    });
    assert.strictEqual(invalidOptRes.status, 400, 'Option index > 3 must be rejected with 400');

    // Submit wrong answer
    const wrongOpt = (exQuestionsRes.body.find((q) => q.id === secondQ.id).correctAnswer + 1) % 4;
    const ans2Res = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: secondQ.id,
      selectedAnswer: wrongOpt
    });
    assert.strictEqual(ans2Res.status, 200);
    assert.strictEqual(ans2Res.body.attempted, 2);
    assert.strictEqual(ans2Res.body.correct, 1);
    assert.strictEqual(ans2Res.body.wrong, 1);

    // 4. Testing Proctoring Events
    console.log('[4/7] Testing Proctoring Events...');
    const evt1 = await request('POST', '/exam/proctoring-event', {}, {
      sessionId: ses1Id,
      type: 'focus-loss'
    });
    assert.strictEqual(evt1.status, 200);

    const evt2 = await request('POST', '/exam/proctoring-event', {}, {
      sessionId: ses1Id,
      type: 'fullscreen-exit'
    });
    assert.strictEqual(evt2.status, 200);

    const invalidEvt = await request('POST', '/exam/proctoring-event', {}, {
      sessionId: ses1Id,
      type: 'suspicious-action'
    });
    assert.strictEqual(invalidEvt.status, 400, 'Invalid proctoring event type must be rejected with 400');

    // 5. Active Session Question Edit Protection
    console.log('[5/7] Testing Active Session Question Edit Protection (409 Conflict)...');
    const editActiveRes = await request(
      'PUT',
      `/examiner/questions/${firstQ.id}`,
      { 'x-examiner-password': 'test-secret-password-123' },
      {
        question: 'Updated text?',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: 0
      }
    );
    assert.strictEqual(editActiveRes.status, 409, 'Editing question in active session must return 409 Conflict');

    // 6. Submit exam and repeat submit (idempotency)
    console.log('[6/7] Testing Exam Submission & Idempotency...');
    const submitRes = await request('POST', '/exam/submit', {}, { sessionId: ses1Id });
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitRes.body.result.attempted, 2);
    assert.strictEqual(submitRes.body.result.correct, 1);
    assert.strictEqual(submitRes.body.result.wrong, 1);

    // Repeat submit
    const repeatSubmit = await request('POST', '/exam/submit', {}, { sessionId: ses1Id });
    assert.strictEqual(repeatSubmit.status, 200);
    assert.deepStrictEqual(repeatSubmit.body.result, submitRes.body.result, 'Repeat submit returns saved result');

    // Answer after submit is rejected
    const thirdQ = q1Res.body[2];
    const postSubmitAns = await request('POST', '/exam/answer', {}, {
      sessionId: ses1Id,
      questionId: thirdQ.id,
      selectedAnswer: 0
    });
    assert.strictEqual(postSubmitAns.status, 400, 'Answer after submit must be rejected');

    // 7. Verify Safe Examiner Review Schema
    console.log('[7/7] Testing Safe Examiner Review Data Schema...');
    const exSessionsRes = await request('GET', '/examiner/sessions', {
      'x-examiner-password': 'test-secret-password-123'
    });
    assert.strictEqual(exSessionsRes.status, 200);
    const session1InReview = exSessionsRes.body.find((s) => s.sessionId === ses1Id);
    assert(session1InReview, 'Session 1 must be present in examiner list');
    assert.strictEqual(session1InReview.answers, undefined, 'Examiner review MUST NEVER return answer selections');
    assert.strictEqual(session1InReview.eventCount, 2, 'Event count should match recorded events');
    assert.strictEqual(session1InReview.proctoringEvents.length, 2);

    console.log('✅ ALL BACKEND CONTRACT AND ACCEPTANCE TESTS PASSED!');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
