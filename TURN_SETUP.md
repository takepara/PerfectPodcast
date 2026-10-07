# Auth0とCloudflare TURNのセットアップ

PerfectPodcastでは、ホストはAuth0にログインして `recording:host` permissionを持つ必要があります。ゲストは認証不要で、ホストが発行した招待リンクから参加できます。WorkerはホストのAuth0 access tokenを検証し、HttpOnly cookieのセッションを使ってWebSocket接続とTURN資格発行を保護します。Auth0のClient SecretやCloudflare API tokenをブラウザーへ渡しません。

## 1. Auth0を設定する

既存のAuth0アプリケーションとAPIを使います。アプリケーションはSPAとして設定し、次のURLをアプリのAllow listsへ登録してください。`<app-origin>`はローカルでは `http://localhost:8787`、本番ではWorkerのオリジンまたは利用するカスタムドメインです。

- Allowed Callback URLs: `<app-origin>/index.html`
- Allowed Logout URLs: `<app-origin>/index.html`
- Allowed Web Origins: `<app-origin>`

Auth0 APIには `recording:host` permissionを定義し、RBACと「Add Permissions in the Access Token」を有効にします。ホストとして収録するユーザーまたは割り当てたRoleにそのpermissionを付与してください。permissionを持たないアカウントはログインできてもホスト機能を利用できません。

Workerに渡すAuth0設定値は以下のとおりです。

- `AUTH0_DOMAIN`: Auth0 tenant domain（例: `example.us.auth0.com`。`https://`付きでも可）
- `AUTH0_CLIENT_ID`: SPAアプリケーションのClient ID。Client Secretではありません。
- `AUTH0_AUDIENCE`: Auth0 APIのIdentifier
- `AUTH0_HOST_PERMISSION`: `recording:host`

## 2. Cloudflare TURN keyとAPI tokenを用意する

1. Cloudflare Dashboardで対象アカウントの[Calls / Realtime](https://dash.cloudflare.com/?to=/:account/calls)を開き、TURN keyを作成します。結果のUIDを控え、Workerの `TURN_KEY_ID` として使います。keyの秘密値自体はこのWorkerの資格発行フローには登録しません。
2. Cloudflare API tokenを作成し、対象アカウントに限定した **Calls: Write** 権限だけを付与します。これを `TURN_API_TOKEN` として使います。
3. TURN利用量と制限について、Cloudflareの[料金・制限・接続要件](https://developers.cloudflare.com/realtime/turn/)を確認してください。TURNはデータを中継するため、利用量に応じて費用が発生します。

## 3. ローカルWorkerを起動する

リポジトリ直下の`.dev.vars`に設定します。このファイルは`.gitignore`対象です。以下の値を実際のAuth0/Cloudflare設定に置き換えてください。

```dotenv
AUTH0_DOMAIN=example.us.auth0.com
AUTH0_CLIENT_ID=your-spa-client-id
AUTH0_AUDIENCE=https://api.example.com
AUTH0_HOST_PERMISSION=recording:host
TURN_API_TOKEN=your-calls-write-api-token
TURN_KEY_ID=your-turn-key-uid
# 任意。未設定時は3時間。設定する場合は10800〜172800秒。
TURN_CREDENTIAL_TTL_SECONDS=10800
```

Auth0 callback / logout / web originには `http://localhost:8787` を登録してください。アプリのローカル起動とAuthクライアントbundle生成は次のコマンドで行います。

```sh
npm run dev
```

## 4. Workerへ設定してデプロイする

先に `npx wrangler login` でログインし、正しいCloudflareアカウントとWorkerを対象にしていることを確認します。以下の各コマンドで値をプロンプトへ入力してください。Auth0の設定値はブラウザーにも公開される設定情報ですが、Workerの設定経路を統一するためsecretとして登録します。

```sh
npx wrangler secret put AUTH0_DOMAIN --config wrangler.jsonc
npx wrangler secret put AUTH0_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put AUTH0_AUDIENCE --config wrangler.jsonc
npx wrangler secret put AUTH0_HOST_PERMISSION --config wrangler.jsonc
npx wrangler secret put TURN_API_TOKEN --config wrangler.jsonc
npx wrangler secret put TURN_KEY_ID --config wrangler.jsonc
npm run deploy
```

資格の有効期間を変更する場合のみ、任意設定も登録します。

```sh
npx wrangler secret put TURN_CREDENTIAL_TTL_SECONDS --config wrangler.jsonc
```

`wrangler.jsonc`にはシグナリング用の`SIGNAL_RATE_LIMITER` bindingが定義されています。デプロイ後にWorkerのトップページとAuth0ログインを確認してください。デプロイ前の構成確認だけなら `npx wrangler deploy --dry-run --config wrangler.jsonc` を使えます。

## 5. ホストとゲストの動作を確認する

1. Workerの `/index.html` を開き、Auth0でログインします。必要なpermissionがなければホストとしてのセッション確立は拒否されます。
2. ログイン後、ホストとして録音ページを開き、新しい招待リンクを作成します。通常のホストURLを未ログインで開いた場合は `/index.html` へ移動します。
3. 招待リンクを別のブラウザーまたは端末で開きます。ゲストはログインなしで参加申請できます。ホストがゲストを承認すると、Worker経由で短命TURN資格が渡されます。
4. TURN経路も確認する場合は、ログインしたホストで `/turn-test.html` を開いてTURN疎通テストを実行します。テストは同じブラウザー内に2つのPeerConnectionを作ります。
5. 実通話ではホストとゲストの両端で接続診断が `relay → relay` になったことを確認します。通話成立だけではTURN経由の証拠になりません。直接接続を選ぶ場合は、P2Pが制限された別ネットワークでも再試験してください。

招待リンクには部屋へ参加するための情報が含まれます。リンクは必要な相手にだけ共有してください。ゲスト認証を省略する設計のため、Workerはホストによる参加承認を要求します。

## 6. トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| Auth0 callback error | Callback、Logout、Web OriginsのURLがアクセス中の正確なオリジンと一致するか確認します。 |
| ログイン後にホスト権限がないと表示される | API audience、RBAC、Access Tokenへのpermission追加、ユーザーまたはRoleへの`recording:host`割当てを確認します。 |
| Auth0設定エラーが表示される | `AUTH0_DOMAIN`、`AUTH0_CLIENT_ID`、`AUTH0_AUDIENCE`、`AUTH0_HOST_PERMISSION`がローカルまたはWorkerに登録されているか確認します。 |
| TURN資格の発行が拒否される | `TURN_API_TOKEN`のCalls: Write権限と対象アカウント、`TURN_KEY_ID`のUIDを確認します。API tokenはログやチャットに貼らないでください。 |
| bindingがない、または接続が制限される | `wrangler.jsonc`の`SIGNAL_RATE_LIMITER` bindingとデプロイ結果を確認します。 |
| 接続がrelayにならない | TURNの有効期限、ブラウザーでHTTPSまたはlocalhostを使っていること、TURN通信がネットワークで許可されていることを確認します。 |
| ブラウザーがポート53の候補で待つ | Cloudflareの説明どおり、Webブラウザーではポート53が遮断されることがあります。このページは当該URLを利用対象から除外します。 |

Auth0 access token、Cloudflare API token、TURN資格をログ・Issue・チャットへ貼らないでください。調査時に共有するのはHTTP status、時刻、ブラウザー、選択経路などの非秘密情報だけにします。

## 7. TURNを停止・ローテーションする

緊急停止時はCloudflare DashboardでCalls: Write API tokenを失効させ、WorkerからTURN設定を削除します。

```sh
npx wrangler secret delete TURN_API_TOKEN --config wrangler.jsonc
npx wrangler secret delete TURN_KEY_ID --config wrangler.jsonc
```

Auth0設定を削除するとホスト認証も利用できなくなります。認証を止める目的でAuth0設定を削除せず、Auth0で対象アカウントのpermissionを外すか、アプリ/API設定を無効化してください。漏えいが疑われるTURN keyはCloudflare Dashboardで削除し、必要に応じて新しいkeyとAPI tokenを発行します。

## 公式資料

- [Cloudflare TURN Service](https://developers.cloudflare.com/realtime/turn/)
- [Cloudflare Generate TURN Credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Cloudflare TURN API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/)
