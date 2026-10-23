const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const readline = require('readline');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const PROCTORING_DIR = path.join(ROOT_DIR, 'proctoring-tool');

const mode = process.argv[2] || 'student';
const isAdmin = mode === 'admin';

let backendProcess = null;
let viteProcess = null;
let electronProcess = null;

// Clean up child processes on exit
function cleanup() {
  console.log('\n[Athena Cloe] Shutting down background services...');

  if (electronProcess && !electronProcess.killed) {
    try { electronProcess.kill('SIGTERM'); } catch (e) {}
  }
  if (viteProcess && !viteProcess.killed) {
    try { viteProcess.kill('SIGTERM'); } catch (e) {}
  }
  if (backendProcess && !backendProcess.killed) {
    try { backendProcess.kill('SIGTERM'); } catch (e) {}
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

process.on('exit', cleanup);

// Prompt for password in admin mode if not provided in environment
function promptPassword() {
  return new Promise((resolve) => {
    if (process.env.EXAMINER_PASSWORD) {
      return resolve(process.env.EXAMINER_PASSWORD);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('\n🔑 Enter EXAMINER_PASSWORD to launch Admin Console: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        console.error('❌ Error: EXAMINER_PASSWORD cannot be empty.');
        process.exit(1);
      }
      resolve(trimmed);
    });
  });
}

// Poll HTTP URL until it responds
function waitForServer(url, timeoutMs = 30000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
        } else {
          setTimeout(check, 250);
        }
      });
    };
    check();
  });
}

async function main() {
  console.log(`[Athena Cloe] Initializing ${isAdmin ? 'ADMIN EXAMINER CONSOLE' : 'STUDENT KIOSK'}...`);

  let examinerPassword = process.env.EXAMINER_PASSWORD || '';
  if (isAdmin) {
    examinerPassword = await promptPassword();
    process.env.EXAMINER_PASSWORD = examinerPassword;
  } else {
    // Default fallback password for student session so examiner endpoints remain configured
    if (!process.env.EXAMINER_PASSWORD) {
      process.env.EXAMINER_PASSWORD = 'classroom-secret';
      examinerPassword = 'classroom-secret';
    }
  }

  // 1. Start Backend Express Server
  console.log('[Athena Cloe] Starting Express backend on port 3000...');
  backendProcess = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '3000',
      EXAMINER_PASSWORD: examinerPassword
    }
  });

  backendProcess.on('error', (err) => {
    console.error('[Athena Cloe Backend Error]:', err);
    cleanup();
    process.exit(1);
  });

  // 2. Start Vite Development Server
  console.log('[Athena Cloe] Starting Vite development server on port 5173...');
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  viteProcess = spawn(npxCmd, ['vite', '--port', '5173', '--strictPort'], {
    cwd: PROCTORING_DIR,
    stdio: 'inherit',
    env: {
      ...process.env
    }
  });

  viteProcess.on('error', (err) => {
    console.error('[Athena Cloe Vite Error]:', err);
    cleanup();
    process.exit(1);
  });

  // 3. Wait for Vite to be ready
  console.log('[Athena Cloe] Waiting for Vite development server to become available...');
  try {
    await waitForServer('http://localhost:5173');
    console.log('[Athena Cloe] Vite is ready at http://localhost:5173');
  } catch (err) {
    console.error('[Athena Cloe] Failed to connect to Vite:', err.message);
    cleanup();
    process.exit(1);
  }

  // 4. Launch Electron
  console.log(`[Athena Cloe] Launching Electron window (${isAdmin ? 'Admin Console' : 'Student Kiosk'})...`);
  const electronBinary = require('electron');
  const electronAppPath = path.join(PROCTORING_DIR, 'app', 'app.js');
  const electronArgs = [electronAppPath];

  if (isAdmin) {
    electronArgs.push('--admin');
  }

  electronProcess = spawn(electronBinary, electronArgs, {
    cwd: PROCTORING_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      EXAMINER_PASSWORD: examinerPassword
    }
  });

  electronProcess.on('close', (code) => {
    console.log(`[Athena Cloe] Electron window closed (exit code ${code}). Stopping all child services.`);
    cleanup();
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('[Athena Cloe Fatal Error]:', err);
  cleanup();
  process.exit(1);
});
