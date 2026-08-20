import { untrusted } from '../core/render.js';
import { procexec } from './procexec.js';

export function buildNotifyArgv({ platform, title, body }) {
  const safeTitle = untrusted(title, { maxWidth: 80 });
  const safeBody = untrusted(body, { maxWidth: 200 });

  if (platform === 'darwin') {
    return {
      notifier: 'osascript',
      argv: [
        'osascript',
        '-e',
        'on run argv',
        '-e',
        'display notification (item 1 of argv) with title (item 2 of argv)',
        '-e',
        'end run',
        safeBody,
        safeTitle,
      ],
    };
  }

  if (platform === 'linux') {
    return { notifier: 'notify-send', argv: ['notify-send', '--', safeTitle, safeBody] };
  }

  return { notifier: 'none', argv: null };
}

export async function sendNotification({ platform, title, body, env, exec = procexec }) {
  const built = buildNotifyArgv({ platform, title, body });
  if (built.notifier === 'none') {
    return { fired: false, notifier: 'none', reason: 'unsupported platform' };
  }

  try {
    const result = await exec(built.argv, { env: { PATH: env.PATH ?? '' }, timeoutMs: 2000 });
    if (result.code !== 0 || result.timedOut || result.truncated) {
      return { fired: false, notifier: built.notifier, reason: 'notifier failed' };
    }
    return { fired: true, notifier: built.notifier, reason: 'sent' };
  } catch {
    return { fired: false, notifier: built.notifier, reason: 'notifier unavailable' };
  }
}
