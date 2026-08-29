# 開発

このリポジトリに手を入れるときに開く文書。変更を入れる前に、ここのコマンドとテストで確かめる。

## 由来

[claude-slack-channel](https://github.com/elys0912/claude-slack-channel) の main（コミット `42d3bdd`）から、Slack に依存しない部分を持ってきて作った。
持ってきたファイル（`chunk` / `text` / `lock` / `errors` / `stdio-guard` / `watchdog` / `hook*` / `screen` / `console` / `allow-rules` / `session-allow` / `scripts\console.ps1` など）にバグが見つかったら、Slack 版も同じように直す必要がある。

## コマンド

```powershell
npm test             # vitest run
npm run typecheck    # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json（本体とテストの両方）
npm run lint         # eslint .（typescript-eslint の型情報付きの推奨ルール。設定は eslint.config.js）
npm run build        # tsc -p tsconfig.json で dist へ出力する
npm run check        # precheck（npm run build）のあと dist/scripts/check.js を実行する
```

GitHub Actions（`.github/workflows/ci.yml`）は、main への push と pull request で動く。windows-latest と ubuntu-latest の両方で、`npm run typecheck`・`npm test`・`npm run lint` を実行する。

## テスト

テストは3段階ある。1と2は `npm test` でまとめて実行し、3は手で確かめる。

1. **単体テスト**: 純関数とクラスを単体で確かめる。
   - 対象は `gate` / `card` / `permission` / `format` / `chunk` / `screen` / `allow-rules` / `config` / `presence` / `keepalive` / `long-reply` / `send-file` / `inline-text` など。
   - I/O は使わないか、一時フォルダーだけを使う。
2. **結合テスト**: 部品をつないで、実際に近い経路を通す。
   - `app.test.ts`: 偽の Discord（`test/helpers/fake-discord.ts`）とインメモリの MCP クライアントで `startBridgeApp` を動かす。受信から、Claude への通知、ツールの呼び出し、Discord への投稿までを通して確かめる。
   - `mcp.test.ts`: 実際の MCP SDK のクライアントとサーバーをつなぎ、ツールの一覧・呼び出し・通知を確かめる。
   - `download.test.ts`: Windows では実際の `tar.exe` で、展開・Zip Slip の拒否・上限を超えたときの中断と後始末を確かめる。Windows 以外では、tar を使うテストを飛ばす。
   - `hook.test.ts` / `hook-inbox.test.ts` / `lock.test.ts`: 実際のファイルを読み書きして確かめる。
   - `console-script.test.ts` / `common-script.test.ts`: Windows でだけ、PowerShell のスクリプトを実際に実行して確かめる。
3. **システムテスト（実機）**: 手元の Discord サーバーと Claude Code で、機能を入れるたびに確かめる。
   - DM と許可チャンネルで、受信（👀）・入力中の表示・返信が届くこと。チャンネルではスレッドが作られ、スレッドの中ではメンションなしでも届くこと。
   - 実行許可のカードが出て、ボタンとテキスト（`yes xxxxx`）の両方で答えられること。
   - `!status` / `!screen` / `!stop` / `!keepalive` / `!rules` / `!restart` が動くこと。スラッシュコマンドが DM とチャンネルで動くこと（ブラウザ版では入力欄に打っても候補が出ないので、入力欄の右のアプリのボタンから検索して選ぶ）。
   - テキストの添付が本文に差し込まれること。`download_file` で保存・展開でき、保存の前に実行許可のカードが出ること。
   - `send_file` で、`UPLOAD_DIRS` の中は確認なしで、外は確認のカードを経て送られること。
   - hook の通知（セッションの開始など）が、そのセッション自身の状態ディレクトリに書かれ、そのボットにだけ出ること。
   - ブラウザ版の Discord で自動で確かめるときは、入力欄に下書きが残っていると文字の順番が崩れる。空の入力欄に1文字ずつゆっくり打ち、送った内容はボットの REST で読み直して確かめる。添付は、ファイル入力欄（`input.file-input`）に `DataTransfer` でファイルを入れて送れる。

## ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。ロガー・ロック・設定の読み込みと、終了処理 |
| `src/app.ts` | Discord・MCP・実行許可のリレーの配線（通常モードと縮退モード）、MCP ツールと受信イベントの処理、`!` コマンド |
| `src/discord.ts` | Discord との出入り口。Gateway での受信、REST での送信、スレッドの作成と記憶、ステータス表示、添付の取得 |
| `src/card.ts` | 中立な `Card` 型と、Discord の embed・ボタン・メニューへの変換（文字数と個数の上限を守る） |
| `src/slash.ts` | スラッシュコマンドの定義（登録する JSON）と、使われたコマンドの検証・解釈（純関数） |
| `src/mcp.ts` | MCP channel サーバー（`reply` / `react` / `edit_message` / `download_file` / `send_file` / `progress` ツール） |
| `src/placeholder.ts` | 待つだけの `discordbridge`。起動スクリプトが local スコープに登録し、普段のセッションで読み込まれる |
| `src/permission-relay.ts` | 実行許可のリレーの状態管理（配信・回答・結果の表示への書き換え・自動 deny） |
| `src/permission.ts` | 実行許可のカードの組み立てと、ボタン・メニュー操作の検証（`custom_id` の分解。純関数） |
| `src/session-allow.ts` | 「このセッション中は全部許可」の状態と、ask との照合 |
| `src/gate.ts` | 受信したメッセージを中継すべきかの判定（純関数） |
| `src/watchdog.ts` | Claude の無応答の見張り |
| `src/typing.ts` | 「入力中…」の表示 |
| `src/presence.ts` | ボットのステータス表示の状態の決定と、更新の間引き |
| `src/keepalive.ts` | キャッシュのつなぎ止め |
| `src/todo.ts` | `progress` ツールの実体（TODO の進み具合のカードの組み立てと、出したカードの書き換え） |
| `src/inline-text.ts` | テキストの添付を本文に差し込む |
| `src/long-reply.ts` | 長い返信を、冒頭の本文と全文の添付に分ける |
| `src/send-file.ts` | `send_file` の実体（秘密のファイルの拒否、`UPLOAD_DIRS` の判定、確認のカード） |
| `src/download.ts` | `download_file` の実体（ファイル名の無害化・保存・展開・上限の確認） |
| `src/hook.ts` | Claude Code の hook として起動され、`hooks.jsonl` に1行追記するコマンド |
| `src/hook-event.ts` | `hooks.jsonl` の1行のスキーマ（zod）と型 |
| `src/hook-inbox.ts` | `hooks.jsonl` の増えた分を読み、イベントとして渡す |
| `src/hook-notices.ts` | hook のイベントを Discord の文言と色にする（純関数） |
| `src/notice.ts` | ブリッジからの通知の投稿（最後のスレッド、無ければ DM） |
| `src/status.ts` | `!status` の文面（純関数） |
| `src/session-control.ts` | `!restart` / `!compact` / `!clear` / `!stop`（再起動フラグと、ターミナルへの決まったキーの送信） |
| `src/console.ts` | ターミナル画面の読み取りと選択キーの送信（`scripts/console.ps1` の呼び出し） |
| `src/screen.ts` | 画面のテキストから選択画面を取り出す（純関数） |
| `src/screen-relay.ts` | `!screen` と選択肢メニューの処理 |
| `src/allow-rules.ts` | 「今後も許可」のルールの生成、危険な操作の除外、deny との照合、保存 |
| `src/rule-relay.ts` | 「今後も許可」の提案・確認と、`!rules` の処理 |
| `src/config.ts` | 状態ディレクトリ、`.env` のパーサー、`access.json` の検証 |
| `src/format.ts` | 送信前のテキストの整形（一斉メンションの無害化） |
| `src/chunk.ts` | 長文の分割 |
| `src/lock.ts` | 単一インスタンス実行のファイルロック |
| `src/log.ts` | ログの出力（トークンの伏せ字を含む） |
| `src/errors.ts` | エラーの値を文字列にする helper |
| `src/stdio-guard.ts` | stdout を MCP 専用に保つガード |
| `src/text.ts` | 文字列の小さな整形（BOM の除去・切り詰め・ID の生成・時刻） |
| `src/types.ts` | 共有の型 |
| `scripts/check.ts` | `npm run check` の実体（Discord との疎通と権限の確認） |
| `scripts/start.cmd` / `start.ps1` | 起動スクリプト |
| `scripts/common.ps1` | 起動スクリプトの共通の関数（claude.exe の探索、mcp.json の生成、再起動フラグと会話の記録の確認） |
| `scripts/console.ps1` | ターミナル画面の読み取り、キーの送信、決まったコマンド（/exit・/compact・/clear・Esc）の送信（ブリッジが子プロセスで実行する） |
| `scripts/dialog-answer.ps1` | 起動時の警告ダイアログを画面で見張り、自動で答える（初回の起動と再起動のたびに `start.ps1` が起動する） |
| `config/channel-settings.json` | Discord のセッション専用の権限の設定 |
| `config/*.example*` | `projects.json` / `access.json` / `.env` / `extra-mcp.json` のひな形 |
| `test/*.test.ts` | vitest のテスト |
| `test/helpers/fake-discord.ts` | `DiscordBridge` の差し替え（送ったものを記録する。`app.test.ts` などで共用） |
| `test/fixtures/chunk-legacy.ts` | 分割前の `chunkText` の実装。`chunk-legacy.test.ts` で出力が一致することを確かめる |
| `tsconfig.json` | 本体（`src` / `scripts`）のビルドの設定 |
| `tsconfig.test.json` | テストを含めた型検査用の設定（出力なし） |
| `vitest.config.ts` | vitest の設定 |
| `eslint.config.js` | eslint の設定（flat config） |
