import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield,
  Lock,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Camera,
  Maximize,
  Clock,
  ArrowRight,
  LogOut,
  RefreshCw,
  FileText,
  Users,
  Activity,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Check,
  Eye,
  X
} from 'lucide-react';
import './App.css';

const API_BASE = 'http://localhost:3000';

export default function App() {
  const [route, setRoute] = useState(window.location.hash === '#examiner' ? 'examiner' : 'student');

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(window.location.hash === '#examiner' ? 'examiner' : 'student');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <div className="app-container">
      {route === 'examiner' ? <ExaminerConsole /> : <StudentApp />}
    </div>
  );
}

/* ==========================================================================
   STUDENT COMPONENT
   ========================================================================== */

function StudentApp() {
  const [stage, setStage] = useState('readiness'); // 'readiness' | 'exam' | 'completed'

  // Readiness state
  const [userId, setUserId] = useState(() => `STU-${Math.floor(1000 + Math.random() * 9000)}`);
  const [name, setName] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(Boolean(document.fullscreenElement));
  const [readinessError, setReadinessError] = useState('');
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  // Exam state
  const [session, setSession] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(600);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [showConfirmEnd, setShowConfirmEnd] = useState(false);
  const [examError, setExamError] = useState('');

  // Completed state
  const [result, setResult] = useState(null);

  // Snapshot canvas ref
  const canvasRef = useRef(document.createElement('canvas'));

  // --------------------------------------------------------------------------
  // Camera & Fullscreen readiness listeners
  // --------------------------------------------------------------------------

  const startCamera = useCallback(async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraReady(true);
      setReadinessError('');

      // Listen for camera disconnect
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.onended = () => {
          setCameraReady(false);
          reportProctoringEvent('camera-unavailable');
        };
      }
    } catch (err) {
      console.warn('Camera access denied or unavailable:', err);
      setCameraReady(false);
      setReadinessError('Camera permission required. Please allow camera access.');
    }
  }, []);

  const requestFullscreenMode = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request failed:', err);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = Boolean(document.fullscreenElement);
      setFullscreenReady(isFs);
      if (!isFs && stage === 'exam') {
        reportProctoringEvent('fullscreen-exit');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [stage]);

  useEffect(() => {
    if (stage === 'readiness') {
      startCamera();
    }
  }, [stage, startCamera]);

  // Clean up stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // --------------------------------------------------------------------------
  // Proctoring telemetry reporter
  // --------------------------------------------------------------------------

  const reportProctoringEvent = useCallback(
    async (type) => {
      if (!session || stage !== 'exam') return;
      try {
        await fetch(`${API_BASE}/exam/proctoring-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId, type })
        });
      } catch (err) {
        // Safe no-op: observation telemetry failures must never block the exam
        console.warn(`[Proctoring] Observation reporting error for ${type}:`, err);
      }
    },
    [session, stage]
  );

  // Focus loss listener
  useEffect(() => {
    if (stage !== 'exam') return;
    const handleBlur = () => {
      reportProctoringEvent('focus-loss');
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [stage, reportProctoringEvent]);

  // --------------------------------------------------------------------------
  // Exam Start Handler
  // --------------------------------------------------------------------------

  const handleStartExam = async () => {
    if (!name.trim() || !cameraReady || !fullscreenReady) return;

    try {
      setReadinessError('');
      const res = await fetch(`${API_BASE}/exam/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start session');
      }

      const sessionData = await res.json();
      setSession(sessionData);

      // Fetch randomized questions for this session
      const qRes = await fetch(`${API_BASE}/exam/session/${sessionData.sessionId}/questions`);
      if (!qRes.ok) {
        throw new Error('Failed to load session questions');
      }
      const questionsData = await qRes.json();
      setQuestions(questionsData);
      setCurrentIndex(0);
      setSelectedOption(null);
      setTimeRemaining(sessionData.durationSeconds || 600);

      // Start Electron timer & camera snapshot IPC
      if (window.electronAPI?.startTimer) {
        window.electronAPI.startTimer();
      }

      setStage('exam');
    } catch (err) {
      console.error('Error starting exam:', err);
      setReadinessError(err.message);
    }
  };

  // --------------------------------------------------------------------------
  // Timer & Camera Snapshot IPC Subscriptions
  // --------------------------------------------------------------------------

  // Sync remaining time with server deadline
  const syncTime = useCallback(() => {
    if (!session?.endsAt) return;
    const now = Date.now();
    const deadline = new Date(session.endsAt).getTime();
    const remaining = Math.max(0, Math.floor((deadline - now) / 1000));
    setTimeRemaining(remaining);

    if (remaining <= 0 && stage === 'exam') {
      handleFinalSubmission();
    }
  }, [session, stage]);

  useEffect(() => {
    if (stage !== 'exam') return;

    // Electron timer tick listener
    let unsubscribeTimer = () => {};
    if (window.electronAPI?.onTimerTick) {
      unsubscribeTimer = window.electronAPI.onTimerTick(() => {
        syncTime();
      });
    }

    // Fallback 1s interval (ensures progress even in browser mode)
    const fallbackInterval = setInterval(() => {
      syncTime();
    }, 1000);

    return () => {
      unsubscribeTimer();
      clearInterval(fallbackInterval);
    };
  }, [stage, syncTime]);

  // Camera snapshot listener from Electron
  useEffect(() => {
    if (stage !== 'exam' || !window.electronAPI?.onCameraSnapshotRequest) return;

    const unsubscribeSnap = window.electronAPI.onCameraSnapshotRequest(async () => {
      try {
        if (!videoRef.current || !streamRef.current) {
          reportProctoringEvent('snapshot-failure');
          return;
        }

        const video = videoRef.current;
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          reportProctoringEvent('snapshot-failure');
          return;
        }

        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert canvas to ArrayBuffer JPEG
        canvas.toBlob(
          async (blob) => {
            if (!blob) {
              reportProctoringEvent('snapshot-failure');
              return;
            }
            try {
              const arrayBuffer = await blob.arrayBuffer();
              await window.electronAPI.storeCameraSnapImageOnDisk(arrayBuffer);
            } catch (snapErr) {
              console.warn('Snapshot disk write failed:', snapErr);
              reportProctoringEvent('snapshot-failure');
            }
          },
          'image/jpeg',
          0.85
        );
      } catch (err) {
        console.warn('Snapshot capture error:', err);
        reportProctoringEvent('snapshot-failure');
      }
    });

    return () => unsubscribeSnap();
  }, [stage, reportProctoringEvent]);

  // --------------------------------------------------------------------------
  // Exam Action Handlers
  // --------------------------------------------------------------------------

  const handleSelectOption = (index) => {
    setSelectedOption(index);
  };

  const handleSaveAndNext = async () => {
    if (selectedOption === null || isSubmittingAnswer) return;

    const currentQ = questions[currentIndex];
    setIsSubmittingAnswer(true);
    setExamError('');

    try {
      const res = await fetch(`${API_BASE}/exam/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          questionId: currentQ.id,
          selectedAnswer: selectedOption
        })
      });

      if (res.status === 409) {
        // Deadline expired: backend automatically submitted session
        const data = await res.json();
        setResult(data.result);
        if (window.electronAPI?.stopTimer) {
          window.electronAPI.stopTimer();
        }
        setStage('completed');
        return;
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to submit answer');
      }

      // Answer recorded successfully
      if (currentIndex + 1 < questions.length) {
        setCurrentIndex((prev) => prev + 1);
        setSelectedOption(null);
      } else {
        // Last question answered, submit final exam
        await handleFinalSubmission();
      }
    } catch (err) {
      console.error('Answer submission error:', err);
      setExamError(err.message);
    } finally {
      setIsSubmittingAnswer(false);
    }
  };

  const handleFinalSubmission = async () => {
    if (!session) return;
    try {
      const res = await fetch(`${API_BASE}/exam/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId })
      });

      const data = await res.json();
      setResult(data.result || { attempted: 0, correct: 0, wrong: 0 });

      if (window.electronAPI?.stopTimer) {
        window.electronAPI.stopTimer();
      }

      // Stop camera video track
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      setStage('completed');
    } catch (err) {
      console.error('Final submit error:', err);
    }
  };

  // Keyboard navigation for exam options: 1-4 or A-D, Enter to submit
  useEffect(() => {
    if (stage !== 'exam') return;

    const handleKeyDown = (e) => {
      if (['1', '2', '3', '4'].includes(e.key)) {
        setSelectedOption(Number(e.key) - 1);
      } else if (['a', 'b', 'c', 'd'].includes(e.key.toLowerCase())) {
        const map = { a: 0, b: 1, c: 2, d: 3 };
        setSelectedOption(map[e.key.toLowerCase()]);
      } else if (e.key === 'Enter' && selectedOption !== null && !isSubmittingAnswer) {
        handleSaveAndNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [stage, selectedOption, isSubmittingAnswer, handleSaveAndNext]);

  const handleCloseQuiz = () => {
    if (window.electronAPI?.closeCompletedQuiz) {
      window.electronAPI.closeCompletedQuiz();
    } else {
      window.close();
    }
  };

  // --------------------------------------------------------------------------
  // Render: Readiness View
  // --------------------------------------------------------------------------

  if (stage === 'readiness') {
    const isStartReady = name.trim().length > 0 && cameraReady && fullscreenReady;

    return (
      <>
        <header className="top-nav">
          <div className="brand-section">
            <span className="brand-title">
              <Shield className="w-5 h-5 text-blue-500" />
              ATHENA CLOE
            </span>
            <span className="brand-badge">SECURE</span>
          </div>
          <div className="nav-actions">
            <div className="status-pill">
              <span className="pulse-dot"></span>
              KIOSK READINESS GATE
            </div>
          </div>
        </header>

        <main className="readiness-container">
          <div className="readiness-header">
            <h1>Candidate Readiness Verification</h1>
            <p>Complete all three verification requirements before entering the secure kiosk assessment.</p>
          </div>

          {readinessError && (
            <div className="alert-box alert-error">
              <AlertCircle size={18} />
              <span>{readinessError}</span>
            </div>
          )}

          <div className="readiness-grid">
            {/* Identity Card */}
            <div className="readiness-card">
              <div className="card-title-row">
                <h3>
                  <Users size={18} className="text-blue-500" />
                  1. Candidate Identity
                </h3>
                {name.trim() ? (
                  <span className="brand-badge badge-green">VERIFIED</span>
                ) : (
                  <span className="brand-badge badge-amber">REQUIRED</span>
                )}
              </div>
              <p className="text-secondary text-sm">Enter your registered full legal name for score reporting.</p>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted font-mono uppercase block mb-1">Candidate ID</label>
                  <input
                    type="text"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="Candidate ID"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted font-mono uppercase block mb-1">Full Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Alexandra Chen"
                    autoFocus
                  />
                </div>
              </div>
            </div>

            {/* Camera Check Card */}
            <div className="readiness-card">
              <div className="card-title-row">
                <h3>
                  <Camera size={18} className="text-blue-500" />
                  2. Optical Observation
                </h3>
                {cameraReady ? (
                  <span className="brand-badge badge-green">CONNECTED</span>
                ) : (
                  <span className="brand-badge badge-amber">REQUIRED</span>
                )}
              </div>
              <p className="text-secondary text-sm">Periodic camera frames are logged locally for reviewable invigilation.</p>
              <div className="camera-preview-box">
                <video ref={videoRef} autoPlay playsInline muted />
                <div className="camera-corner top-left"></div>
                <div className="camera-corner top-right"></div>
                <div className="camera-corner bottom-left"></div>
                <div className="camera-corner bottom-right"></div>
                {!cameraReady && (
                  <div className="camera-placeholder">
                    <Camera size={32} />
                    <span>Connecting camera stream...</span>
                  </div>
                )}
              </div>
              {!cameraReady && (
                <button className="btn-secondary" onClick={startCamera}>
                  <RefreshCw size={14} /> Retry Camera Access
                </button>
              )}
            </div>
          </div>

          {/* Fullscreen Check Card */}
          <div className="readiness-card">
            <div className="card-title-row">
              <h3>
                <Maximize size={18} className="text-blue-500" />
                3. Document Fullscreen Enforcement
              </h3>
              {fullscreenReady ? (
                <span className="brand-badge badge-green">ACTIVE</span>
              ) : (
                <span className="brand-badge badge-amber">REQUIRED</span>
              )}
            </div>
            <p className="text-secondary text-sm">
              The assessment must occupy the full viewport. Kiosk mode enforces screen lock, while document fullscreen ensures undisturbed visual focus.
            </p>
            <div>
              {!fullscreenReady ? (
                <button className="btn-secondary" onClick={requestFullscreenMode}>
                  <Maximize size={16} /> Enter Fullscreen Mode
                </button>
              ) : (
                <div className="flex items-center gap-2 text-sm text-emerald-400 font-mono">
                  <Check size={16} /> Viewport Fullscreen Verified
                </div>
              )}
            </div>
          </div>

          {/* Disclaimer & Launch */}
          <div className="disclaimer-card">
            <AlertTriangle size={20} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p>
              <strong>Observability Notice:</strong> Athena Cloe monitors fullscreen state, application focus, and camera integrity throughout the exam. Recorded events provide reviewable context for examiners; the system does not make automated disqualification decisions.
            </p>
          </div>

          <button
            className="btn-primary w-full py-4 text-lg font-bold"
            disabled={!isStartReady}
            onClick={handleStartExam}
          >
            Begin Assessment <ArrowRight size={20} />
          </button>
        </main>
      </>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Exam Runner
  // --------------------------------------------------------------------------

  if (stage === 'exam') {
    const currentQ = questions[currentIndex] || {};
    const totalQuestions = questions.length;
    const progressPercent = totalQuestions > 0 ? ((currentIndex + 1) / totalQuestions) * 100 : 0;

    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;
    const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    let timerClass = 'command-timer';
    if (timeRemaining <= 30) {
      timerClass += ' timer-red';
    } else if (timeRemaining <= 120) {
      timerClass += ' timer-amber';
    }

    const optionLetters = ['A', 'B', 'C', 'D'];

    return (
      <>
        {/* Hidden live video element for proctoring captures */}
        <div style={{ position: 'fixed', top: -9999, left: -9999, opacity: 0, pointerEvents: 'none' }}>
          <video ref={videoRef} autoPlay playsInline muted />
        </div>

        <header className="top-nav">
          <div className="brand-section">
            <span className="brand-title">
              <Shield className="w-5 h-5 text-blue-500" />
              ATHENA CLOE
            </span>
            <span className="brand-badge">SECURE</span>
          </div>
          <div className="nav-actions">
            <div className="status-pill">
              <span className="pulse-dot"></span>
              SESSION: {session?.sessionId}
            </div>
            <button className="btn-danger" onClick={() => setShowConfirmEnd(true)}>
              End Assessment
            </button>
          </div>
        </header>

        <main className="exam-viewport">
          {/* Command Bar */}
          <div className="exam-command-bar">
            <div className="command-progress">
              <div className="progress-label">
                Question {currentIndex + 1} of {totalQuestions}
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
              </div>
            </div>

            <div className={timerClass}>
              <Clock size={20} />
              <span className="timer-digits">{formattedTime}</span>
            </div>

            <div className="text-sm font-mono text-secondary">
              Answered: <strong className="text-bright">{currentIndex}</strong> / {totalQuestions}
            </div>
          </div>

          {examError && (
            <div className="alert-box alert-error">
              <AlertCircle size={18} />
              <span>{examError}</span>
            </div>
          )}

          {/* Active Question Box */}
          <div className="question-container">
            <div className="question-header">
              <span className="question-index-tag">
                ITEM {currentIndex + 1} OF {totalQuestions}
              </span>
              <h2 className="question-prompt">{currentQ.question}</h2>
            </div>

            <div className="options-grid">
              {(currentQ.options || []).map((opt, idx) => {
                const isSelected = selectedOption === idx;
                return (
                  <div
                    key={idx}
                    className={`option-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectOption(idx)}
                  >
                    <span className="option-badge">{optionLetters[idx]}</span>
                    <span className="option-text">{opt}</span>
                    {isSelected && <Check size={18} className="text-blue-500 flex-shrink-0" />}
                  </div>
                );
              })}
            </div>

            <div className="question-footer">
              <span className="keyboard-hint">Use keys 1–4 or A–D to select • Enter to advance</span>
              <button
                className="btn-primary"
                disabled={selectedOption === null || isSubmittingAnswer}
                onClick={handleSaveAndNext}
              >
                {isSubmittingAnswer ? (
                  <>Saving...</>
                ) : currentIndex + 1 === totalQuestions ? (
                  <>Submit Final Assessment <ArrowRight size={16} /></>
                ) : (
                  <>Save & Next Question <ArrowRight size={16} /></>
                )}
              </button>
            </div>
          </div>

          {/* HUD Status Bar */}
          <div className="exam-hud-bar">
            <span className="flex items-center gap-2">
              <Activity size={14} className="text-emerald-400" />
              Proctoring Active: Screen Lock & Optical Heartbeat
            </span>
            <span>Candidate: {name} ({userId})</span>
          </div>
        </main>

        {/* Two-step Confirmation Modal */}
        {showConfirmEnd && (
          <div className="modal-backdrop">
            <div className="modal-content">
              <div className="modal-header">
                <AlertTriangle size={24} className="text-amber-500" />
                <h3>Confirm Early Submission</h3>
              </div>
              <div className="modal-body">
                <p>
                  Are you sure you want to finalize your assessment? Only answers saved up to this point will be scored, and your session will be locked.
                </p>
              </div>
              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => setShowConfirmEnd(false)}>
                  Resume Exam
                </button>
                <button
                  className="btn-danger"
                  onClick={() => {
                    setShowConfirmEnd(false);
                    handleFinalSubmission();
                  }}
                >
                  Submit & End Assessment
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Completed Result View
  // --------------------------------------------------------------------------

  return (
    <>
      <header className="top-nav">
        <div className="brand-section">
          <span className="brand-title">
            <Shield className="w-5 h-5 text-blue-500" />
            ATHENA CLOE
          </span>
          <span className="brand-badge badge-green">SUBMITTED</span>
        </div>
        <div className="nav-actions">
          <div className="status-pill">
            <span className="pulse-dot dot-green"></span>
            EXAM CONCLUDED
          </div>
        </div>
      </header>

      <main className="result-container">
        <div className="result-badge-icon">
          <CheckCircle size={40} />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-extrabold text-bright">Assessment Successfully Submitted</h1>
          <p className="text-secondary text-sm">
            Your answers and observational integrity telemetry have been safely recorded.
          </p>
        </div>

        <div className="result-card">
          <div className="text-left font-mono text-xs text-muted border-b border-subtle pb-3">
            SESSION ID: <span className="text-secondary">{session?.sessionId}</span> • CANDIDATE: <span className="text-secondary">{name} ({userId})</span>
          </div>

          <div className="result-stats-grid">
            <div className="stat-item">
              <span className="stat-value">{result?.attempted ?? 0}</span>
              <span className="stat-label">Attempted</span>
            </div>
            <div className="stat-item">
              <span className="stat-value text-emerald-400">{result?.correct ?? 0}</span>
              <span className="stat-label">Correct</span>
            </div>
            <div className="stat-item">
              <span className="stat-value text-red-400">{result?.wrong ?? 0}</span>
              <span className="stat-label">Incorrect</span>
            </div>
          </div>

          <div className="disclaimer-card text-left">
            <p className="text-xs">
              <strong>Invigilation Review:</strong> Final certified grade reports are released by the examiner console following review of session telemetry.
            </p>
          </div>
        </div>

        <button className="btn-primary w-full py-3" onClick={handleCloseQuiz}>
          Close Quiz
        </button>
      </main>
    </>
  );
}

/* ==========================================================================
   EXAMINER CONSOLE COMPONENT (#examiner)
   ========================================================================== */

function ExaminerConsole() {
  const [password, setPassword] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);

  // Dashboard state
  const [sessions, setSessions] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [expandedSessionIds, setExpandedSessionIds] = useState(new Set());
  const [saveStatusMap, setSaveStatusMap] = useState({}); // { [qid]: { loading, error, success } }
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Authenticate examiner password against /examiner/sessions
  const handleAuthenticate = async (e) => {
    e?.preventDefault();
    if (!password) return;

    setIsLoadingAuth(true);
    setAuthError('');

    try {
      const res = await fetch(`${API_BASE}/examiner/sessions`, {
        headers: { 'x-examiner-password': password }
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Authentication failed');
      }

      const sessionsData = await res.json();
      setAuthPassword(password);
      setSessions(sessionsData);

      // Fetch questions
      const qRes = await fetch(`${API_BASE}/examiner/questions`, {
        headers: { 'x-examiner-password': password }
      });
      if (qRes.ok) {
        const qData = await qRes.json();
        setQuestions(qData);
      }
    } catch (err) {
      console.error('Examiner auth error:', err);
      setAuthError(err.message);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const refreshDashboardData = async () => {
    if (!authPassword) return;
    setIsRefreshing(true);
    try {
      const [sRes, qRes] = await Promise.all([
        fetch(`${API_BASE}/examiner/sessions`, { headers: { 'x-examiner-password': authPassword } }),
        fetch(`${API_BASE}/examiner/questions`, { headers: { 'x-examiner-password': authPassword } })
      ]);

      if (sRes.ok) setSessions(await sRes.json());
      if (qRes.ok) setQuestions(await qRes.json());
    } catch (err) {
      console.warn('Dashboard refresh failed:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  const toggleExpandSession = (sessionId) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  // Question editing handlers
  const handleQuestionChange = (qid, field, value) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === qid ? { ...q, [field]: value } : q))
    );
  };

  const handleOptionChange = (qid, optIndex, value) => {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== qid) return q;
        const newOpts = [...q.options];
        newOpts[optIndex] = value;
        return { ...q, options: newOpts };
      })
    );
  };

  const handleCorrectAnswerChange = (qid, correctIndex) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === qid ? { ...q, correctAnswer: correctIndex } : q))
    );
  };

  const handleSaveQuestion = async (qid) => {
    const q = questions.find((item) => item.id === qid);
    if (!q) return;

    setSaveStatusMap((prev) => ({
      ...prev,
      [qid]: { loading: true, error: '', success: false }
    }));

    try {
      const res = await fetch(`${API_BASE}/examiner/questions/${qid}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-examiner-password': authPassword
        },
        body: JSON.stringify({
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update question');
      }

      setSaveStatusMap((prev) => ({
        ...prev,
        [qid]: { loading: false, error: '', success: true }
      }));

      setTimeout(() => {
        setSaveStatusMap((prev) => ({
          ...prev,
          [qid]: { ...prev[qid], success: false }
        }));
      }, 3000);
    } catch (err) {
      console.error('Save question error:', err);
      setSaveStatusMap((prev) => ({
        ...prev,
        [qid]: { loading: false, error: err.message, success: false }
      }));
    }
  };

  // --------------------------------------------------------------------------
  // View 1: Password Gate
  // --------------------------------------------------------------------------

  if (!authPassword) {
    return (
      <div className="examiner-viewport">
        <div className="password-gate-card">
          <div className="gate-icon">
            <Lock size={28} />
          </div>

          <div className="space-y-1">
            <h2 className="text-xl font-bold text-bright">Examiner Control Console</h2>
            <p className="text-secondary text-xs">Classroom assessment maintenance & audit logs</p>
          </div>

          {authError && (
            <div className="alert-box alert-error text-left w-full text-xs">
              <AlertCircle size={16} className="flex-shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleAuthenticate} className="w-full space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter Examiner Password"
                autoFocus
              />
            </div>
            <button className="btn-primary w-full" type="submit" disabled={isLoadingAuth || !password}>
              {isLoadingAuth ? 'Authorizing...' : 'Authorize Console'}
            </button>
          </form>

          <p className="text-muted text-xs">
            Password is validated against the server's EXAMINER_PASSWORD environment variable.
          </p>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // View 2: Examiner Dashboard
  // --------------------------------------------------------------------------

  const activeCount = sessions.filter(
    (s) => s.status === 'in-progress' && new Date(s.endsAt) > new Date()
  ).length;
  const signaledCount = sessions.filter(
    (s) => (s.proctoringEvents || []).length > 0
  ).length;

  return (
    <>
      <header className="top-nav">
        <div className="brand-section">
          <span className="brand-title">
            <Shield className="w-5 h-5 text-blue-500" />
            ATHENA CLOE
          </span>
          <span className="brand-badge">EXAMINER CONSOLE</span>
        </div>
        <div className="nav-actions">
          <button className="btn-secondary" onClick={refreshDashboardData} disabled={isRefreshing}>
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} /> Refresh
          </button>
          <button className="btn-danger" onClick={() => setAuthPassword('')}>
            <LogOut size={14} /> Lock Console
          </button>
        </div>
      </header>

      <main className="examiner-viewport">
        {/* Operational Summary Metrics */}
        <div className="metrics-grid">
          <div className="metric-card">
            <div className="metric-label">
              <Users size={14} /> Total Attempts
            </div>
            <div className="metric-value">{sessions.length}</div>
          </div>

          <div className="metric-card">
            <div className="metric-label">
              <Activity size={14} /> Active Exams
            </div>
            <div className="metric-value text-blue-400">{activeCount}</div>
          </div>

          <div className="metric-card">
            <div className="metric-label">
              <AlertTriangle size={14} /> Sessions with Signals
            </div>
            <div className="metric-value text-amber-400">{signaledCount}</div>
          </div>

          <div className="metric-card">
            <div className="metric-label">
              <FileText size={14} /> Question Bank Size
            </div>
            <div className="metric-value text-emerald-400">{questions.length}</div>
          </div>
        </div>

        {/* Section 1: Candidate Sessions & Audit Timeline */}
        <section>
          <div className="section-header">
            <h2>
              <Activity size={20} className="text-blue-500" />
              Candidate Sessions & Observability Audit
            </h2>
            <span className="text-xs font-mono text-muted">{sessions.length} RECORDED SESSIONS</span>
          </div>

          {sessions.length === 0 ? (
            <div className="readiness-card text-center text-muted py-12">
              No exam sessions recorded yet. Launch a student assessment to populate attempts.
            </div>
          ) : (
            <div className="sessions-list">
              {sessions.map((ses) => {
                const isExpanded = expandedSessionIds.has(ses.sessionId);
                const hasSignals = (ses.proctoringEvents || []).length > 0;
                const isActive = ses.status === 'in-progress' && new Date(ses.endsAt) > new Date();

                return (
                  <div key={ses.sessionId} className="session-audit-card">
                    <div className="session-row-top">
                      <div className="candidate-info">
                        <span className="candidate-name">{ses.name}</span>
                        <span className="candidate-id-badge">{ses.userId}</span>
                        <span className="text-xs font-mono text-muted">{ses.sessionId}</span>
                      </div>

                      <div className="flex items-center gap-3">
                        {isActive ? (
                          <span className="brand-badge badge-amber">IN PROGRESS</span>
                        ) : (
                          <span className="brand-badge badge-green">SUBMITTED</span>
                        )}

                        {hasSignals ? (
                          <span className="brand-badge badge-amber">
                            {ses.proctoringEvents.length} OBSERVATION{ses.proctoringEvents.length > 1 ? 'S' : ''}
                          </span>
                        ) : (
                          <span className="brand-badge badge-green">CLEAN AUDIT</span>
                        )}
                      </div>
                    </div>

                    <div className="session-row-top text-xs text-secondary border-t border-subtle pt-3">
                      <div>
                        Started: <strong className="text-bright">{new Date(ses.startedAt).toLocaleTimeString()}</strong>
                        {ses.submittedAt && (
                          <> • Submitted: <strong className="text-bright">{new Date(ses.submittedAt).toLocaleTimeString()}</strong></>
                        )}
                      </div>

                      <div className="session-stats-summary">
                        <span>Attempted: <strong>{ses.attempted}</strong></span>
                        <span className="text-emerald-400">Correct: <strong>{ses.correct}</strong></span>
                        <span className="text-red-400">Wrong: <strong>{ses.wrong}</strong></span>
                      </div>

                      <button
                        className="timeline-toggle-btn"
                        onClick={() => toggleExpandSession(ses.sessionId)}
                      >
                        {isExpanded ? (
                          <>Hide Audit Log <ChevronUp size={14} /></>
                        ) : (
                          <>View Audit Log ({ses.eventCount || 0}) <ChevronDown size={14} /></>
                        )}
                      </button>
                    </div>

                    {/* Expandable Proctoring Timeline */}
                    {isExpanded && (
                      <div className="timeline-container">
                        <div className="timeline-notice">
                          <Eye size={14} className="text-blue-400" />
                          <span>Signals support review and are not cheating verdicts. Answer selections and camera buffers are excluded from audit records.</span>
                        </div>

                        {(ses.proctoringEvents || []).length === 0 ? (
                          <div className="text-xs text-muted font-mono py-2">
                            No proctoring observations recorded for this session.
                          </div>
                        ) : (
                          <div className="space-y-2 mt-2">
                            {ses.proctoringEvents.map((evt, eIdx) => (
                              <div key={eIdx} className="event-item">
                                <span className="font-bold text-amber-400 uppercase">
                                  [{evt.type}]
                                </span>
                                <span className="text-muted text-xs">
                                  {new Date(evt.occurredAt).toLocaleTimeString()} ({new Date(evt.occurredAt).toISOString()})
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Question Bank Editor */}
        <section>
          <div className="section-header">
            <h2>
              <FileText size={20} className="text-blue-500" />
              Question Bank Maintenance
            </h2>
            <span className="text-xs font-mono text-muted">{questions.length} QUESTIONS IN BANK</span>
          </div>

          <div className="disclaimer-card mb-4">
            <p className="text-xs">
              <strong>Active Exam Lock:</strong> The server automatically rejects modifications to questions currently assigned to active, in-progress assessments (HTTP 409 Conflict) to prevent integrity violations.
            </p>
          </div>

          <div className="space-y-6">
            {questions.map((q) => {
              const status = saveStatusMap[q.id] || {};
              const optionLetters = ['A', 'B', 'C', 'D'];

              return (
                <div key={q.id} className="question-editor-card">
                  <div className="question-editor-header">
                    <span className="font-mono text-xs font-bold text-blue-400">
                      QUESTION #{q.id}
                    </span>
                    <button
                      className="btn-primary"
                      disabled={status.loading}
                      onClick={() => handleSaveQuestion(q.id)}
                    >
                      {status.loading ? 'Saving...' : 'Save Question'}
                    </button>
                  </div>

                  {status.error && (
                    <div className="alert-box alert-error text-xs">
                      <AlertCircle size={16} />
                      <span>{status.error}</span>
                    </div>
                  )}

                  {status.success && (
                    <div className="alert-box alert-success text-xs">
                      <Check size={16} />
                      <span>Question #{q.id} updated successfully.</span>
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-muted font-mono uppercase block mb-1">
                      Question Text
                    </label>
                    <textarea
                      rows={2}
                      value={q.question}
                      onChange={(e) => handleQuestionChange(q.id, 'question', e.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs text-muted font-mono uppercase block">
                      Options & Correct Answer Indicator
                    </label>
                    {(q.options || []).map((opt, oIdx) => {
                      const isCorrect = q.correctAnswer === oIdx;
                      return (
                        <div key={oIdx} className="option-edit-row">
                          <input
                            type="radio"
                            name={`correct-${q.id}`}
                            checked={isCorrect}
                            onChange={() => handleCorrectAnswerChange(q.id, oIdx)}
                            className="radio-correct"
                            title="Mark as correct answer"
                          />
                          <span className="font-mono text-xs font-bold text-muted w-6">
                            {optionLetters[oIdx]}.
                          </span>
                          <input
                            type="text"
                            value={opt}
                            onChange={(e) => handleOptionChange(q.id, oIdx, e.target.value)}
                            placeholder={`Option ${optionLetters[oIdx]}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </>
  );
}
