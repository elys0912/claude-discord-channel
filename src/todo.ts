// TODO の進み具合のカード（progress ツールの実体）。
// Claude が progress ツールで TODO の一覧を渡すたびに、返信先に 1 枚のカードを出し、以後はそのカードを書き換える。
// 次に話しかけられたら（新しい依頼）、次の一覧は新しいカードにする（上の方の古いカードを書き換えても見えないため）。
// Claude Code の TodoWrite は版によって無いので、hook ではなくブリッジのツールにしてある。
import type { Card } from './card.js';
import { md } from './card.js';
import type { DiscordBridge } from './discord.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const MARK: Record<TodoStatus, string> = {
  completed: '✅',
  in_progress: '▶️',
  pending: '⬜',
};

/** TODO の一覧をカードにする。終わったものは打ち消し線、作業中は太字。全部終わったら緑 */
export function buildTodoCard(todos: readonly TodoItem[]): Card {
  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = todos.map((t) => {
    const text = md(t.content.replace(/\s+/g, ' ').trim());
    if (t.status === 'completed') return `${MARK.completed} ~~${text}~~`;
    if (t.status === 'in_progress') return `${MARK.in_progress} **${text}**`;
    return `${MARK.pending} ${text}`;
  });
  const allDone = todos.length > 0 && done === todos.length;
  return {
    color: allDone ? 'ok' : 'info',
    title: `📋 TODO（${done}/${todos.length} 完了）`,
    body: lines.length > 0 ? lines.join('\n') : '（TODO は空）',
  };
}

export type TodoBridge = Pick<DiscordBridge, 'postCard' | 'updateCard'>;

export class TodoBoard {
  /** 今のカード（どの返信先のどのメッセージか） */
  private current: { channel: string; threadTs: string | undefined; ts: string } | undefined;

  constructor(
    private readonly bridge: TodoBridge,
    private readonly logger: Logger
  ) {}

  /** 新しい依頼が来た。次の一覧は新しいカードにする */
  reset(): void {
    this.current = undefined;
  }

  /**
   * TODO を出す。同じ返信先に出しているカードがあれば書き換え、無ければ（書き換えに失敗したら）新しく出す。
   * 新しく出すのに失敗したら投げる（ツールの結果として Claude に返す）
   */
  async update(at: { channel: string; threadTs?: string | undefined }, todos: readonly TodoItem[]): Promise<'posted' | 'updated'> {
    const card = buildTodoCard(todos);
    const current = this.current;
    if (current && current.channel === at.channel && current.threadTs === at.threadTs) {
      try {
        await this.bridge.updateCard(current.channel, current.ts, card);
        return 'updated';
      } catch (e) {
        this.logger.warn('TODO のカードの書き換えに失敗、新しく出す', errMessage(e));
      }
    }
    const res = await this.bridge.postCard(at.channel, card, at.threadTs);
    this.current = { channel: at.channel, threadTs: at.threadTs, ts: res.ts };
    return 'posted';
  }
}
