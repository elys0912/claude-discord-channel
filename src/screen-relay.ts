// ターミナル画面の確認と、Discord からの選択画面の解除。
// 画面を読んで選択画面なら選択肢を選択メニューで出し、選ばれたら画面を読み直して同じ画面のときだけ選択キーを送る。
// 自由な文字入力は送らない（Discord から任意のコマンドを打ち込めないようにするため）。
import type { Card, CardColor } from './card.js';
import { md } from './card.js';
import type { ConsoleAccess } from './console.js';
import type { DiscordBridge } from './discord.js';
import type { Logger } from './log.js';
import { redact } from './log.js';
import { errMessage } from './errors.js';
import { textCard } from './notice.js';
import { choiceFingerprint, keysToSelect, parseChoiceScreen, screenTail } from './screen.js';
import type { ChoiceScreen } from './screen.js';
import { newToken } from './text.js';
import type { PressedMessage } from './types.js';
import { ACTION, customId } from './permission.js';

/** 選択肢の有効期限 */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export type ScreenBridge = Pick<DiscordBridge, 'postText' | 'postCard' | 'updateCard'>;

interface Snapshot {
  fingerprint: string;
  choice: ChoiceScreen;
  expiresAt: number;
}

export interface ScreenRelayOptions {
  /** 画面を読めない環境（コンソールが無い・スクリプトが無い）なら undefined */
  console: ConsoleAccess | undefined;
  bridge: ScreenBridge;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
}

/** 知らせのカード。withScreenButton なら「🖥 画面を確認」ボタンを添える */
export function noticeCard(text: string, withScreenButton: boolean, color: CardColor = 'warn'): Card {
  return {
    ...textCard(text, color),
    ...(withScreenButton ? { buttons: [[{ label: '🖥 画面を確認', id: customId(ACTION.SCREEN_SHOW) }]] } : {}),
  };
}

export class ScreenRelay {
  private readonly console: ConsoleAccess | undefined;
  private readonly bridge: ScreenBridge;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(opts: ScreenRelayOptions) {
    this.console = opts.console;
    this.bridge = opts.bridge;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newToken;
  }

  /** 画面を読んでスレッドに出す。選択画面なら選択肢の選択メニュー、そうでなければ画面の末尾。投げない */
  async show(channel: string, threadTs: string): Promise<void> {
    try {
      if (!this.console) {
        await this.bridge.postText(channel, '⚠️ このブリッジからはターミナルの画面を読めない（コンソールが無い）。', threadTs);
        return;
      }
      const screen = await this.console.read();
      const choice = parseChoiceScreen(screen);
      if (!choice) {
        const tail = redact(screenTail(screen));
        await this.bridge.postCard(channel, { color: 'info', title: '🖥 ターミナルの画面（末尾）', code: tail || '(空)' }, threadTs);
        return;
      }
      this.prune();
      const id = this.newId();
      this.snapshots.set(id, { fingerprint: choiceFingerprint(choice), choice, expiresAt: this.now() + SNAPSHOT_TTL_MS });
      await this.bridge.postCard(channel, buildChoiceCard(id, choice), threadTs);
      this.logger.info(`選択画面を Discord に表示 id=${id} 選択肢=${choice.options.length}`);
    } catch (e) {
      this.logger.warn('画面の確認に失敗', e);
      await this.bridge.postText(channel, `⚠️ 画面を読めなかった: ${errMessage(e)}`, threadTs).catch(() => undefined);
    }
  }

  /**
   * 選択肢が選ばれた。画面を読み直して、見せたときと同じ選択画面なら選択キーを送り、
   * 押されたメッセージを結果の表示に書き換える。期限切れ・画面が変わっていたら何も送らず知らせる。投げない。
   */
  async pick(snapshotId: string, index: number, pressed: PressedMessage, byUserId: string): Promise<void> {
    const report = (message: string, color: CardColor): Promise<void> => this.report(pressed, message, color);

    const snapshot = this.snapshots.get(snapshotId);
    this.snapshots.delete(snapshotId);
    if (!snapshot || this.now() > snapshot.expiresAt) {
      await report('⌛ この選択肢は期限切れ。もう一度「画面を確認」から選び直すこと。', 'muted');
      return;
    }
    const option = snapshot.choice.options[index];
    if (!option || !this.console) {
      await report('⚠️ 選べない選択肢だった。', 'warn');
      return;
    }

    try {
      const current = parseChoiceScreen(await this.console.read());
      if (!current || choiceFingerprint(current) !== snapshot.fingerprint) {
        await report('⚠️ 画面が変わっていたので何も送らなかった。もう一度「画面を確認」から選び直すこと。', 'warn');
        return;
      }
      await this.console.sendKeys(keysToSelect(current.cursor, index));
      this.logger.info(`選択画面で「${option.label}」を選択 id=${snapshotId} by=${byUserId}`);
      await report(`✅ 「${option.label}」を選んだ`, 'ok');
    } catch (e) {
      this.logger.warn('選択キーの送信に失敗', e);
      await report(`⚠️ 選択を送れなかった: ${errMessage(e)}`, 'error');
    }
  }

  /** 結果を知らせる。押されたメッセージが分かればそれを書き換え、分からなければスレッドに投稿する。投げない */
  private async report(pressed: PressedMessage, message: string, color: CardColor): Promise<void> {
    if (pressed.ts) {
      await this.bridge
        .updateCard(pressed.channel, pressed.ts, textCard(message, color))
        .catch((e: unknown) => this.logger.warn('選択画面の表示の書き換えに失敗', e));
    } else {
      await this.bridge.postText(pressed.channel, message, pressed.threadTs).catch(() => undefined);
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.snapshots) {
      if (t > s.expiresAt) this.snapshots.delete(id);
    }
  }
}

/** 選択画面を Discord に出すカード。見出し・各選択肢の説明・選択メニュー */
export function buildChoiceCard(id: string, choice: ChoiceScreen): Card {
  const heading = redact(choice.title.join('\n')) || '(見出しなし)';
  const details = choice.options
    .map((o, i) => `${i === choice.cursor ? '▶' : '・'} ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    .join('\n');
  return {
    color: 'warn',
    title: '🖥 ターミナルが選択画面で止まっている',
    body: md(heading),
    code: redact(details),
    select: {
      id: customId(ACTION.SCREEN_PICK, id),
      placeholder: '選ぶ',
      options: choice.options.map((o, i) => ({
        label: redact(o.label),
        value: String(i),
        ...(o.description ? { description: redact(o.description) } : {}),
      })),
    },
  };
}
