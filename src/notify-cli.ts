// 単発の知らせ（dist/src/notify-cli.js <本文>）。ブリッジが動いていないときに start.ps1 が呼ぶ
// （claude.exe が想定外の終了を繰り返し、起動し直しを諦めたとき。ブリッジは claude.exe と一緒に止まっているので、ほかに知らせる手段が無い）。
// 状態ディレクトリの .env と access.json を読み、許可ユーザー全員の DM に REST で送る。Gateway にはつながない。失敗したら exit 1。
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { loadAccess, loadTokens, stateDir } from './config.js';
import { errMessage } from './errors.js';

/** 使う REST の操作（テストでは差し替える） */
export interface NoticeRest {
  post(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

/** 許可ユーザー全員の DM に text を送り、送れた数を返す。rest はテスト用（省略時は .env のトークンの本物の REST） */
export async function sendNotice(dir: string, text: string, rest?: NoticeRest): Promise<number> {
  const tokens = loadTokens(dir);
  const access = loadAccess(dir);
  const client = rest ?? new REST().setToken(tokens.botToken);
  let sent = 0;
  for (const userId of access.allowFrom) {
    try {
      const dm = (await client.post(Routes.userChannels(), { body: { recipient_id: userId } })) as { id?: unknown };
      if (typeof dm.id !== 'string') continue;
      await client.post(Routes.channelMessages(dm.id), { body: { content: text } });
      sent++;
    } catch (e) {
      process.stderr.write(`[discordbridge notify] DM に送れなかった user=${userId}: ${errMessage(e)}\n`);
    }
  }
  return sent;
}

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(' ').trim();
  if (text === '') {
    process.stderr.write('使い方: node dist/src/notify-cli.js <本文>\n');
    process.exit(1);
  }
  try {
    const count = await sendNotice(stateDir(), text);
    process.exit(count > 0 ? 0 : 1);
  } catch (e) {
    process.stderr.write(`[discordbridge notify] 送れなかった: ${errMessage(e)}\n`);
    process.exit(1);
  }
}

// 直接起動されたときだけ動く（テストや他モジュールからの import では動かない）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
