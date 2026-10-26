# 設定リファレンスとトラブルシューティング

設定値を調べるときと、動かないときに開く文書。困っているなら、[トラブルシューティング](#トラブルシューティング) から読めばいい。

## 用語

| 用語 | 意味 |
|---|---|
| ブリッジ | このリポジトリのサーバー（`dist/src/main.js`）。Claude Code が MCP サーバーとして起動し、Discord との間でメッセージを中継する |
| 状態ディレクトリ | ブリッジの設定・ログ・ロックを置く場所。既定は `%USERPROFILE%\.claude\channels\discord-bridge`。`DISCORD_CHANNEL_STATE_DIR` か、起動スクリプトの `-StateDir` で変えられる |
| 縮退モード | ロックが取れなかったブリッジが入るモード。Discord に接続せず、ツールはすべてエラーを返し、実行許可も Discord に出さない。同じ状態ディレクトリで2つ目のセッションを起動すると、こうなる。縮退中も30秒ごとにロックを取り直し、取れたら（先のセッションが終わったら）通常のブリッジに戻る。戻るときに `.env` と `access.json` を読み直す（縮退の間に直した設定も効く）。戻ったことは Discord に投稿せず、ログにだけ書く |
| 許可リスト（allow / ask / deny） | Claude Code の権限ルール。allow は確認なしで通す、ask は毎回確認する、deny は実行させない。評価は deny → ask → allow の順 |
| hook | Claude Code が出来事（セッションの開始、応答の失敗など）のたびに実行するコマンド。ブリッジは hook の記録を読んで Discord に通知する |
| 再起動フラグ | `!restart` が状態ディレクトリに置く `restart.flag`。起動スクリプトは、claude.exe の終了時にこれがあれば再起動する |
| カード | 実行許可や通知に使う、色の帯と見出しの付いたメッセージ（Discord の embed）。ボタンやメニューを付けることがある |

## ファイル

| ファイル | 場所 | 内容 |
|---|---|---|
| `.env` | 状態ディレクトリ | `DISCORD_BOT_TOKEN` と任意の設定（下記の「`.env` の設定」） |
| `access.json` | 状態ディレクトリ | `guildId`、`allowFrom`（ユーザー ID の配列）、`channels`（チャンネル ID の配列、省略可）、`ciWebhooks`（CI の通知として渡す webhook の ID の配列、省略可）。ID はどれも数字の文字列。ほかのキーがあるとエラーにする |
| `allow-extra.json` | 状態ディレクトリ | Discord の「今後も許可」で足したルール（`{"allow": [...]}`）。ブリッジが書き、起動スクリプトが今の方式で作れるものだけを allow に足す（作れないものは起動の通知で知らせる。ファイルは書き換えない） |
| `restart.flag` | 状態ディレクトリ | 再起動フラグ（`{"at": ..., "sessionId": ...}`）。`start.ps1` はこれを消してから、`--resume <sessionId>`（会話の記録が無ければ新しい会話）で再起動する |
| `hooks.jsonl` | 状態ディレクトリ | Claude Code の hook が追記する出来事の記録（1行に1つの JSON）。ブリッジが読んで Discord に通知する。1MB を超えると `hooks.jsonl.1` に退避する |
| `logs\bridge.log` | 状態ディレクトリ | ブリッジのログ（下記） |
| `logs\dialog-answer.log` | 状態ディレクトリ | 起動・`!restart` のたびに、警告ダイアログに自動で答えたかどうか（答えた・キーを送れなかった・時間切れ） |
| `instance.lock` | 状態ディレクトリ | 多重起動を防ぐロック。自動で作られ、終了時に消える |
| `projects.json` | `config\`（git の管理外） | `projects`: `{ name, path }` の配列。起動時の選択肢になる |
| `extra-mcp.json` | `config\`（git の管理外） | Discord のセッションで一緒に使う MCP サーバー。`.mcp.json` と同じ `mcpServers` の形で書く（ひな形: `extra-mcp.example.json`）。登録したサーバーのツールは確認なしで実行される |
| `channel-settings.json` | `config\` | Discord のセッション専用の Claude Code の設定 |
| `mcp.json` | `%TEMP%\claude-discord-channel\<状態ディレクトリ名>-<ハッシュ>\` | 起動スクリプトが毎回作る MCP の設定 |
| `channel-settings.merged.json` | `%TEMP%\claude-discord-channel\<状態ディレクトリ名>-<ハッシュ>\` | `channel-settings.json` に、追加の allow と hook を足した設定。起動スクリプトが毎回作る |

## `.env` の設定

`DISCORD_BOT_TOKEN` だけが必須。ほかは書かなければ既定の動きになる。値が範囲の外だったり形が違ったりすると、起動時にエラーにする（メッセージにトークンの値は含めない）。

| キー | 既定 | 内容 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | （必須） | Developer Portal の Bot で発行したトークン |
| `DOWNLOAD_DIR` | なし | 添付の保存先（絶対パス）。書くと `download_file` が使える |
| `UPLOAD_DIRS` | なし | 確認なしで送ってよいフォルダー（絶対パスを `;` で区切る）。書くと `send_file` が使える |
| `UPLOAD_MAX_MB` | 10 | 送るファイル1つの上限（1〜100） |
| `INLINE_TEXT_MAX_KB` | 100 | テキストの添付を本文に差し込む1ファイルの上限（0〜1024）。`0` で差し込まない |
| `LONG_REPLY_CHARS` | 6000 | これを超える返信は冒頭だけを本文にして、全文を `reply.md` で添付する（0〜100000）。`0` で常に分けて送る |
| `SESSION_ALLOW_ALL` | off | `on` / `true` / `1` で、実行許可に「このセッション中は全部許可」ボタンを出す。on / off 以外の値は off にし、ログに警告を出す |
| `KEEPALIVE` | on | キャッシュのつなぎ止め。`off` で無効 |
| `KEEPALIVE_AFTER_MIN` | 55 | 最後の応答から合図を送るまでの分数 |
| `KEEPALIVE_MAX` | 6 | 最後の会話から合図を送る回数の上限 |
| `KEEPALIVE_QUIET` | `01:00-07:00` | 合図を送らない時間帯（`HH:MM-HH:MM`）。空なら時間帯なし |
| `TODO_PROGRESS` | on | TODO の進み具合のカードを出す `progress` ツールを出すか。`off` で出さない |

## 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_CHANNEL_STATE_DIR` | 状態ディレクトリを変える（既定は `%USERPROFILE%\.claude\channels\discord-bridge`）。変えたら deny も書き換える（[権限の設計](security.md#権限の設計)） |
| `DISCORD_CHANNEL_LOG_LEVEL` | ログのレベル（debug / info / warn / error。既定は info）。`start.ps1` を実行するシェルで設定すれば、ブリッジに渡す（[ログ](#ログ)） |
| `DISCORD_CHANNEL_REPLY_TIMEOUT_MIN` | 無応答の警告を出すまでの分数（既定は 5、小数も可）。`0` で無効になる |
| `DISCORD_CHANNEL_SETTINGS_FILE` / `DISCORD_CHANNEL_SESSION_TAG` | 起動スクリプトが `mcp.json` 経由でブリッジに渡す。手で設定する必要はない |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | 起動スクリプトが `false` を設定する。手で設定する必要はない |
| `DISCORD_CHANNEL_PLACEHOLDER` | `1` なら、サーバーはツールを持たずに待つだけになる。起動スクリプトが local スコープに登録する `discordbridge` にだけ付ける（[権限の設計](security.md#権限の設計)）。手で設定する必要はない |

`DISCORD_CHANNEL_STATE_DIR` は**絶対パスで指定する**。相対パスだと、プロセスごとに基準が違うので参照先がずれることがある。

トークンは環境変数からは読まない。

## ログ

- 出力先は `logs\bridge.log` と stderr。
- レベルの既定は info。環境変数 `DISCORD_CHANNEL_LOG_LEVEL`（debug / info / warn / error）で変えられる。`start.ps1` を実行するシェルで設定すれば、ブリッジに渡す。知らない値なら info のままにし、ログに警告を出す。
- 5MB を超えると `bridge.log.1` に退避する。残すのは1世代だけで、古い `.1` は上書きする。
- Gateway の接続の変化は `gateway: ready` / `resumed` / `reconnecting` として出る。回復できない理由（トークンの無効化・Intent の不許可など）で閉じたときは `gateway: 回復できない切断で、再接続しない` を error で出し、手元のセッションにも `kind="bridge_error"` で知らせる（Claude がターミナルに書く）。

## 固定値

| 項目 | 値 |
|---|---|
| 1通の長さ | 1900文字ごとに分ける（Discord の上限は2000文字） |
| 実行許可の有効期限 | 30分 |
| 無応答の警告 | 5分（`DISCORD_CHANNEL_REPLY_TIMEOUT_MIN` で変えられる） |
| 画面の選択肢メニューの有効期限 | 5分 |
| 許可リストへの追加の提案・`!rules` の一覧の有効期限 | 10分 |
| `send_file` の確認の有効期限 | 10分 |
| 覚えておくスレッド / メッセージの場所 | 500件 / 2000件（古いものから忘れる。動いている間だけ） |
| 「入力中…」 | 8秒ごとに出し直し、15分で打ち切る |
| ボットのステータスの更新 | 5秒ごとに状態を見て、変えるのは15秒に1回まで |
| テキストの添付の差し込み | 1ファイル100KB、1メッセージ3ファイル・合計200KBまで。1ファイルの取得は10秒で諦める（その添付は `download_file` で取れる） |
| 添付のダウンロード / 展開 | 1GB・30分まで / 合計4GB・10万ファイルまで |
| ロックのハートビート / 失効 | 10秒ごとに更新する。30秒間更新が無いか、ハートビートが現在時刻より5秒を超えて未来なら失効とみなす。持ち主のプロセスが死んでいれば、失効前でも取る。更新の前に読み直し、別のブリッジに取られていたら（スリープ明けなど）書き戻さずに後片付けして終わる |
| ロックが取れないときの取り直し | 起動時に最大10秒（0.5秒間隔）。取れなければ縮退モードに入り、その後は30秒ごとに取り直す |
| Discord にログインして準備ができるまでの待ち時間 | 30秒（過ぎたら起動を諦める） |
| `hooks.jsonl` を読む間隔 / 起動時に読み直す範囲 | 1.5秒 / 起動の30秒前以降（そのうち、最後のセッションが始まった後の分だけ） |
| `!restart` で `/exit` を送ってから「まだ終了していない」と通知するまで / 再起動フラグを消すまで | 20秒 / 60秒 |
| 警告ダイアログへの自動応答の待ち時間 | 90秒（`start.ps1` の `$DevChannelDialogTimeoutSec`） |

Gateway の再接続は discord.js に任せている。

## トラブルシューティング

まず `logs\bridge.log` を見る（トークンは伏せてある）。接続状態は、`!status` か、セッションの中で `/mcp` を実行して `discordbridge` の状態を見れば分かる。

### 起動できない・接続できない

| 症状 | 対処 |
|---|---|
| 起動スクリプトが `claude.exe が見つからない` と出す | PATH に `claude` を通すか、VS Code の Claude Code 拡張を入れる |
| 起動したまま進まない | 初めて使うフォルダーなら、「このフォルダーを信頼するか」の確認で止まっている。ターミナルで選ぶ |
| `/mcp` で `discordbridge` が failed になる | `node` に PATH が通っているか、`npm run build` を済ませたかを確かめる。理由は stderr とログに出る |
| `.env が見つからない` / `access.json の検証に失敗` | 状態ディレクトリの場所、ファイル名（`.env.txt` になっていないか）、JSON の形式、ID が数字の文字列になっているかを確かめる |
| `DISCORD_BOT_TOKEN の形が不正` | トークンを貼り間違えている。Developer Portal の **Bot** → **Reset Token** で発行し直して貼る |
| ログインに失敗する（`An invalid token was provided` など） | トークンが古い（リセットした）か、貼り間違えている。`npm run check` で確かめ、発行し直す |
| `Used disallowed intents` / `Privileged intent provided is not enabled or whitelisted` | Developer Portal の **Bot** で **Message Content Intent** が OFF になっている。ON にする |
| `ボットが access.json の guildId のサーバーに入っていない` | ボットをそのサーバーに招待したか、`guildId` が合っているかを `npm run check` で確かめる |
| `許可ユーザーの DM を 1 つも開けず、access.json の channels も無い` | `allowFrom` のユーザーがボットと同じサーバーにいるか確かめる。同じサーバーにいないと DM を開けない |
| ツールが「別のインスタンスが動いている」エラーを返す | 縮退モードで動いている。同じ状態ディレクトリで、別のセッションがブリッジを使っている。先のセッションを終了すれば、30秒以内に通常のブリッジに戻る（再起動は要らない） |
| 前のセッションを落とした直後に起動したら、縮退モードになった | 新しいブリッジは起動時に最大10秒ロックを取り直す。それでも縮退になるなら、前のブリッジがまだ生きている（固まっている）可能性がある。タスクマネージャーで古い `node.exe`（`dist\src\main.js`）が残っていないか確かめ、止めてから再起動する。30秒以上待ってから起動し直してもいい |
| 更新したのに挙動が変わらない | `npm run build` を実行してから再起動する |
| スリープから復帰したあと反応しない | discord.js が自動で再接続する。ログに `gateway: resumed` が出ていなければ、しばらく待ってから再起動する |

### メッセージに反応しない

| 症状 | 対処 |
|---|---|
| ターミナルに `server:discordbridge · no MCP server configured with that name` と出て、Discord から話しかけてもセッションに届かない | 作業フォルダーの local スコープに `discordbridge` が登録されていない。起動スクリプトが起動前に登録するので、起動時の警告を確かめる。登録できていなければ、警告に出たコマンドを作業フォルダーで実行してから再起動する（[権限の設計](security.md#権限の設計)） |
| DM を送っても 👀 が付かない | `allowFrom` に自分の ID があるか、DM の相手がこのボットかを確かめる。ログの `受信を破棄 reason=...` は debug レベルなので出ない |
| チャンネルで話しかけても 👀 が付かない | 次を順に確かめる。(1) ボットにメンションしたか。ボットが関わっているスレッドならメンションは要らないが、再起動した後はもう一度メンションする。(2) `access.json` の `channels` に、そのチャンネルの ID があるか（スレッドの ID ではなく親チャンネルの ID）。(3) `npm run check` で、そのチャンネルの権限が足りているか |
| 👀 は付いたのに返事が来ない | 5分たつと、無応答の警告が出る。**🖥 画面を確認**（または `!screen`）で、ターミナルが選択画面で止まっていないかを見る |
| チャンネルでスレッドが作られず、元の発言への返信になる | ボットに Create Public Threads の権限が無い。ログに `スレッドを作れなかった` が出る。`npm run check` で権限を確かめる。一度作れなかった発言には、ブリッジを起動し直すまで作り直さない（権限を足したら、新しい発言で話しかける） |
| MCP のツールに「つながっていない」と言われる | Discord のセッションは、`extra-mcp.json` に書いたサーバーしか読み込まない（[普段の MCP サーバーは読み込まれない](usage.md#普段の-mcp-サーバーは-discord-のセッションでは読み込まれない)） |
| `download_file` / `send_file` が無いと言われる | `.env` に `DOWNLOAD_DIR` / `UPLOAD_DIRS` を書き、起動し直す。起動時のログの `download=on` / `upload=N件` で確かめられる |

### 実行許可がおかしい

| 症状 | 対処 |
|---|---|
| 実行許可のカードが Discord に来ない | 縮退モードになっていないか確かめる。ログに `permission_request の request_id が不正なので deny を返す` があれば、Discord に出さずに自動で deny している |
| 実行許可が勝手に拒否された | 次のどれかで自動で deny している。30分答えが無かった（期限切れ）、どこにも投稿できなかった（ログに `permission_request をどの DM にも配信できなかった`）、ブリッジが終了した |
| ボタンを押すと「インタラクションに失敗しました」と出る | ブリッジが止まっているか、3秒以内に応答できなかった。`!status` とログを確かめる |

### 再起動・通知・画面の操作が動かない

| 症状 | 対処 |
|---|---|
| `!restart` したのに戻ってこない | `!status` で状態を見る。`/exit` が効かなければ `!restart force` を使う。警告ダイアログで止まっているなら、`dialog-answer.ps1` が探す文字列（`start.ps1` の `$DevChannelDialogPattern` / `$DevChannelChoicePattern`）が画面の文言と合っていない可能性がある。手元で画面を見て直す |
| 使用量の上限や入力待ちの通知が Discord に来ない | 状態ディレクトリの `hooks.jsonl` が増えているかを見る。増えていなければ hook が動いていない。`%TEMP%\claude-discord-channel\<状態ディレクトリ名>-<ハッシュ>\channel-settings.merged.json` に `hooks` があるか、`node` に PATH が通っているかを確かめる |
| `!screen` / `!restart` / `!compact` / `!stop` / 警告ダイアログへの自動応答がどれも動かない | PowerShell が Constrained Language Mode だと、`console.ps1` の `Add-Type` が失敗する。`powershell -NoProfile -Command '$ExecutionContext.SessionState.LanguageMode'` の結果が `FullLanguage` かを確かめる。それ以外なら、その PC ではこれらの機能を使えない |

ここで解決しないときは、`logs\bridge.log` の該当する行（トークンは伏せてある）を添えて、GitHub の Issues に書いてほしい。
