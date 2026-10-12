# claude-discord-channel

Discord のメッセージを、手元の PC で動いている Claude Code のセッションに中継する MCP channel サーバー（以下、ブリッジ）。
Claude の返信やリアクションを受け取るのも、実行許可に答えるのも、Discord の中で済む。Windows 専用。

[claude-slack-channel](https://github.com/elys0912/claude-slack-channel) の Discord 版。Slack に依存しない部分はそこから持ってきて、Discord とのやりとりだけを書き直した。

初めて使うときは、「必要なもの」から「起動」までを順に進めれば動かせる。その先は、必要になったときに [ドキュメント](#ドキュメント) の該当するファイルを開く。動かないときは [トラブルシューティング](docs/reference.md#トラブルシューティング) を見る。

## 概要

```
Discord（ボットとの DM / 許可したチャンネル）
   │  Gateway（ボットの側から WebSocket を張るので、ポート開放やトンネルは不要）
   ▼
claude-discord-channel（dist/src/main.js。node で動く）
   │  MCP（標準入出力、experimental の channels 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- 許可したユーザーからの DM と、指定したチャンネルでボットにメンションした発言が、Claude のセッションにそのまま届く。チャンネルでは、発言からスレッドを作ってそこで会話する。
- Claude は `reply` / `react` / `edit_message` の3つのツールで Discord に返信する。`.env` の設定しだいで、添付を保存する `download_file` と、手元のファイルを送る `send_file` も使える。手順の多い作業では、`progress` で TODO の進み具合のカードを出す。
- ファイルの書き込みなどの実行許可には、Discord のボタンか `yes xxxxx` / `no xxxxx` の返信で答える。
- 起動スクリプトは PowerShell で書いてある。

## 必要なもの

- Windows と Windows Terminal。VS Code の統合ターミナルは、動作を確かめていないので対象外。
- Node.js 22.12 以上。Claude Code が `node` コマンドでこのサーバーを起動するので、`node` と `npm` に **PATH を通しておく**。
- Claude Code。channels 機能と、channel 経由の実行許可の確認に対応した版が要る（2.1.289 以降で確かめた）。`claude.exe` は次の順に探す。
  1. PATH 上の `claude`
  2. VS Code 拡張に同梱の `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<版>-win32-x64\resources\native-binary\claude.exe`（複数あればバージョン番号が最大のもの）
- Claude のサブスクリプション。
- ボットを招待できる Discord サーバー（自分で作ったサーバーでいい）。ボットに DM を送るにも、ボットと同じサーバーにいる必要がある。

## セットアップ

### 0. clone してビルドする

```powershell
git clone https://github.com/elys0912/claude-discord-channel.git
cd claude-discord-channel
npm install
npm run build
```

### 1. Discord のボットを作る

[Discord Developer Portal](https://discord.com/developers/applications) で次の順に操作する。

1. **New Application** でアプリを作る。名前がボットの表示名になる。
2. **Bot** の画面で次を設定する。
   - **Reset Token** でトークンを発行する。これが **`DISCORD_BOT_TOKEN`** になる。表示されるのはこの1回だけなので、すぐ `.env` に貼る。リセットには多要素認証が要る。
   - **Privileged Gateway Intents** の **Message Content Intent** を ON にする。OFF だと、メッセージの本文が空で届く。
   - **Public Bot** を OFF にする。ほかの人が自分のサーバーにこのボットを入れられないようにするため。OFF にできないときは、先に **Installation** で **Install Link** を **None** にする。
3. **OAuth2** → **URL Generator** で、scope に `bot` を選び、次の権限を付けた URL を作る。その URL をブラウザで開き、使うサーバーにボットを招待する。

   | 権限 | 用途 |
   |---|---|
   | View Channels | チャンネルのメッセージを受け取る |
   | Send Messages / Send Messages in Threads | 返信と実行許可のカードの投稿 |
   | Create Public Threads | チャンネルの発言からスレッドを作る |
   | Read Message History | スレッドの元のメッセージと添付を読み直す |
   | Add Reactions | 受信と判定のリアクション |
   | Attach Files | 長い返信の全文（reply.md）と `send_file` |
   | Embed Links | 実行許可や通知のカード（embed） |

4. Discord の **ユーザー設定** → **詳細設定** で **開発者モード** を ON にする。自分のアイコン、サーバーのアイコン、使うチャンネルをそれぞれ右クリックし、**ID をコピー** でユーザー ID・サーバー ID・チャンネル ID を控える。どれも18〜20桁の数字。

### 2. `.env` と `access.json` を作る

トークンと許可リストは、**状態ディレクトリ**（既定は `%USERPROFILE%\.claude\channels\discord-bridge`。ブリッジの設定・ログ・ロックを置く場所）に置く。
次の2つのファイルをメモ帳で作り、**BOM なしの UTF-8**（メモ帳の「UTF-8」）で保存する。BOM 付きでも読めるが、勧めない。
公式の Discord プラグインの状態ディレクトリ（`channels\discord`）とは分けてある。場所を変えたいときは [環境変数](docs/reference.md#環境変数) を参照。

`.env`（ひな形: [config/env.example](config/env.example)。任意の設定もそこに並べてある）:

```
DISCORD_BOT_TOKEN=...
# 任意。書くと download_file ツールが使える（絶対パス）
# DOWNLOAD_DIR=C:\Users\<ユーザー名>\Downloads
# 任意。書くと send_file ツールが使える。確認なしで送ってよいフォルダー（絶対パスを ; で区切る）
# UPLOAD_DIRS=C:\Users\<ユーザー名>\Documents\share
```

書式は `KEY=VALUE`。`export ` の接頭辞、`"..."` / `'...'` の引用符、CRLF の改行も使える。`#` で始まる行はコメントになる。
値の後ろにもコメントを書ける。コメントとして無視されるのは、次の部分。

- 引用符なしの値: 空白に続く `#` 以降。`a#b` のように前に空白の無い `#` は、値の一部になる。
- 引用符付きの値: 閉じ引用符より後ろの `#` 以降。

`access.json`（ひな形: [config/access.example.json](config/access.example.json)）:

```json
{
  "guildId": "000000000000000000",
  "allowFrom": ["000000000000000000"],
  "channels": ["000000000000000000"]
}
```

- `guildId`: ボットを招待したサーバーの ID。ボットがこのサーバーに入っていないと起動しない。
- `allowFrom`: 話しかけてよいユーザーの ID。1件以上書き、重複は許さない。ここに無い相手からのメッセージとボタン操作は無視する。
- `channels`（省略可）: DM のほかに使うチャンネルの ID。重複は許さない。`guildId` のサーバーのテキストチャンネルにする。
  チャンネルで Claude に届くのは、ボットへのメンション（`@<ボット名>`）付きの発言と、ボットが関わっているスレッドへの発言だけ。詳しくは [メッセージ](docs/usage.md#メッセージ) を参照。

この2つは Claude に作らせず、手で作る。トークンと許可リストそのものなので、Claude に扱わせるとログや会話履歴に混ざる経路が増える。起動スクリプトも、ファイルがあるかを確かめるだけで中身は読まない。

### 3. 疎通を確かめる

```powershell
npm run check
```

ビルド（`precheck`）のあと、Discord にログインして次を表示する。トークンそのものは出さない。

- 状態ディレクトリの場所と、トークンの形が正しいか
- ボットの名前と ID、参加しているサーバー
- `guildId` のサーバーにボットが入っているか
- `allowFrom` に書いた ID の表示名
- `channels` のチャンネル名と、ボットに足りない権限

`access.json` がまだ無いか読めないときは、その旨を表示して先へ進む。

### 4. 起動するプロジェクトを登録する

[config/projects.example.json](config/projects.example.json) を `config\projects.json` にコピーし、Claude Code を起動したいプロジェクトを並べる。`projects.json` は git の管理外。

```json
{
  "projects": [
    { "name": "my-app", "path": "C:\\path\\to\\my-app" }
  ]
}
```

## 起動

Windows Terminal から実行する。

| コマンド | 動作 |
|---|---|
| `scripts\start.cmd` | `projects.json` の一覧から番号で選んで起動する（Enter で先頭、`q` で中止） |
| `scripts\start.cmd my-app` | `projects.json` の name で指定して起動する |
| `scripts\start.cmd C:\path\to\app` | パスで直接指定して起動する |
| `scripts\start.cmd my-app -PermissionMode auto` | 実行許可のモードを変える（[権限の設計](docs/security.md#権限の設計)） |
| `scripts\start.cmd -DryRun` | 起動せずに、実行するコマンドラインだけを表示する。ビルドは省き、`.env` / `access.json` が無くても警告だけ出す |
| `scripts\start.cmd C:\path\to\app -StateDir <dir> -SettingsFile <file>` | 別のボットと設定で、もう1つのセッションを起動する（[セッションを並べる](docs/usage.md#セッションを並べる)） |

- 起動すると experimental channels の警告ダイアログが出る。起動スクリプトが画面を見張って、**「1」（I am using this for local development）** を自動で選ぶ。90秒たってもダイアログが残っていたら、手で「1」を選ぶ。
- 初めて使うフォルダーでは、「このフォルダーを信頼するか」の確認が先に出る。これには自動で答えないので、手で選ぶ。
- `dist` が無いときだけ自動でビルドする。`git pull` で更新したら、古い `dist` のまま起動しないよう、**`npm run build` を手で実行する**。
- 起動したら、Discord でボットに DM を送るか、`channels` に書いたチャンネルでボットにメンションして話しかける。

## 使い方の要点

詳しい挙動は [docs/usage.md](docs/usage.md) にまとめてある。

- ボットに話しかけるとメッセージが手元のセッションに届き、届いた印に 👀 が付く。Claude が考えている間は「入力中…」が出る。作業の TODO があれば、進み具合のカードも出る。
- Claude の返事は、DM なら元のメッセージへの返信として、チャンネルなら元の発言から作ったスレッドに届く。
- Discord 側の会話はすべて1つのセッションの同じ文脈を共有する。
- ほかの人の発言も、右クリックの **アプリ** → **Claude に渡す** で Claude に渡せる（[右クリックで Claude に渡す](docs/usage.md#右クリックで-claude-に渡す)）。
- テキストの添付（長文を貼ったときの `message.txt` など）は、中身を本文に足して渡す。それ以外の添付は名前・種類・サイズだけを渡し、中身が要るときは Claude が `download_file` で取りに行く。
- 許可リストに無い操作を Claude が実行しようとすると、確認のカードが届く。**Allow / Deny** のボタンか `yes xxxxx` / `no xxxxx` の返信で答える。30分答えなければ自動で拒否する。
- 確認のカードの **♾ 今後も許可** を押すと、同じ種類の操作を次回の起動から確認なしで通せる。
- 5分たっても Claude から何も返ってこないと、警告が出る。
- ボットのステータス（メンバー一覧の名前の下）に、Claude の状態（待機中・作業中・実行許可待ち・使用量の上限）が出る。
- `!` で始まる次のコマンドは Claude に渡さず、ブリッジ自身が処理する。Claude が止まっていても使える。`!` の代わりに `/` で始めると、入力欄の補完から選べるスラッシュコマンドになる（`/restart` の `force`、`/keepalive` の `mode` は引数で選ぶ）。

| コマンド | 動作 |
|---|---|
| `!help` | コマンドの一覧を返す |
| `!status` | ブリッジの状態（接続、返事待ち、回答待ちの実行許可、つなぎ止め、直近の hook）を返す |
| `!screen` | ターミナルの画面を見る。選択画面なら、メニューで選択肢を選べる |
| `!stop` | Esc を送って、Claude の今の作業を中断する |
| `!keepalive` / `!keepalive on` / `!keepalive off` | キャッシュのつなぎ止めの状態を見る・切り替える |
| `!rules` | 「今後も許可」で足したルールを一覧し、ボタンで消せる |
| `!compact` | `/compact` を送り、会話を要約して縮める |
| `!clear` | `/clear` を送り、会話を捨てて新しい会話にする |
| `!restart` | `/exit` を送り、同じ会話のまま再起動する。警告ダイアログには自動で答える |
| `!restart force` | Claude Code を強制終了してから再起動する（応答しないとき用） |
| `!lock` | 「このセッション中は全部許可」を解除する（有効にしたボットだけ） |

Claude Code 側の出来事（使用量の上限、ターミナル側の入力待ち、セッションの開始と終了など）は、hook を通して Discord に通知する。

## セキュリティの要点

Discord から手元の PC を操作する以上、何をどこまで許すかが一番の注意点になる。詳しくは [docs/security.md](docs/security.md) を参照。

- 送信者は Discord のユーザー ID（`allowFrom`）とサーバー ID（`guildId`）で判定する。表示名やユーザー名は使わない。
- Discord のセッションは、ユーザー設定（`~/.claude/settings.json`）を読まない設定で起動する。普段使いのために入れた緩い許可を、Discord からの指示に効かせないため。権限は [config/channel-settings.json](config/channel-settings.json) で絞る。
- 主に次のリスクが残る（すべては [残るリスク](docs/security.md#残るリスク) にある）。
  - 許可ユーザーの Discord アカウントが乗っ取られると、手元の Claude をそのまま操作される。
  - 確認で許可した操作は、その内容どおりに実行される。確認の中身はよく読む。
  - Discord のメッセージ・リポジトリの中身・Web ページに仕込まれた指示（プロンプトインジェクション）を、Claude が実行しようとすることがある。最後の防御は確認での拒否になる。
- トークンが漏れたら、すぐ Developer Portal でリセットする。手順は [トークンが漏れたとき](docs/security.md#トークンが漏れたとき) にある。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/usage.md](docs/usage.md) | 各機能が Discord でどう動くかを知りたいとき（メッセージ、添付、実行許可、今後も許可、画面の確認、再起動、hook の通知、セッションを並べる など） |
| [docs/security.md](docs/security.md) | Discord から実行できる範囲を変える前と、トークンが漏れたとき |
| [docs/reference.md](docs/reference.md) | 期限や上限などの値、設定ファイルと環境変数を調べるとき。動かないときのトラブルシューティング |
| [docs/development.md](docs/development.md) | このリポジトリに手を入れるとき（コマンド、テスト、ファイル構成） |

## ライセンス

[MIT](LICENSE)
