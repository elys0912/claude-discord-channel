// `npm run check` から実行される、Discord のボットの疎通確認コマンド。
// トークンそのものは絶対に表示しない。ボットとして読み取りだけを行い、何も送信しない。
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import type { PermissionResolvable } from 'discord.js';
import { loadAccess, loadTokens, stateDir } from '../src/config.js';
import { errMessage } from '../src/errors.js';

/** ログインと準備を待つ上限 */
const READY_TIMEOUT_MS = 30_000;

/** チャンネルでボットに要る権限（設計書の「前提」） */
const CHANNEL_PERMISSIONS: [string, PermissionResolvable][] = [
  ['チャンネルを見る', PermissionFlagsBits.ViewChannel],
  ['メッセージを送る', PermissionFlagsBits.SendMessages],
  ['スレッドでメッセージを送る', PermissionFlagsBits.SendMessagesInThreads],
  ['公開スレッドを作成', PermissionFlagsBits.CreatePublicThreads],
  ['メッセージ履歴を読む', PermissionFlagsBits.ReadMessageHistory],
  ['リアクションを付ける', PermissionFlagsBits.AddReactions],
  ['ファイルを添付', PermissionFlagsBits.AttachFiles],
  ['埋め込みリンク', PermissionFlagsBits.EmbedLinks],
];

async function main(): Promise<void> {
  const dir = stateDir();
  console.log(`状態ディレクトリ: ${dir}`);

  let tokens;
  try {
    tokens = loadTokens(dir);
  } catch (e) {
    console.error(`[check] トークンの読み込みに失敗: ${errMessage(e)}`);
    process.exitCode = 1;
    return;
  }
  console.log('DISCORD_BOT_TOKEN: 形式 OK（値は表示しない）');

  // access.json は無くても続行する（サーバー・ユーザー・チャンネルの突き合わせができないだけ）
  let access: ReturnType<typeof loadAccess> | undefined;
  try {
    access = loadAccess(dir);
  } catch (e) {
    console.log(`access.json: 未作成、または読み込み不可（${errMessage(e)}）`);
  }

  // ブリッジと同じく Message Content Intent も要求する。Developer Portal で OFF なら、ブリッジの起動と同じくここでログインに失敗する
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('準備が時間内に終わらなかった')), READY_TIMEOUT_MS);
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await client.login(tokens.botToken);
    await ready;
  } catch (e) {
    console.error(`[check] ログインに失敗: ${errMessage(e)}`);
    if (/disallowed intents/i.test(errMessage(e))) {
      console.error('  Developer Portal の Bot で Message Content Intent が OFF になっている。ON にして');
    } else {
      console.error('  トークンが古い（リセットした）か、貼り間違えている可能性がある。Developer Portal の Bot でリセットし直して');
    }
    await client.destroy();
    process.exitCode = 1;
    return;
  }

  try {
    console.log('--- ボット ---');
    console.log(`名前: ${client.user?.tag ?? '(不明)'}  ID: ${client.user?.id ?? '(不明)'}`);
    console.log(`参加しているサーバー: ${client.guilds.cache.map((g) => `${g.name}（${g.id}）`).join(', ') || '(無し)'}`);
    if (!access) return;

    const guild = client.guilds.cache.get(access.guildId);
    if (!guild) {
      console.warn(`[check] 警告: access.json の guildId（${access.guildId}）のサーバーにボットが入っていない。招待 URL から招待して`);
      process.exitCode = 1;
      return;
    }
    console.log(`guildId: OK（${guild.name}）`);

    console.log('--- allowFrom ---');
    for (const userId of access.allowFrom) {
      try {
        const user = await client.users.fetch(userId);
        console.log(`${userId}: ${user.tag}`);
      } catch (e) {
        console.log(`${userId}: ユーザーが見つからない（${errMessage(e)}）`);
      }
    }

    console.log('--- channels ---');
    const me = guild.members.me ?? (await guild.members.fetchMe());
    for (const channelId of access.channels ?? []) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.isDMBased() || !('guild' in channel) || channel.guild.id !== guild.id) {
        console.log(`${channelId}: このサーバーのチャンネルとして見つからない`);
        continue;
      }
      const isForum = channel.type === ChannelType.GuildForum;
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement && !isForum) {
        console.log(`${channelId}: テキストチャンネルでもフォーラムでもない（種類=${ChannelType[channel.type]}）`);
        continue;
      }
      if (isForum) console.log(`${channelId}: フォーラム。投稿（スレッド）の中でボットにメンションして話しかける`);
      const perms = channel.permissionsFor(me);
      const missing = CHANNEL_PERMISSIONS.filter(([, flag]) => !perms.has(flag)).map(([name]) => name);
      console.log(`${channelId}: #${channel.name} ${missing.length === 0 ? '権限 OK' : `足りない権限: ${missing.join('、')}`}`);
    }
  } finally {
    await client.destroy();
  }
}

main().catch((e: unknown) => {
  console.error(`[check] 予期しないエラー: ${errMessage(e)}`);
  process.exitCode = 1;
});
