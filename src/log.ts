// stderr / ファイルへ書き出すロガー。
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 文字列をログのレベルにする（大文字・小文字は問わない）。空・知らない値なら undefined */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v in LEVEL_ORDER ? (v as LogLevel) : undefined;
}

// Discord のボットのトークン（`<ユーザー ID の base64>.<時刻>.<署名>` の 3 つの部分）、Webhook の URL に含まれるトークン、
// Authorization ヘッダーの値（Bot / Bearer）をログから伏せる。
const DISCORD_TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}/g;
const WEBHOOK_URL_RE = /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/g;
// 「Bot ready」のような普通の文を伏せないよう、トークンらしい長さ（16 文字以上）の値だけを対象にする
const AUTH_HEADER_RE = /\b(Bot|Bearer)\s+[\w.~+/=-]{16,}/g;

export function redact(s: string): string {
  return s
    .replace(WEBHOOK_URL_RE, '$1***')
    .replace(DISCORD_TOKEN_RE, '***')
    .replace(AUTH_HEADER_RE, (_m, kind: string) => `${kind} ***`);
}

// 循環参照があっても落ちない JSON.stringify
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  return safeStringify(a);
}

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  maxBytes?: number; // 既定 5MB
  stderr?: boolean; // 既定 true
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class Logger {
  private file: string | undefined;
  private level: LogLevel;
  private maxBytes: number;
  private toStderr: boolean;
  private name = '';

  constructor(opts: LoggerOptions = {}) {
    this.file = opts.file;
    this.level = opts.level ?? 'info';
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.toStderr = opts.stderr ?? true;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(name: string): void {
    this.name = name;
  }

  debug(...a: unknown[]): void {
    this.write('debug', a);
  }

  info(...a: unknown[]): void {
    this.write('info', a);
  }

  warn(...a: unknown[]): void {
    this.write('warn', a);
  }

  error(...a: unknown[]): void {
    this.write('error', a);
  }

  private write(level: LogLevel, args: unknown[]): void {
    try {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

      const ts = new Date().toISOString();
      const msg = args.map(formatArg).join(' ');
      const line = redact(`${ts} ${level.toUpperCase()} [${this.name}] ${msg}`);

      if (this.toStderr) {
        try {
          process.stderr.write(`${line}\n`);
        } catch {
          // stderr への書き込み失敗も呼び出し元へは伝えない
        }
      }

      if (this.file) {
        this.writeToFile(this.file, `${line}\n`);
      }
    } catch {
      // ログ出力自体で例外が起きても呼び出し元に投げない
    }
  }

  private writeToFile(file: string, line: string): void {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      try {
        const stat = fs.statSync(file);
        if (stat.size > this.maxBytes) {
          const rotated = `${file}.1`;
          try {
            fs.renameSync(file, rotated);
          } catch {
            // ローテーション失敗は無視して書き込みを続ける
          }
        }
      } catch {
        // ファイルがまだ無いだけなら何もしない
      }

      fs.appendFileSync(file, line);
    } catch {
      // ファイル書き込みの失敗も呼び出し元へは伝えない
    }
  }
}
