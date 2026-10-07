# Cloudflare TURN セットアップ手順

この手順は、Cloudflare Realtime TURNをPerfectPodcastのWorkerから利用し、ブラウザーで中継通信を確認するためのものです。TURNサーバーを自分で構築したり、独自ドメインのDNSを変更したりする必要はありません。

このリポジトリにはTURN連携コードがありますが、この手順を実行するまではCloudflareアカウントにTURN keyやWorker secretは作成されません。この変更自体もCloudflareへのログイン、キー作成、デプロイは行っていません。

## 構成と秘密情報

1. Cloudflare Realtime TURNがICE候補の中継先になります。
2. PerfectPodcast WorkerはCloudflare API tokenとTURN key IDを使い、期限付きICE資格をサーバー側で取得します。
3. ホストは部屋・ホスト公開鍵に結びついた短命のTURN room permitを提示します。WorkerはEd25519署名を検証してからTURN資格を発行します。
4. ブラウザーに渡るのは期限付きTURN username/passwordだけです。Cloudflare API token、TURN keyの秘密値、permit署名用秘密鍵はブラウザーへ渡しません。
5. `prototype/turn-test.html` はCloudflareから取得した期限付き資格を一時的に読み込み、TURN relay限定のWebRTC DataChannelを試験します。値はブラウザーのストレージに保存しません。

TURN資格はTURN利用者が通信している間に有効である必要があります。Workerの既定値は3時間で、設定可能範囲は3〜48時間です。TURNは直接P2P接続に失敗した場合に限らず中継を使うため、実ネットワークでの利用量に応じて課金されます。Cloudflareの現行案内では、Realtime SFUと併用しないTURNはCloudflareからTURNクライアントへの送信量に対して課金されます。試験・運用前に[料金と制限](https://developers.cloudflare.com/realtime/turn/)を確認してください。

## 1. CloudflareでTURN keyを作る

1. Cloudflare Dashboardで対象アカウントを選び、[Calls / Realtime](https://dash.cloudflare.com/?to=/:account/calls)を開きます。
2. TURNの画面から新しいTURN keyを作成します。名前の例は `perfectpodcast-prod` です。
3. 作成結果から **UID** を控えます。後で `TURN_KEY_ID` として使います。
4. 作成時に表示される `key` は長期秘密情報です。パスワードマネージャーなどへ保管し、HTML、チャット、ソースコード、ゲストには貼り付けないでください。このWorkerの資格生成呼び出しはCloudflare API tokenとUIDを使います。

既に対象のTURN keyがある場合は、既存のkeyを再利用してUIDを確認できます。検証用と本番用は可能なら別keyにしてください。

## 2. 最小権限のCloudflare API tokenを作る

1. Cloudflare Dashboardのプロフィールから **API Tokens** を開き、カスタムtokenを作成します。
2. 権限は **Calls: Write** のみを選びます。
3. 対象アカウントを今回のTURN keyがあるアカウントに限定します。不要なZone権限やアカウント全体のAPI keyは使いません。
4. tokenを一度だけ安全な場所へ控えます。ブラウザーやリポジトリには保存しません。

TURN key作成APIとTURN資格生成APIはCloudflare API tokenで認証されます。権限名がDashboard上で異なる場合は、Cloudflareの[TURN API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/)に表示される受け入れ権限を確認してください。

## 3. Worker用permit署名鍵を作る

リポジトリのルートで一度だけ実行します。秘密鍵はリポジトリの外に保存され、スクリプトがファイル権限を `0600` に設定します。

```sh
install -d -m 700 "$HOME/.config/perfectpodcast"
node scripts/create-turn-permit-keypair.js \
  "$HOME/.config/perfectpodcast/turn-permit-ed25519.pem" \
  > "$HOME/.config/perfectpodcast/turn-permit-public-key.txt"
```

公開鍵の値は次で確認できます。

```sh
cat "$HOME/.config/perfectpodcast/turn-permit-public-key.txt"
```

公開鍵はWorker設定へ登録します。`turn-permit-ed25519.pem` は手元の管理端末から出さず、Cloudflareへアップロードしないでください。既存ファイルに上書きするとpermit発行済み環境と不整合になるため、再実行時は別の鍵のローテーション手順を決めてください。

## 4. Worker secretsを登録してデプロイする

以下のコマンドは対象のCloudflareアカウントに設定を反映します。デプロイ先を確認してから実行してください。Wranglerに未ログインなら `npx wrangler login` を実行します。

```sh
npx wrangler secret put TURN_API_TOKEN --config wrangler.jsonc
npx wrangler secret put TURN_KEY_ID --config wrangler.jsonc
npx wrangler secret put TURN_PERMIT_PUBLIC_KEY --config wrangler.jsonc
npm run deploy
```

各 `secret put` の入力プロンプトに値を貼り付けます。

- `TURN_API_TOKEN`: 手順2で作成したCalls Write token
- `TURN_KEY_ID`: 手順1で控えたTURN keyのUID
- `TURN_PERMIT_PUBLIC_KEY`: 手順3で作った公開鍵の内容

Workerは `TURN_CREDENTIAL_TTL_SECONDS` が未設定なら3時間を使います。変更が必要な場合のみ `npx wrangler secret put TURN_CREDENTIAL_TTL_SECONDS --config wrangler.jsonc` を使い、`10800`〜`172800` 秒の範囲にします。2時間の通話に対しては、期限切れ余裕を含む3時間以上にしてください。

このプロジェクトの[wrangler.jsonc](./wrangler.jsonc)には `SIGNAL_RATE_LIMITER` bindingが定義されています。TURN資格発行はこのbindingが利用可能でないと拒否されます。デプロイ出力にbindingエラーがないことを確認してください。Worker側ではさらに同じ部屋からの再発行を1分に1回へ制限しています。

## 5. TURN資格を取得してテストHTMLで通信する

1. デプロイしたWorkerのURLで `https://<Workerのホスト名>/turn-test.html` を開きます。ローカル確認なら `npm run dev` で起動した `http://localhost:8787/turn-test.html` を使えます。
2. macOS標準のzshで、Cloudflare API tokenを画面に表示せずに入力します。次のコマンドではAPI tokenをシェル履歴へ直接書きません。

   ```sh
   read -s "CF_API_TOKEN?Cloudflare API token: "
   printf '\n'
   TURN_KEY_ID='ここにTURN keyのUID'
   curl --fail-with-body --silent --show-error --config - <<EOF
   url = "https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers"
   request = "POST"
   header = "Authorization: Bearer ${CF_API_TOKEN}"
   header = "Content-Type: application/json"
   data = "{\"ttl\":10800}"
   EOF
   unset CF_API_TOKEN
   ```

   `--config -`はcurlの設定ファイルとして本文を解釈します。シェルのように単一引用符を取り除かないため、`data = '{"ttl":10800}'` と書くと引用符自体も本文に含まれ、Cloudflareから「unable to parse body as JSON」が返ります。

3. 成功時は `iceServers` を含むJSONが返ります。JSON全体をテストHTMLの入力欄へ貼り付け、**TURN通信をテスト**を押します。入力欄は開始時に消去され、資格は画面を閉じるまでメモリー上でのみ使われます。
4. 結果に `relay` のICE候補ペアとDataChannel往復成功が表示されれば、このブラウザーからCloudflare TURNを経由した通信が確認できています。
5. 終了後はページを閉じます。TURN username/passwordは有効期限が切れるまで第三者へ共有しないでください。

このページは同じブラウザー内で2つのPeerConnectionを作り、両方をrelay候補に限定してDataChannelを往復させます。資格・TURN割当て・リレー経路の確認には使えますが、異なる端末間のシグナリング、音声、NATや企業ファイアウォールごとの接続成功までは証明しません。次の手順でアプリの実通話も確認してください。

## 6. PerfectPodcastの実通話で確認する

1. TURN設定を反映したWorkerのアプリをホストとゲストの2台で開きます。
2. ホストが新しい招待を作り、画面の「TURN中継の詳細設定」に表示される部屋IDとホスト公開鍵を控えます。
3. ローカル管理端末で、その部屋専用permitを発行します。秘密鍵のパスは手順3のものを指定します。

   ```sh
   TURN_PERMIT_PRIVATE_KEY_PATH="$HOME/.config/perfectpodcast/turn-permit-ed25519.pem" \
     node scripts/create-turn-permit.js '<部屋ID>' '<ホスト公開鍵>'
   ```

4. コマンドが出力したpermitをホスト画面のTURN room permit欄へ貼り付けます。招待リンクとpermitは必要な相手だけに共有してください。permitは部屋・ホスト鍵に結びつき、約3時間で期限切れになります。
5. ゲストが参加申請し、ホストが承認します。承認時にWorkerがCloudflareから短命資格を取得し、ホストとゲストへ渡します。TURNが使えない場合、アプリはエラーを表示してSTUN直接接続へフォールバックします。
6. 通話接続後、アプリの接続診断でICE経路が `relay` になっていること、音声が双方向で聞こえることを両端末で確認します。接続しただけではTURNを通ったとは限らないため、経路表示を確認してください。
7. 通常のSTUN直接接続とも比較します。必要ならTURN中継試験だけを企業・モバイル回線など制限のあるネットワークで繰り返します。結果、ブラウザー、OS、ネットワーク種別、選択されたICE経路を記録します。

本番通話を開始する前に、TURN送信量・費用・Cloudflareの[ポート、制限、接続要件](https://developers.cloudflare.com/realtime/turn/)を確認してください。試験は小さいデータから始め、音声が中継される場合の実利用量と課金を別途測定してください。

## 7. 失敗時の切り分け

| 症状 | 確認すること |
| --- | --- |
| TURN key作成が拒否される | 対象Cloudflareアカウント、Calls: Write権限、Realtime利用状態を確認します。 |
| `TURN資格を発行できません` / HTTP 401・403 | API tokenの期限・Calls: Write・アカウント範囲、`TURN_KEY_ID`のUIDを確認します。API tokenをWorker secretへ入れたことを確認します。 |
| permitが無効 / 発行要求が拒否される | Workerの公開鍵が署名鍵ペアと一致すること、部屋ID・ホスト公開鍵を取り違えていないこと、permitが期限内で未使用であることを確認します。新しい部屋でpermitを再発行してください。 |
| bindingがない、またはTURN要求が拒否される | `wrangler.jsonc`の`SIGNAL_RATE_LIMITER` bindingとデプロイ結果を確認します。 |
| DataChannelがrelayで開かない | API応答の期限内username/password、ブラウザーのHTTPS/localhost利用、TURNに必要な外向き通信がネットワークで許可されているかを確認します。まず自宅回線と別回線を比較してください。 |
| ブラウザーがポート53の候補で待つ | Cloudflareの説明どおり、Webブラウザーではポート53が遮断されることがあります。このページは当該URLを利用対象から除外します。 |
| TURNは接続するが音声品質が悪い | TURNは帯域や遅延を改善するものではありません。両端のRTT・損失・ネットワーク種別と、直接接続時との差を記録します。 |

Cloudflare API token、TURN key秘密値、permit署名用秘密鍵、短命資格をログ・Issue・チャットへ貼らないでください。調査時に共有するのはHTTP status、時刻、ブラウザー、選択経路などの非秘密情報だけにします。

## 8. TURNを停止・ローテーションする

緊急停止または試験終了時は、まずCloudflare DashboardでCalls: Write API tokenを失効させます。Workerから以下のsecretを削除して、permitによる発行も止めます。

```sh
npx wrangler secret delete TURN_API_TOKEN --config wrangler.jsonc
npx wrangler secret delete TURN_KEY_ID --config wrangler.jsonc
npx wrangler secret delete TURN_PERMIT_PUBLIC_KEY --config wrangler.jsonc
```

`TURN_PERMIT_PUBLIC_KEY`がない場合、Workerはroom permitを受理しません。既存アプリはTURN資格を取得できず、STUN接続を試します。設定変更後に新しい通話を開始して停止状態を確認してください。漏えいが疑われるTURN keyもCloudflare Dashboardで削除し、新しいkey/tokenを発行します。

## 公式資料

- [Cloudflare TURN Service](https://developers.cloudflare.com/realtime/turn/)
- [Cloudflare Generate TURN Credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Cloudflare TURN API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/)
