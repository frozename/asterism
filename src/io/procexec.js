import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export async function procexec(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === 'string')) {
    throw new TypeError('procexec: argv must be a non-empty array of strings');
  }

  const { env = {}, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = options;
  const [command, ...args] = argv;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let killedForSize = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    function killIfOverSize() {
      if (killedForSize) return;
      if (stdoutBytes > maxBytes || stderrBytes > maxBytes) {
        killedForSize = true;
        child.kill('SIGKILL');
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
      killIfOverSize();
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
      killIfOverSize();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
      });
    });
  });
}
