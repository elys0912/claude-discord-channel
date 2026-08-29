# 権限の設計とセキュリティ

Discord から実行できる範囲を変える前（`-PermissionMode` を変える、`extra-mcp.json` や「今後も許可」でルールを足す、`UPLOAD_DIRS` を広げる）に読む文書。
起動フラグと専用の設定ファイルで何を絞っているか、それでも残るリスク、トークンが漏れたときの手順を書いてある。

## 権限の設計

起動スクリプトは `claude.exe` を次のフラグで起動する。

> ここに書いたフラグ・設定・モードの効果（評価順や制限を含む）は、Claude Code の仕様に基づく説明で、このリポジトリのコードやテストでは確かめていない。
> コードで確かめられるのは、起動スクリプトがこれらのフラグを渡すことと、`channel-settings.json` の中身まで。

| フラグ | 目的 |
|---|---|
| `--mcp-config %TEMP%\claude-discord-channel\<状態ディレクトリ名>\mcp.json` | `discordbridge` サーバーを読み込む。clone 先の絶対パスと状態ディレクトリを含むので、起動のたびに作り直す |
| `--strict-mcp-config` | `--mcp-config` 以外の MCP サーバー（ユーザー設定やプロジェクトの `.mcp.json`）を読み込まない。Discord のセッションでも使うサーバーは `config\extra-mcp.json` に書く（[使い方の詳細](usage.md#普段の-mcp-サーバーは-discord-のセッションでは読み込まれない)） |
| `--no-chrome` | Claude in Chrome との連携を無効にする。有効なままだと、ブラウザ操作が必要になったときに選択画面がターミナルに出て、Discord に中継されないまま止まる |
| `--setting-sources project,local` | ユーザー設定（`~/.claude/settings.json`）を読まない。普段使いのために入れた緩い許可（`Bash(*)` など）を使って、Discord からの指示が確認なしで実行されるのを防ぐ |
| `--settings config\channel-settings.json` | Discord のセッション専用の設定を重ねる。managed（組織の管理設定）を除けば、どの設定よりも優先される。`extra-mcp.json` のサーバーや「今後も許可」のルールがあるときは、それらを allow に加えた `channel-settings.merged.json`（`%TEMP%\claude-discord-channel\<状態ディレクトリ名>\` に作る）を代わりに渡す。`-SettingsFile` で別の設定ファイルに替えられる |
| `--permission-mode default` | 許可リストに無い操作は毎回確認する。`-PermissionMode` で変えられる（下記） |
| `--dangerously-load-development-channels server:discordbridge` | experimental の channels 機能を有効にする |

起動する `claude.exe` にだけ、環境変数 `ENABLE_CLAUDEAI_MCP_SERVERS=false` を渡して、claude.ai 側のコネクターを読み込まないようにしている。
また、Claude Code のセッションの中（VS Code 拡張など）から起動すると、親のセッションの目印になる環境変数（`CLAUDECODE` など）が引き継がれる。これがあると子セッションとして扱われ、`reply` ツールが使えなくなるので、消してから起動する。

**作業フォルダーの local スコープにも `discordbridge` を登録する。** Claude Code 2.1.289 から、`--dangerously-load-development-channels server:<名前>` は、設定ファイル（user・project・local など）に同じ名前の MCP サーバーが無いと受け付けない。`--mcp-config` で渡したサーバーは数に入らない。
そこで起動スクリプトは、起動の前に `claude mcp add -s local discordbridge -e DISCORD_CHANNEL_PLACEHOLDER=1 -- node <clone 先>\dist\src\main.js` を作業フォルダーで実行する（登録済みなら何もしない）。登録先は `%USERPROFILE%\.claude.json` の、その作業フォルダーの欄。
Discord のセッションは `--strict-mcp-config` なので、この登録は読み込まれず、`--mcp-config` のサーバーが動く。普段のセッションでは読み込まれるが、`DISCORD_CHANNEL_PLACEHOLDER=1` のときのサーバーはツールを持たず、Discord にも状態ディレクトリにも触らない。
要らなくなったら、作業フォルダーで `claude mcp remove -s local discordbridge` を実行する。

**プロジェクト側の設定は効く。** `--setting-sources project,local` なので、作業フォルダーの `.claude/settings.json` / `.claude/settings.local.json` の allow はそのまま有効になる。
緩い allow を入れたプロジェクトでは、Discord のセッションを起動しないようにする。Claude 自身が `.claude/` 以下を書き換えて許可を広げることは、deny で禁止してある。

### `-PermissionMode`

| 値 | 動作 |
|---|---|
| `default`（既定） | 許可リストに無い操作は毎回確認する |
| `auto` | 分類器が安全と判断した操作は、確認なしで通す |
| `acceptEdits` | 作業フォルダーの中のファイル編集を**確認なしで**通す。Discord からの指示だけでファイルが書き換わるので、使うのは信頼できる相手とだけにする |
| `plan` | 読み取りと計画だけを行い、変更はしない |

どのモードでも deny のルールは効く。`bypassPermissions` への切り替えは、`channel-settings.json` で禁止している。

### [config/channel-settings.json](../config/channel-settings.json)

- **allow**: プロジェクトの中の読み取り（`Read(./**)`）、`Glob` / `Grep`、このサーバーの `reply` / `react` / `edit_message` / `send_file` / `progress`。
  - `download_file` は入れていない。手元のフォルダーに書き込むので、毎回確認する。
  - `send_file` は入れてある。送ってよいかはブリッジ自身が判定する（[ファイルの送信](usage.md#ファイルの送信send_file)）。
  - git コマンドは `git status` も allow に入れていない。`git diff --no-index` などで、プロジェクトの外のファイルを読めるため。
- **deny**:
  - 読み取りの禁止（`Read(...)`）
    - Claude Code の設定と状態: `~/.claude/**`（状態ディレクトリの `~/.claude/channels/**` を含む）、`~/.claude.json`
    - 認証情報: `~/.ssh/**`、`~/.git-credentials`、`~/.aws/**`、`~/.config/gh/**`、`~/.npmrc`、`~/.docker/**`
    - 秘密のファイル: どこにあっても `.env*`、`*.pem`、`*.key`
  - 編集の禁止（`Edit(...)`）: 状態ディレクトリの `~/.claude/channels/**`、プロジェクトの `./.claude/**`
  - 破壊的な git 操作: `git push --force` / `-f`、`git reset --hard`（Bash と PowerShell の両方）
- **`defaultMode`**: `default`。起動スクリプトの `--permission-mode` でも指定する。
- **`disableBypassPermissionsMode`**: `bypassPermissions` モードへの切り替えを禁止する。
- **`disableClaudeAiConnectors`**: claude.ai 側のコネクターを読み込まない。
- **`language`**: `japanese`

deny は常に allow より優先される（評価順は deny → ask → allow）。

> **状態ディレクトリを移したとき**: 既定の場所は `Read(~/.claude/channels/**)` / `Edit(~/.claude/channels/**)` で守られている。
> `DISCORD_CHANNEL_STATE_DIR` で別の場所にしたときは、そのパスの `Read(...)` / `Edit(...)` を deny に自分で足す。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような間接的な呼び出しまでは塞がない（Claude Code のパターン照合の既知の制限）。
> `sh -c` 自体は確認待ちになるが、確認で許可すれば実行される。確認の中身はよく読む。

## セキュリティ

- 送信者は、Discord のユーザー ID（`allowFrom`）とサーバー ID（`guildId`）で判定する。表示名やユーザー名では判定しない。
  - サーバーのメッセージは、`guildId` のサーバーの、`channels` に書いたチャンネル（とその中のスレッド）のものだけを扱う。
  - DM は、サーバーに属さない1対1の DM だけを扱う。
  - ボタンとメニューの操作では、押した人が `allowFrom` にいること、押された場所が許可ユーザーとの DM か `channels` のチャンネルであること、押されたのがこのボット自身のメッセージであることを確かめる。
- トークンは状態ディレクトリの `.env` にだけ置く。環境変数からは読まず、MCP の設定ファイルにも書かない。
- ログに出るトークン（Discord のボットトークンの形をした文字列、webhook の URL の秘密の部分、`Bot ...` / `Bearer ...` の認証ヘッダー）は伏せ字にする。
- 送信するテキストのメンション（`@everyone` / `@here` / ロール / ユーザー）は、どれも通知しない。返信先の人への通知も出さない。
- 添付を取りに行く先は Discord の CDN だけで、トークンは付けない。
- Discord から届くメッセージは信頼できない入力として扱い、上の権限の設計で実行できる範囲を絞っている。

### 複数のユーザーで使うとき

`allowFrom` の全員が、同じセッションを共有する。実行許可のカードは、最後に話しかけた場所に届く（DM 全体に配ったときは、全員の DM に届く）。
**誰か1人が答えれば、それで決まる**。ほかの人に配信したカードの表示も、結果に変わる。
チャンネルでは、`allowFrom` に無いメンバーにも、実行しようとしているコマンドの内容が見える。`!screen` の画面の内容や選択肢のメニューも、同じスレッドに出る。チャンネルの閲覧権限を、使う人だけに絞っておく。

ユーザーを外すときは、`access.json` の `allowFrom` からその ID を消して保存し、セッションを再起動する。動いているサーバーは `access.json` を読み直さない。

### 残るリスク

次のリスクは、使う側が承知しておく。

- 許可ユーザーの Discord アカウントが乗っ取られると、手元の Claude をそのまま操作される。Discord アカウントの多要素認証を有効にしておく。
- 確認で許可した操作は、その内容どおりに実行される。確認の内容はよく読む。
- 「今後も許可」で足したルールは、以後そのプレフィックスのコマンドを確認なしで実行させる（例: `Bash(git status:*)` は、`git status` に続く引数を問わない）。
  危険なコマンドは除外しているが、要らなくなったら `!rules` から消す。
- `extra-mcp.json` に登録した MCP サーバーのツールは、確認なしで実行される。
- `UPLOAD_DIRS` の中のファイルは、確認なしで Discord に送られる。私物の混ざるフォルダー（Downloads や Documents 全体など）は指定せず、送る用のフォルダーを作る。
- `!screen` の選択肢のメニューで、ターミナルの選択画面に Discord から答えられる（信頼の確認などの画面も含む）。
- Discord のメッセージ・添付・リポジトリの中身・Web ページに仕込まれた指示（プロンプトインジェクション）を、Claude が実行しようとすることがある。最後の防御は確認での拒否になる。
- 右クリックの「Claude に渡す」では、許可ユーザー以外が書いた発言も Claude に届く。転送の印を付け、データとして扱うよう指示してあるが、仕込まれた指示に従ってしまう可能性は残る。知らない人の発言を渡すときは、何をしてほしいかを続けて書く。
- テキストの添付は、中身がそのまま本文として Claude に届く。中身は「データ」として扱うよう MCP の instructions で指示してあるが、仕込まれた指示に従ってしまう可能性は残る。
- `Read(./**)` があるので、deny に当たらないプロジェクトの中のファイルは確認なしで読まれ、その内容が Discord に返信されることがある。
- 会話の内容（コードやログを含む）は、Discord 側に保存される。
- プロジェクト側の `.claude/settings*.json` の allow は、有効なまま。
- `.env` のトークンは平文で保存される。

### トークンが漏れたとき

次の順で塞ぐ。

1. **すぐにトークンをリセットする**: [Discord Developer Portal](https://discord.com/developers/applications) → アプリ → **Bot** → **Reset Token**。古いトークンはその場で使えなくなり、つながっていた Gateway も切れる。リセットには多要素認証が要る。
2. `.env` の `DISCORD_BOT_TOKEN` を新しいトークンで書き直す。
3. `npm run check` で疎通を確かめてから、`scripts\start.cmd` で再起動する。
4. 漏れていた間に、ボットが知らないサーバーに入れられていないかを、Developer Portal の **Installation** と Discord のサーバー一覧で確かめる。
