// 長い返信を、何十通にも分けずに「冒頭 + 全文の添付」にする（I/O なし）。
// テストのログや diff を reply に渡されたとき、スマホで読みにくい細切れのメッセージが並ぶのを避ける。
import { chunkText } from './chunk.js';

/** 既定の「長い」の境目（これを超えたら添付にする） */
export const DEFAULT_LONG_REPLY_CHARS = 6000;
/** 本文に載せる冒頭の長さ（2000 字の上限に、末尾の案内とコードブロックを閉じ直す分の余裕を持たせる） */
export const LONG_REPLY_HEAD_CHARS = 1800;
export const LONG_REPLY_FILE_NAME = 'reply.md';

export interface LongReply {
  /** 本文（冒頭と、全文は添付にある旨） */
  content: string;
  /** 添付する全文（UTF-8） */
  file: Buffer;
  name: string;
}

/** 長ければ冒頭と全文の添付に分ける。limit 以下（または limit が 0 以下）なら undefined（今までどおり分けて送る） */
export function toLongReply(text: string, limit: number = DEFAULT_LONG_REPLY_CHARS): LongReply | undefined {
  if (limit <= 0 || text.length <= limit) return undefined;
  // chunkText は途中で切ったコードブロックを閉じてくれる
  const head = chunkText(text, LONG_REPLY_HEAD_CHARS)[0] ?? '';
  return {
    content: `${head}\n…（全文 ${text.length} 字は添付の ${LONG_REPLY_FILE_NAME}）`,
    file: Buffer.from(text, 'utf8'),
    name: LONG_REPLY_FILE_NAME,
  };
}
