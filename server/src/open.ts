import { spawn } from 'node:child_process';
import { IS_WIN } from './paths.ts';

/**
 * Launch things with the user's shell without ever building a command string from the path:
 * the target travels in an environment variable, so quotes, spaces, `&` or Chinese characters
 * cannot break out of the command. Works from the single-executable build (no ESM-only deps).
 */
function powershell(command: string, env: Record<string, string>): void {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/** Open a file or URL with its default application. */
export function openWithDefaultApp(target: string): void {
  if (IS_WIN) powershell('Start-Process -FilePath $env:MDSV_TARGET', { MDSV_TARGET: target });
  else if (process.platform === 'darwin') detached('open', [target]);
  else detached('xdg-open', [target]);
}

/** Open a file in VS Code (`code` on PATH); silently does nothing when it is not installed. */
export function openInEditor(target: string): void {
  if (IS_WIN) powershell("Start-Process -FilePath 'code' -ArgumentList ('\"' + $env:MDSV_TARGET + '\"')", { MDSV_TARGET: target });
  else detached('code', [target]);
}

/** Show the file in Explorer / Finder / the file manager, selected. */
export function revealInFileManager(target: string): void {
  if (IS_WIN) detached('explorer.exe', ['/select,' + target]);
  else if (process.platform === 'darwin') detached('open', ['-R', target]);
  else detached('xdg-open', [target.replace(/[\\/][^\\/]*$/, '')]);
}
