// ターミナル（ConsoleAccess）の偽物（app 系のテストと session-control.test.ts で共用）。
// 本物は PowerShell で画面を読み、キーとコマンドを送る。ここでは送られたものを配列に入れるだけにする。
import type { ConsoleAccess, ConsoleKey } from '../../src/console.js';

export interface FakeConsoleOptions {
  /** read で返す画面。関数なら読むたびに呼ぶ（テストの途中で画面を変えるため）。省略時は空 */
  screen?: string | (() => string) | undefined;
  /** sendKeys で送られたキーを入れる */
  keys?: ConsoleKey[][] | undefined;
  /** sendCommand で送られたコマンドを入れる */
  commands?: string[] | undefined;
  /** sendCommand を失敗させる */
  failCommand?: boolean | undefined;
}

export function fakeConsole(opts: FakeConsoleOptions = {}): ConsoleAccess {
  return {
    read: async () => (typeof opts.screen === 'function' ? opts.screen() : (opts.screen ?? '')),
    sendKeys: async (keys) => void opts.keys?.push(keys),
    sendCommand: async (command) => {
      if (opts.failCommand) throw new Error('console gone');
      opts.commands?.push(command);
    },
  };
}
