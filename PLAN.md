# PerfectPodcast 最小実装計画

改訂日: 2026-10-07
状態: 録音・復旧、2人Opus通話、同期開始、録音中転送、ホスト側検証・ACK、再接続時inventory突合、転送状況UIの主要コードは実装済み。Auth0 SPAログイン、Worker側JWT/permission検証、ホストセッション、未認証ゲスト参加も実装済み。`npm test`は76件成功し、Auth bundle生成とWrangler deploy dry-runも成功。2時間・実回線・数値合格基準、実Auth0ログイン、TURN relay実機試験は未検証。Auth0/Cloudflareの実値設定、本番secret登録・deploy・一般公開は行っていない。

## 1. 維持する要件と今回の変更

### 維持する要件

- マスターは **24-bit signed PCM / 48,000 Hz / mono / 非圧縮WAV**。
- 音源ダウンロードは必ず`.wav`。圧縮音源・Float32 WAVは提供しない。
- 参加者は自端末へ録音し、ホストPCへ回収。最終WAV生成・台帳・完了判定はホスト側で行う。
- サーバーDB・KV・オブジェクトストレージへの音源・セッション永続保存、一時保管を行わない。
- URLハッシュにランダムなセッションIDと招待資格を含め、参加時は名前入力・確認を必須にする。
- ブラウザー側・中継側ともJavaScript。ホストはAuth0ログインと`recording:host` permissionが必須。ゲストはAuth0ログイン不要で、招待リンクから参加できる。

### 今回変更する要件

**通話用の16bit事前量子化を撤回し、マイクのMediaStreamTrackをnative WebRTCへ直接渡してOpusで通信する。** ビット深度ではなく低帯域化・輻輳制御・再接続・録音処理との分離で安定性を改善する。

**初版はホスト1人＋参加者1人の2人、最大2時間。** 3〜4人は後続段階で拡張する。人数制限は最初の検証範囲を絞るための提案であり、多人数要件を永久に削除するものではない。

**録音中も、ローカルDBへ保存確定したマスターチャンクを順次ホストへ転送する。** 通話優先の小さな速度制御・backpressureだけを追加し、録音終了時の未回収量を減らす。全音源と最終manifestのホストIndexedDB保存確認後は、WAV書き出しを待たずにparticipantが退出できる。受信した各WAVチャンクを形式・SHA-256検証後にホストIndexedDBへ保存し、manifest受信時に全チャンクのframe連続性・WAVヘッダー・hashを再検証してからACKする。再接続時は保存済みchunk/manifest inventoryを照合し、欠落・破損チャンクを再送する。WAVファイルは必要時にIndexedDBから書き出す。

---

## 2. Opus通話を安定させる最小構成

### 2.1 通信方式

**P2P native WebRTC / Opus mono + STUNによる直接接続とCloudflare managed TURN fallback**を実装対象とする。TURN資格発行はWorker経由で保護する。実relay経路・制限回線の接続保証・公開利用は未検証。

- マイクトラックを`RTCPeerConnection.addTrack()`へ直接渡す。AudioWorklet、PCM16変換、WASMエンコーダーを通話の必須経路にしない。
- 同じ入力をWeb Audioへ分岐し、マスターだけAudioWorklet→Worker→PCM24 WAV→IndexedDBへ保存する。
- Opusを`setCodecPreferences()`で優先する。現コードは優先設定までで、実際に選ばれたcodecを`getStats()`で確認する診断・実機検証は未完了。利用可能codec情報を独自に書き換えない。
- Opusの送信上限は初期32 kbps。音声のみ、mono。実帯域はヘッダー等を含めて測定する。
- ブラウザーの輻輳制御・ジッターバッファー・損失隠蔽を利用する。FEC/DTXは交渉された提供範囲に任せ、SDP書き換え・独自FEC・自作帯域推定は行わない。
- 任意のユーザー操作で「低帯域モード」24 kbps上限へ変更できるようにする。初版では統計から頻繁にbitrateを変更する独自制御を作らない。
- bitrate設定失敗は警告し、ブラウザー既定値で継続する。Opusが選べない場合は検証対象外として開始不可にする。
- ICEはSTUNによる直接接続を試し、必要な場合はWorkerが短命TURN資格を発行する。Auth0ホストpermissionで発行経路を保護する。実回線で`relay`候補が選択されることは未検証。
- 現状はホストだけがofferを開始する1ホスト＋1ゲスト構成。perfect negotiationによるoffer衝突処理は未実装で、役割・交渉方式を広げる場合に再検討する。

### 2.2 再接続・診断

- 2秒ごとにRTT、packet loss、jitter、concealed samples、送信bitrate、ICE候補種別とDataChannel送出速度を取得可能な範囲で端末内表示する。区間統計のコードはあるが、実ネットワークでの値・codecは未検証。
- 現状は`disconnected`時に約5秒後、`failed`時にICE restartを行い、最大3回で打ち切る。30秒回復目標の測定と手動「再接続」操作は未実装。
- 再接続でマイク取得・録音Worker・IndexedDBを再初期化しない。通話断と録音停止を別状態にする。
- 通話優先の転送制御は下記7.1を目標とする。現状は固定pacingとbuffer上限であり、RTT・損失・ホスト保存遅延に応じた段階制御は未実装。
- 再生はユーザーの参加操作に紐付けて開始し、autoplay拒否時は「音声を再生」ボタンを出す。
- 音声処理・レベル表示・DB書込に問題があっても、native通話の経路を不必要に巻き込まない。

### 2.3 マイク処理の割り切り

- 初版はヘッドホン必須。マスターのAEC／ノイズ抑制／AGCは無効化を要求する。実設定の診断表示は未実装・未検証。
- 同じcaptureを共有するため、内蔵AECを通話側だけに適用できると仮定しない。スピーカー対応・別マイクcapture・独自DSPは後回し。
- 通話muteは送信側encodingの`active`等で制御し、録音元トラックの`enabled`を変更しない。
- 録音停止・通話終了・マイク解放を別操作にする。通話終了で録音中のcaptureを止めない。
- UIは通話を「Opus / mono / 32 kbps上限」と表示し、「16bit通信」と表示しない。

---

## 3. 技術スタックと保存境界

| 部分 | 最小採用候補 | 保存方針 |
| --- | --- | --- |
| アプリ | HTML/CSS/JavaScript ES Modules | 現プロトタイプを起点にする |
| 静的配信 | Cloudflare Workers Static Assets | アプリ資産のみ。音源受付なし |
| 録音 | AudioWorklet + recorder.jsメインスレッド + IndexedDB | 現状Dedicated Workerは未導入。Float32は作業メモリーだけ。保存はPCM24 WAV |
| 参加者DB | IndexedDB + `idb` | WAVチャンク、manifest、ローカル鍵・転送状態 |
| 通話 | native RTCPeerConnection / Opus | 通話音声をマスター保存しない |
| マスター回収 | reliable RTCDataChannel | 録音中から保存確定チャンクをparticipant→hostへ転送 |
| 接続調整 | Workers + DB保存API未使用のDurable Object | 接続中WebSocketの一時メモリーだけ |
| NAT越え | STUN直接接続とCloudflare managed TURN fallback | Workerから短命資格を取得。実relay経路の確認は未完了 |
| ホスト保存 | IndexedDB | ゲスト音源のWAVチャンク、manifest、回収台帳。必要時にWAVを書き出す |
| 検証 | Vitest、Playwright、ffprobe、DAW | テスト出力も端末内 |

### 保存しないもの

R2/S3、D1、KV、DO SQL/storage、永続attachments、Queues、Workflows、クラウド録音、ユーザーDBは導入しない。

シグナリングの接続表はメモリーのみ。Hibernationの永続attachmentに頼らず、再起動・デプロイ・切断後は端末から再登録する。通常のWorkerグローバル変数が複数インスタンスで共有されるとは仮定しない。

**サーバーレスでも通信サービス内部の一時状態・課金情報・運用ログは存在し得る。** アプリは名前・secret・SDP・音源をログに出さず、事業者の保持ポリシーを確認する。「事業者側の保存も一切ゼロ」とは保証しない。

### 初期の対応環境

ホスト・参加者とも **デスクトップChrome/Edge、macOS/Windows、HTTPSまたはlocalhost**。Safari/Firefox・モバイルは未対応と明示する。救済WAVの大容量生成も同じstream書き出し方式を使う。

---

## 4. URL招待と接続認証を小さく実装する

### 4.1 セッションと参加

1. ホストが名前を指定して「部屋を作成」。録音開始とは別操作にする。
2. `crypto.getRandomValues()`で256-bit session ID・招待secret、Web Cryptoでホスト署名鍵を作る。
3. 招待URLは`https://<origin>/#session=<id>&invite=<secret>&host=<public-key>`。ホスト秘密鍵はURLへ入れない。
4. 参加者はURLを開き、名前を入力・確認し、録音同意・ヘッドホン・マイク確認後に参加要求する。
5. 初版はゲスト枠1人。名前と独立したparticipant ID・participant鍵を端末で生成し、ホストが承認する。

URLハッシュはフラグメントであり、一意性はランダムIDの極めて低い衝突確率で得る。世界全体のDB重複検査は不要。名前は本人認証ではなく表示名。XSS・空白名・長すぎる名を拒否する。

### 4.2 ピア間の接続認証

ホストのアプリ利用認証にはAuth0を使い、収録開始とホスト用Worker APIには`recording:host` permissionを要求する。招待ゲストはAuth0認証なしで参加できる。以下の署名検証はAuth0とは別に、招待リンクと実際のWebRTCピアを結び付けるために維持する。

- 鍵の生成・署名・検証・招待証明はWeb Cryptoを使う。独自暗号アルゴリズムを実装しない。
- 通話／controlのWebRTC接続を先に確立し、**認証完了まではマイク送信・マスター送信を無効**にする。
- ホスト署名をsession ID、接続世代、双方のnonce、双方のDTLS fingerprintに結び付ける。受信側は自身の実接続SDPのfingerprintと照合し、単なる署名応答の中継を受け入れない。
- 招待secretの証明も同じ接続情報へ結び付ける。nonceは単回利用・短命、正規化した署名対象を固定する。
- ホストは承認したparticipant公開鍵をローカル台帳に保存する。再接続はその鍵による新nonce署名で確認し、別の再開トークン発行基盤は作らない。
- 初版は長期自動再開・鍵ローテーション・ホスト移譲なし。鍵を失った場合はWAV手動回収、新しい部屋を作成する。
- 認証protocolは少数の固定メッセージとテストに絞るが、接続への署名bindingは省略しない。成立を検証できるまで公開利用しない。

### 4.3 TURN資格の乱用対策と運用

**状態: Auth0によるホスト認証、Worker側JWT/permission検証、Auth0セッションcookie、ホスト限定のTURN資格発行を実装し、自動テスト済み。** 手動Ed25519 room permitと発行CLIは廃止した。ゲストは認証不要だが、招待承認後に限ってTURN資格をWorkerのシグナリング経由で受け取る。実Auth0 tenant・Cloudflare資格情報は未設定で、実ログイン・relay試験・本番運用は未実施。

本番運用前に次を確認する。コードの存在は費用上限や乱用防止の成立を意味しない。

- Auth0 APIでRBACとAccess Tokenへのpermission追加を有効にし、ホスト対象ユーザーまたはRoleに`recording:host`を割り当てる。
- Auth0 callback/logout/web origin、API audience、`AUTH0_DOMAIN`、`AUTH0_CLIENT_ID`、`AUTH0_AUDIENCE`、`AUTH0_HOST_PERMISSION`を確認する。Client SecretはWorkerにもブラウザーにも登録しない。
- `SIGNAL_RATE_LIMITER`の本番bindingとCloudflareアカウント内で一意な`namespace_id`を確認する。現リポジトリ設定の`namespace_id: "1001"`は本番値として確認されていない。
- Rate Limitingはlocationごとの近似制限であり、アカウント全体の費用hard capではない。利用上限、通知、資格発行停止手順、既発行資格の残存時間を確認する。
- STUN接続成功をTURN成功と見なさず、実機でICE candidate typeが`relay`であることを確認する。
- 資格TTL・providerログ保持・費用見積もりを再確認する。確認が揃わなければTURNを有効化しない。

---

## 5. 録音と復旧の最小設計

### 5.1 PCM24 WAV保存

- AudioContextへ48 kHzを要求し、実`sampleRate`が48 kHzなら録音可能。ブラウザーがnative入力をAudioContextへresampleするため、入力track固有のsample rateは録音開始条件にしない。自前リサンプラーは導入しない。
- 実デバイスのchannel countなどを診断する。ファイルがPCM24でもADCの実効24-bit精度は保証しない。
- **現状:** AudioWorkletからFloat32 chunkをメインスレッドへ渡し、`recorder.js`でPCM24 little-endianへ変換してIndexedDBへ保存する。Dedicated Workerへの分離とcapture位置・単調時刻の付与は未実装。
- **継続要件:** WorkletはDB・hash・HTTP処理をしない。clamp・丸めで-8,388,608〜8,388,607へ変換し、初版はディザなし・自動正規化なし。メインスレッド処理によるUI／録音への影響を実機で測る。
- 1秒ごとに独立WAVとしてIndexedDBへ保存。音源・採番・frame位置を同一transactionで確定する。
- 初期48 kHz / mono: PCM tag 1、24 bits、blockAlign 3、byteRate 144,000。ヘッダー、data、paddingを検証する。

### 5.2 欠落検出とキュー上限

- **実装済み:** AudioWorkletが出す連続frame番号とcommit位置を照合し、不一致で停止する。通常チャンクの保存待ちは最大2件とし、最終チャンクは必ずqueueへ入れる。trackの`mute/ended`とAudioContextの`closed`を監視する。
- **未実装:** AudioWorkletの連続番号はアプリが処理したsample数であり、入力capture位置・`currentFrame`・単調時刻との照合ではない。ブラウザー内の入力時間不連続を検出し、既知gapを記録する仕組みは未完了。
- **未実装:** IndexedDBの`persist()`許可・使用量／残量見積もりはない。read/write probeは録音準備時の書き込み可能性確認に限られ、quota不足を事前に保証・予測しない。
- **未実装:** 録音品質`normal / gaps / tailUnknown`の状態分離。現在は正常停止／復旧状態と`tailUnknown`が中心で、一時mute復帰区間や既知gapをtakeに記録しない。
- 無音を欠落と判定しない。ブラウザーが入力取得前に失ったサンプルまで完全検出できるとは保証せず、疑わしい時間不連続は「不明区間」として記録する。
- 未確定音声は最大2秒相当を目標とし、上限到達・quota失敗時は録音ゲートを閉じ、保存可能な分を確定してエラー表示する。steady-state working buffer、commit遅延、quota時の実挙動は実測未完了。

### 5.3 クラッシュ復旧

- **実装済み:** 起動時に`recording`状態のtakeを`recovered`・`tailUnknown`として表示可能にし、commit済みchunkからWAV出力・転送できる。WAV書き出し時にchunk順序、ヘッダー、frame連続性を検証する。
- **未実装:** ローカルchunkのSHA-256を用いた起動時再検証と、既存takeを上書きしない独立した復旧manifest生成。現在はtake状態を更新する方式で、末尾frame・既知gapの完全な復旧台帳はない。
- クラッシュ後に存在しない末尾は推定生成しない。未commit分、サイトデータ削除、端末故障の保全は保証しない。
- 再録音は新takeとして開始する。初版で複雑な途中再開・segment連結を作らない。
- IndexedDBのpersist許可・残量確認は未実装。必要な音源はWAVとして別途保存し、サイトデータ削除・端末故障・未commit分のリスクを説明する。

---

## 6. 開始／停止制御を最小状態機械にする

### 状態

録音状態: `waiting → ready → recording → stopped`  
回収状態: `idle / transferring / waitingConnection / draining / hostStored / exporting / exportReady`

録音と回収は並行する別の状態機械にする。別軸として録音品質`normal / gaps / tailUnknown`、接続`connected / reconnecting / offline`を持つ。品質状態の分離は未実装。転送完了は録音が正常だったという意味ではない。

### 開始

1. 両者が認証・マイク・AudioContext・DB書き込み試験を完了し、`READY`を送る。
2. ホストが参加者名を確認し「録音開始」。両者はcontrolで短い往復時刻測定を行う。
3. ホストはtake ID・event ID・開始予定時刻を含む`START`を送り、ACKを確認する。準備の余裕は2秒を初期値とする。
4. participantは同じeventを一度だけ処理し、実開始frame・時刻を返す。
5. ACK不着／開始確認不着は開始失敗と表示し、双方へ停止要求。片側だけ録れた音源は未成立takeとして保存する。

原子的な「全員同時開始」はネットワーク障害下で保証できない。開始途中の断は未成立takeとして新takeを作り直す。途中参加は初版禁止。

### 停止・回線断

- `STOP`もtake/event ID付きで冪等処理し、末尾flush・DB commit・正常manifest固定後にACKする。
- ACK待ち5秒、最大3回再送。不達の場合は相手側未確認と表示し、自分の録音停止だけは完了させる。
- 通話／control断でも録音は継続。相手状態不明を表示し、各端末に常時「自分の録音を停止して保存」を用意する。
- 初版はpause／resumeなし。区切る場合は停止し、新takeを開始する。
- 正常STOP不達、クラッシュ復旧takeは「正常セッション完了」にはしないが、保存済みWAVの回収は可能にする。

---

## 7. 録音中の逐次回収・早期退出とブラウザー内保存

### 7.1 一つの接続・一つずつの転送

**実装状況:** 認証済みPeerConnection上のreliable ordered DataChannel、1チャンクずつの送受信、16 KiB以下のmessage、64 KiB送信buffer上限、ホスト保存後ACK、hash／manifest検証、inventory突合・再送は実装済み。送信間隔は65 ms固定で、約2 Mbps相当のpacing。RTT・損失・ホスト保存遅延に応じた上限の増減・停止は未実装で、2時間・実回線での通話保護も未検証。

- 初版は2人通話のRTCPeerConnectionをcontrolとDataChannel回収にも利用する。controlとマスター用は別DataChannelとし、接続・証明書・認証の追加は避ける。ただし共通回線・SCTPを共有するため、別channelだけで通話／control優先を保証しない。
- **録音中は1秒WAVのDB commit直後から未回収順に転送**する。録音処理は転送やホストACKを待たない。ホストは受信WAVチャンクをIndexedDBへ保存してからACKする。送信hash等の仕事で保存が遅れる場合は転送を先に抑制する。
- reliable ordered DataChannelで、未ACKチャンクは1個だけ。16 KiB以下のメッセージへ分割し、実`maxMessageSize`以内にする。
- 送信buffer上限64 KiB、低水位16 KiB、ホストcreditは1チャンク。`bufferedAmount`・`bufferedamountlow`とホストACKでbackpressureをかけ、キューはDBに置く。録音の未commitキュー上限2秒と、保存済み転送待ちbacklogを混同しない。
- 最小の速度制御はメッセージ間隔によるpacingとし、録音中の初期payload上限2 Mbps、良好時の上限4 Mbpsを検証値とする。monoマスターの生成速度1.152 Mbpsを上回る余裕が必要で、回線容量を自動的に保証する値ではない。
- 既存の5秒統計で損失率が3%超、RTTが300 ms超／直近安定値から100 ms超増加、ホスト書込遅延、録音キュー警告のいずれかが続く場合、送信上限を半減する。接続断・強い悪化時はマスター送信を停止する。値はPoCで調整する。
- 3回連続で良好なら送信上限を段階的に戻す。急な増減を避け、統計未取得時は保守的な上限を使う。保存済みbacklogが増えても通話を犠牲にして無制限送信しない。
- 停止時は末尾flushと最終manifestを確定し、**残りだけを継続転送**する。通話が続いている間は同じ制限を維持し、両者が通話終了を選んだ後に送信上限を緩める。録音停止で通話を強制終了しない。
- packetの最大サイズだけでなく、受信チャンク長、分割数、総frame、manifest件数も制限する。
- manifest版・take ID・sequence・WAV hashで未回収分を照合。別hashの同一IDは拒否する。
- 再接続後は端末鍵を確認して保存済み一覧を交換し、未確定チャンクだけ再送する。

### 7.1.1 未回収量と終了待ち時間

- 画面に「ゲスト端末保存済み」「ホスト端末保存確認済み」「未回収MB／音声秒数」「転送速度」を表示する。送信済みだけでは回収済みと数えない。
- 終了待ち時間は、未ACKバイト量／最近のACK確定速度＋末尾・manifest確認時間で推定する。停止・回線断時は数値を断定せず「推定不可」とする。
- 初版2時間monoでは約1.04 GB／人、生成速度144,000 B/s。回収のACK確定速度が生成速度未満ならbacklogは増えるので、即退出は保証できない。録音中から警告する。
- 回線とホスト保存が十分ならbacklogを数秒程度に保ち、停止後は最後の1秒未満の音源とmanifestだけを待つことを目標にする。

### 7.1.2 未送信量・ネットワークのUI設計

目的は「録音が保存できているか」「転送が追いついているか」「いつ退出できるか」を常時判断できること。初版は数値カード、一本の進捗バー、直近60秒の小さな折れ線だけを作り、監視ダッシュボードや重いグラフライブラリーは導入しない。

**画面配置**

| 領域 | 常時表示する内容 |
| --- | --- |
| 録音ヘッダー | 録音時間、録音／通話状態、マスター形式「24bit / 48 kHz WAV」、入力レベル |
| 転送状況カード（最も目立つ） | 未回収合計MB・音声秒数、その内訳「未送信」「送信済み・確認待ち」、ホスト保存確認済みMB |
| 回収進捗バー | ローカル保存確定分を分母に、ホスト保存確認済み／未回収を表示。録音中は総量が増えるため「保存済み分に対する回収率」と明記 |
| 転送速度カード | マスター送出の実測Mbps、ホスト保存ACK確定速度Mbps、設定中の送信上限Mbps |
| 小グラフ | 直近60秒の送出速度・ACK確定速度、生成速度1.152 Mbpsの基準線。色だけでなく線種とラベルで区別 |
| 終了案内 | 録音中は「現時点で停止した場合の回収待ち目安」、停止後は「退出までの残り目安」、最終ACK後は「ホスト保存済み・退出可能」 |
| 詳細を開く | 通話送受信kbps、RTT ms、通話packet loss %、jitter ms、取得可能なconcealed samples、ICE接続経路、送信buffer KiB、ホスト保存ACK待ち時間 |

participantは自身の転送を表示し、hostは自分のローカル保存とゲスト音源のホストIndexedDB保存状況を別カードにする。ゲストの未送信量はcontrol経由の通知が必要で、ホストの受信量から推測しない。最終WAV書き出しの進捗はホスト側だけに表示し、参加者の退出条件に混ぜない。

**残量の定義**

- 「未送信」: DB commit済みWAVのうち、現在の転送世代でDataChannelへ未投入の有効バイト。
- 「送信済み・確認待ち」: DataChannelへ投入したが、ホスト保存ACK未確認の有効バイト。ネットワークbuffer・受信中・保存検証中を含み、ホスト端末へ保存済みとは呼ばない。
- 「ホスト保存確認済み」: 形式・hash検証後にIndexedDB transactionをcommitしたことをACKで確認したチャンク。再送で同じチャンクを二重加算しない。
- 「未回収合計」= commit済み総量 − ホスト保存確認済み量。未送信＋確認待ちと一致するよう、転送世代・チャンクoffsetを管理する。
- 切断時は未ACK分を再送対象へ戻す。確認待ちから未送信へ移っても未回収合計は変えない。再接続の保存済み一覧照合後に補正する。
- 録音中の未commit音声は「ローカル保存待ち」として別表示し、転送残量には混ぜない。停止後は末尾commit・manifest確認を完了するまで、バイト残量0でも退出可能と表示しない。
- 残量MBはWAV有効バイト、音声秒数は未回収PCMフレーム数／48,000から算出する。WAVヘッダーを音声時間に含めない。MBは10進、bufferはKiBと明記する。

**速度・統計の定義と更新**

- マスター送出速度は、`getStats()`の対応するmaster DataChannel `bytesSent`の差分×8／統計timestamp差から算出する。これはブラウザー統計上の送出payloadであり、ネットワーク全体の実効容量ではない。
- 対応統計が取れない場合は、アプリの`send()`投入量を「送信キュー投入速度」として表示する。実送出速度へ名前だけ置き換えない。
- ACK確定速度は、新しくホスト保存確認済みになったWAVバイト量の差分×8／時間差。ディスク・検証速度も反映するので、単なるネットワーク速度と区別する。
- 通話はRTPの`bytesSent/bytesReceived`差分をkbps表示。「Opus上限32 kbps」は設定値として分け、実測値と混同しない。RTTは取得元（通話RTCP／ICE候補ペア）を明記し、利用可能な方だけ表示する。
- 損失率は通話RTP統計の区間差分で算出し、DataChannelの損失率とは呼ばない。負の差分・counterリセット・接続世代変更はその区間を無効として処理する。
- ローカル残量・buffer・表示は最大1秒間隔、`getStats()`は2秒間隔、ゲスト→ホスト状況通知は2秒間隔・最新状態だけとする。現状は統計取得まで実装済みだが、計画にある5秒集約の速度制御判定・pacing変更は未実装。
- 速度は瞬時区間値と直近10秒平均を区別し、残り時間は平均ACK速度から計算する。録音中の残り時間は「今停止した場合」の推定であり、録音を続けながらbacklogを解消する時間とは別物。
- 未取得は`— / 未対応`、切断・古い通知は「更新停止」と最終更新時刻を表示する。取得不能を0 Mbps／損失0%／良好として扱わない。
- 履歴はメモリーの固定長リングbuffer（60秒）だけ。チャンク配列の全読込、毎秒DB全件集計、サーバーへの統計保存を行わない。

**状態と操作**

- 通話品質とマスター回収状況を別バッジにする。「通話は良好／回収が遅れています」が同時に表示できるようにする。
- 回収状態は「転送中」「通話優先で速度制限中」「接続待ち」「ホスト保存確認待ち」「ホスト保存エラー」「退出可能」をテキストとアイコンで表示する。
- 回収ACK速度が生成速度未満の状態が10秒継続、または未回収音声が5秒を超える場合、終了待ちが増える注意を表示する。ホスト不在、保存容量不足、録音異常は理由と操作を明示する。閾値は検証で調整する。
- 現状の操作は転送状況の表示・詳細表示と転送再試行。転送一時停止／再開と手動通話再接続は未実装で、初版必須機能には含めない。転送停止で録音・通話を止めない。
- 色だけに依存せず、高コントラスト・数値の単位・グラフのテキスト要約を提供する。数値の毎秒変化を読み上げず、状態変化・エラー・退出可能だけを控えめに通知する。

### 7.2 IndexedDBと台帳の不一致を復旧可能にする

音源チャンクとtake台帳は可能な限り同じIndexedDB transactionで保存する。

`receiving → verified → indexedDBCommitted → ACK`

- 受信WAVチャンクの形式・hashを検証し、チャンクとtake台帳をIndexedDB transactionで保存してからACKする。
- manifest受信時はIndexedDB上の全チャンク、frame連続性、WAVヘッダー、hashを再検証し、takeを保存完了にする。
- 再起動後はIndexedDBのチャンクと台帳を突合し、不足・破損チャンクはゲストから再取得する。
- 完成WAVは必要時に元チャンクから書き出す。書き出し中のファイルを完成品として表示しない。
- IndexedDBはブラウザーの容量制限・サイトデータ削除・端末故障の影響を受ける。必要な音源は別途WAVとして書き出し、バックアップする。

### 7.3 出力・終了

- ホスト自身のチャンクも同じ検証工程へ通す。
- 参加者の退出条件は、末尾を含む最終manifestのホスト保存・全チャンクのhash／frame照合・回収台帳commit・`HOST_STORED`最終ACK受信とする。ACK喪失時は再照合して再発行する。
- **`HOST_STORED`後はparticipantが退出可能。** 最終WAV生成・ホスト自身のWAV出力・他takeの処理を待たせない。録音品質が復旧／欠落ありでも、受け取れた範囲と限界を確認した回収ACKを正常録音とは区別して返す。
- WAVチャンクのdataだけを順番にstream書き込みし、非圧縮PCM24/48 kHzの最終WAVを作る。WAVファイル自体を単純連結しない。
- 最終WAV書き出しはホスト上のIndexedDB保存チャンクのみから行い、参加者やネットワークへの依存を残さない。生成失敗・ホスト再起動後もチャンクから再生成できる。初版は録音中の完成WAV追記を行わず、受信チャンク保管と最終exportを分離する。
- 1ファイルの出力上限は初版1 GiB（ヘッダー込み）。超える場合はフレーム境界で複数の通常WAVへ分割。RF64・ZIP・全量Blobは作らない。
- participantの救済書き出しも同じstream exporterを使う。両者Chrome/Edgeに限定することで別ブラウザー向け巨大Blob実装を避ける。
- ホストの受信音源・台帳・鍵はorigin内DBへ保持する。必要な音源はWAVとして書き出す。
- ホスト不在時はparticipant DBへ保留。双方オンラインでなければ転送できない。
- 未回収時の退出は警告し、WAV救済を案内する。`beforeunload`だけに頼らない。
- 正常／復旧／欠落ありtake別に「ホスト保存済み・退出可能」と「最終WAV出力済み」を別表示する。participant自動削除なし、明示操作だけ。

---

## 8. 指摘事項への最小対策一覧

| 問題 | 初版で入れる対策 | 後回しにするもの |
| --- | --- | --- |
| 保存後hashだけでは欠落を検知できない | 2件の保存待ち上限、Worklet出力frame連続性、track状態監視は実装済み。capture位置・gap状態の記録は未実装 | ADC内部欠落の完全保証 |
| クラッシュでfinalizeできない | interrupted takeの復旧表示・WAV出力は実装済み。独立復旧manifest、ローカルhash突合は未実装 | 自動take連結・失った音の推定 |
| 開始／停止の不達 | READY/START/STOP/ACK、event ID、実開始確認、各端末停止 | 分散合意、途中参加、pause |
| 偽ホスト・署名中継 | Web Crypto署名とnonce・DTLS fingerprint binding、participant鍵pin | アカウント、ホスト移譲、鍵ローテーション |
| TURN資格乱用 | TURNは一旦保留。permit／短命資格のコードはあるが、資格・secret設定、発行、relay試験を行わない | 保留解除時に費用hard cap・停止手順・provider設定を再評価 |
| ファイルとDBが不一致 | 書込→検証→台帳→ACK、起動時突合 | 独自ファイルシステム・常駐アプリ |
| 録音中転送が通話を圧迫する | 1チャンクcredit、小buffer、pacing、悪化時半減／停止 | 独自輻輳制御、複数人帯域分配 |
| 終了後に退出待ちが長い | 録音中の逐次回収、残量／待ち時間表示、ホスト保存ACKで退出 | 録音中の完成WAV生成 |
| 長時間救済でメモリー不足 | 両者Chrome/Edge、stream保存、1 GiB分割WAV | Safari・モバイル、RF64 |
| 合格基準が曖昧 | 下記の数値基準・障害注入テスト | 本格監視基盤 |
| 未回収データ削除 | 自動削除なし、未回収退出警告、WAV救済 | クラウドバックアップ（要件上不採用） |

---

## 9. 最小の実装順序と合格基準

数値は初期の**検証目標**であり性能保証ではない。満たさなければ公開・多人数拡張せず原因を調べる。

### Step 1: ローカル録音・復旧だけ

成果物: 録音、停止、1秒WAV保存、一覧、正常／復旧WAV出力、残量表示。

**実装状況:** PCM24/48 kHz/mono、1秒WAV chunk、IndexedDB保存、2時間上限、interrupted take表示、chunk順序・frame・WAV形式を検証する書き出しを実装済み。専用Worker、local chunk hash、独立復旧manifest、storage quota/persist確認は未実装。

**検証状況:** `npm test`は60件成功。ffprobe／DAW確認、2時間合成入力、frame欠落0、未flush 0、32 MiB、commit遅延p95、強制終了復旧率は未測定。

- PCM24/48 kHz/monoをffprobe・DAWで確認。出力PCMと保存チャンクのPCM hash一致。
- 2時間の合成入力で取得→保存のframe欠落0。通常終了で未flush frame 0。
- 録音パイプラインの未確定音声は最大2秒、steady-state working buffer目標32 MiB以内。UI・ブラウザー全体のメモリーとは別測定。
- commit遅延目標p95 500 ms以下。上限超過では黙って録音を続けず異常停止・表示。
- 強制終了後はcommit済みチャンク100%復旧。未commit分の保全は保証しない。

### Step 2: 招待・認証・2人Opus通話

成果物: URL作成、名前入力、ゲスト承認、native音声、接続状態、限定的な自動再接続。TURNはpermit付き短命資格で利用し、失敗時はSTUNへフォールバックする。

**実装状況:** 招待、承認、署名・DTLS fingerprint認証、2人Opus、READY、ICE restart、接続統計を実装済み。Opus優先設定はあるが、選択codecと実回線品質の確認は未完了。ICE restartは最大3回で、計画上の30秒復帰基準と手動再接続UIは未検証／未実装。

**TURN統合状態:** Workerはホスト承認後にpermitを検証して短命資格を発行し、両端へ配信する。両端のPeerConnectionは配信資格を使い、発行失敗時はエラーを表示してSTUNへフォールバックする。診断は選択中ICE candidate pairを表示する。単体`turn-test.html`の成功は実通話統合の成功を意味しない。自動テストは成功したが、ローカル資格設定がないため2台relay実機試験は未実施。両端で`relay → relay`を確認するまでrelay通話成功と扱わない。資格を伴う本番secret設定・deploy・接続保証は対象外で、別途承認が必要。

ローカル確認は`npm install`、必要な場合は`.dev.vars`へローカル専用TURN設定を置き、`npm run dev`で`http://localhost:8787/recorder`を開く。単体テストは`npm test`。本番deployは保留。TURNを含む公開範囲と運用条件は別途判断する。

収録画面では「自分のトラック」とリモート参加者のトラックを分けて表示する。リモート波形は参加者の音声トラック接続後に参加者ごとに生成し、退出・切断時に除去する。波形は受信した通話音声から描画し、マスター録音には混ぜない。初版はホスト1人＋ゲスト1人まで。

- マイク音声は認証完了前に送らない。偽fingerprint・古いnonce・別session署名・別participant鍵を拒否。
- 32 kbps上限、実選択codecがmono/Opusであることと実bitrateを確認。録音処理を止めても通話は継続。
- 上下256 kbps・RTT 100 ms・損失1%の試験で、2秒超の聞こえない区間0を目標にする。concealed samples等と試聴を併記し、音質合格は別判定。
- 回線復帰後30秒以内の再接続を目標。未達でも録音継続／ローカル停止が可能で、手動再接続手段を示す。
- ローカル2台でのTURN relay経路、双方向音声、DataChannel転送、permit／資格発行失敗時のSTUN fallbackを個別に検証する。Cloudflare本番secret・deploy、費用上限・運用・公開判断は本番運用の別承認後に行う。

### Step 3: 開始／停止・録音中回収・早期退出

成果物: READY/START/STOP、実開始確認、逐次WAV回収、pacing、manifest突合、ディスク検証後ACK、退出可能表示。

**実装状況:** READY/START/STOP、予定時刻・実開始確認、録音中の逐次回収、ホスト保存後ACK、manifest/inventory突合、転送状況カード、60秒グラフは実装済み。pacingは約2 Mbps相当の固定65 ms間隔で、回線状態連動の速度調整は未実装。実機挙動・数値合格基準は未検証。

- 人為的なACK遅延・再送・接続断・counterリセット・統計未対応で、残量の二重計上、誤った0表示、早すぎる退出可能表示がないことを検証する。
- 低速回線では生成速度を下回るグラフとbacklog増加が一致し、ホスト保存遅延と通話の回線悪化を別状態で表示できることを確認する。
- UI・統計表示を有効にした2時間試験でも、録音のframe欠落0と固定長メモリーの基準を維持する。ホストのゲスト表示は更新停止を検知し、常時録音データの全件読込を行わない。

- control重複／ACK喪失でも同じtakeを二重開始しない。片側開始・片側停止は状態不明として報告する。
- 起動時にファイルと台帳の各中断状態を復旧できる。
- 2人×2時間のPCM24 monoは合計約2.07 GB、ゲスト転送分は約1.04 GB。双方の上り下り各4 Mbps以上、RTT 100 ms以下、損失1%以下、ホスト保存ACK処理p95 500 ms以下の試験条件で、2時間録音中のbacklog目標5秒以下、停止から退出可能ACKまで目標10秒以内とする。
- 帯域制限256 kbps／損失増加ではbacklog増加を許容し、Opus通話とローカル保存を優先できることを確認する。回復後に未回収分だけ追いつき転送し、ACK喪失・再接続でも重複保存しない。
- 同一接続の小buffer／pacingで通話目標を満たせない場合に限り、マスター用の別RTCPeerConnectionを追加する。別接続でも同一物理回線の競合は残るため速度制限を維持する。
- ホストが全音源と最終manifestを保存した後は、participantを退出させてから最終WAV生成・再生成に成功することを確認する。
- 転送前後のhash一致、欠番0、未finalize者を正常完了扱いしない。
- 既知同期イベントによる開始位置差20 ms以内を目標。2時間のドリフトを測定・表示するが初版は自動補正せず、編集ソフトで手動調整する。

### Step 4: 最小公開前検証

**状態: 未完了。現時点では本番deploy・一般公開をしない。** TURN保留中はSTUN直接接続の限定的な検証にとどめ、relay必須回線への対応を約束しない。TURNを有効化する場合は別途承認後に4.3の運用・費用条件を満たす。

- 2時間実機試験、DB遅延、マイク切断、AudioContext停止、quota不足、タブ強制終了、ホスト不在、ACK喪失、ディスク満杯。
- サーバーDB/storage/R2/永続attachment呼び出し・音源受付・秘密ログがないことを確認する。
- STUN直接接続とTURN relayの2台実機試験、認証、録音開始差、再接続、転送、音源再生成を確認する。TURNの本番provider設定・課金運用確認は別途行う。
- rate limit binding、namespace、秘密情報の設定有無を確認する。TURNのTTL・providerログ保持・hard cap・課金停止手順は保留解除前に再評価する。
- 限定した個人招待で2人の全合格基準を満たすまでは公開しない。合格後も多人数拡張は別判断とする。

---

## 10. 初版では作らないもの

- 3〜4人mesh／SFU、ビデオ、通話録音、ミックスダウン。
- PCM16事前量子化、カスタムOpus、独自FEC/DTX、SDP書き換え、自動bitrate制御。
- 複数PeerConnectionによる回収、多人数帯域分配スケジューラー、独自輻輳制御。初版の同一接続control／マスター用DataChannelと簡単なpacingは実装する。
- pause/resume、途中参加、ホスト交代、自動take連結。
- 独自48 kHzリサンプラー、stereo、ディザ設定、RF64。
- 自動ドリフト補正。同期offset・実開始・ドリフト計測は残す。
- Electron/Tauri、PWA無人転送、全ブラウザー互換。
- アカウント、自由公開、課金、クラウドDB・保管・バックアップ。

### 後続拡張の条件

最小版が合格し、2人の実利用で不足が確認されたものだけ追加する。

1. 3〜4人: 通話だけmanaged SFUを比較し、host回収は順次実行。SFUの非保存条件・認証bindingは別途検証する。
2. 通話と回収の別接続化: 同一接続のpacing・小bufferでも通話が悪化する場合だけ追加する。録音中回収と1チャンクcreditは初版から実装する。
3. 44.1 kHz処理端末: 必要な利用者がいる場合のみ、検証済みstream resamplerを追加する。
4. 自動同期補正／専用回収アプリ: 実測・実利用の必要性に基づき追加計画する。

---

## 11. 制約・現状・資料

- PCM24 WAVが正しくても、ADCの真の24-bit入力、入力前のサンプル欠落、電源断に対する完全保全は保証できない。
- サーバー保管なしでは、participantの未回収WAV削除や端末故障をhost側で救えない。双方オンラインでの転送が必要。
- 48 kHz AudioContextを実際に得られる端末に限定する。フラグメントや名前だけで接続・認証が成立するわけではない。
- ヘッドホン必須、マイク設定の実適用確認、保存先許可、同意、退出前警告を省略しない。AEC等の無効化は要求するが、実設定の診断表示・IndexedDB persist/quota確認は未完了。
- 実装済み: `prototype/recorder.html`ではAudioWorkletから受けたPCM24 WAVチャンクをIndexedDBへ保存し、take一覧、WAV出力、中断takeの復旧を行う。招待、署名認証、2人Opus通話、READY、予定時刻開始・実開始確認、参加者別波形、録音中DataChannel回収を実装済み。ホストは受信WAVチャンクの形式・SHA-256を検証し、IndexedDB transaction後にACKする。manifest受信時と再接続時は保存chunkを再検証し、欠落・破損を検出して再送する。転送状況UIと60秒グラフもある。
- 未完了: Dedicated Workerへの録音処理分離、capture時刻に基づくgap検出・品質status、ローカル復旧manifest/hash検証、quota/persist確認、適応型pacing、実機・数値合格基準。TURN資格発行とAuth0保護は実装済みだが、実設定・relay試験は保留。
- 2026-10-05: Step 2の招待・承認・署名付きDTLS fingerprint検証・2人Opus通話と揮発性シグナリングの初期実装を開始。TURN資格発行、公開利用の許可、実機／回線試験は未完了。
- 2026-10-05: ホストの録音開始・停止をゲストへシグナリングし、ゲスト側は操作できず同じタイミングで端末内録音するプロトタイプを追加。録音ファイルは各参加者の端末に個別保存される。
- 2026-10-05: 参加者波形Canvasの寸法を固定ラッパー基準に修正。リモートCanvasのサイズ暴走によるブラウザー描画エラーを解消し、静かな入力も表示しやすくした。
- 2026-10-06: 通話中のRTT、jitter、受信packet loss、推定送信bitrate、選択ICE候補種別を5秒ごとに端末内表示する診断を追加。後続の転送時系列グラフにDataChannel実送出速度を提供するため、統計取得間隔を2秒に短縮した。WebRTC統計が取得できない場合や再接続中はその状態を表示する。実際の接続品質・TURN経路はブラウザー間の実回線試験で別途検証する。
- 2026-10-06: ホストの録音状態をevent ID・単調sequence付きで通知し、ゲスト側の重複適用を抑止してACKを返す。ホストはACKを再送し、開始未確認時は録音を停止する。READY状態交換、開始予定時刻、実開始時刻の照合も実装済み。実ネットワークでの開始精度は未検証。
- 2026-10-06: 1セッションの累積録音フレームを2時間で制限し、AudioWorklet側で上限を厳密に適用する。WebRTCの送信bitrate・受信packet loss・concealed samplesは区間差分で表示し、counter resetや未取得値を0として扱わない。
- 2026-10-06: 対応ブラウザーでは保存先へPCM24 WAVヘッダーと各チャンクのPCMデータを順次書き込み、チャンクの形式・順序・frame数を検証してから保存を完了する。File System Access APIがないブラウザーは従来どおり小さいファイルだけBlobで書き出す。
- 2026-10-06: 認証後に双方でマイク・48 kHz AudioContext/AudioWorklet・IndexedDB書き込みを確認し、世代ID・sequence付きREADY状態を交換する。5回のclock probeからRTT最小の有効offsetを選び、ホストとゲストのAudioWorkletを共通の予定時刻へ予約する。実開始frame/時刻をevent IDで照合し、不達・拒否時は状態を警告して停止する。開始差20 ms目標、長時間ドリフト、実ネットワークでの開始精度は未検証。
- 2026-10-06: 信頼性付きordered DataChannelを認証済みPeerConnectionへ追加し、1チャンクずつ16 KiB以下のmessage・64 KiB送信buffer・2 Mbps pacingで転送する。host側はPCM24 WAV/header、hash、sequence、frame連続性を検証し、IndexedDB transaction後にACKする。最終manifest時と再接続時はIndexedDB内のチャンク内容を再検証し、欠落・破損を検出して再送する。受信音源はtake一覧から必要時にWAVとして書き出す。TURN資格・長時間実機試験は未完了。
- 2026-10-06: 回収進捗カードに直近60秒のDataChannel実送出速度・ACK確定速度・1.152 Mbps生成基準線を描画するグラフを追加。ゲストは未送信・送信中・ACK待ちを区別し、世代IDとsequence付きの進捗を2秒間隔でシグナリング経由でホストへ通知する。ホストはゲストの未送信量と送出速度を、自端末の受信保存量とは別に表示する。Workerは通知のサイズ・数値範囲・参加承認状態を検証し、ブラウザー側は世代不一致と古いsequenceを無視する。DB全件走査は接続世代ごとの初回だけとし、以降はcommit/ACKごとのメモリー集計を更新する。実機の転送速度・再接続時挙動は未検証。
- 2026-10-06: ホストが招待部屋を作成しただけでゲストが未接続の場合は、単独録音を開始できるようにした。ゲスト申請中またはPeerConnection接続中は従来どおり録音開始を止め、双方のREADY確認後に同期録音を許可する。
- 2026-10-06: マイクtrackの一時的な`mute`で録音を即時終了しないよう変更。復帰を待ち、5秒以上ミュートが続いた場合だけ復旧可能な形で停止する。`ended`は引き続き即時停止する。
- 2026-10-06: 録音開始約1秒後の停止を修正。最初のPCMチャンクをWAV化する際、未定義の`makeWavHeader`を参照して保存が失敗していたため、PCM24 WAV encoderを共有モジュールへ移してテストを追加。native 44.1 kHz入力も48 kHz AudioContextへのブラウザーresampleで録音できることをChrome fake-mic smoke testで確認した。
- 2026-10-06: 録音準備時にステレオ入力trackを誤って拒否しないよう、AudioWorklet入力をmonoへdownmixする設定を使う。転送chunk indexからIndexedDBの無効なboolean keyを除き、接続世代の文字列indexで走査するDB v3 migrationを追加。
- 2026-10-06: IndexedDBへのチャンク保存が1秒をまたいだだけで録音を止める過剰な判定を除去。通常チャンクは最大2件の保存待ちを許容し、録音停止時の最終チャンクは常に保存queueへ入れる。上限超過時だけ明示的な保存エラーで停止する。
- 2026-10-06: Workerに短命TURN資格の発行、Cloudflare Rate Limiting binding、オフラインEd25519署名の部屋permit検証を追加（旧方式。後にAuth0へ置換）。permitは部屋ID・ホスト公開鍵hash・期限・ゲスト上限1人へ束縛し、TURN資格はDurable Objectのメモリーにのみcacheする。管理者向け鍵／permit発行CLIとホスト入力欄を追加した。
- 2026-10-07: PLANと実装の差異を再確認。Node.jsの単体テスト60件は全成功。2時間・実回線・開始差・backlog・メモリー・commit p95などの合格基準は未測定。TURNは利用者判断により一旦保留し、資格設定・permit発行・relay試験・公開有効化を行わない。TURN発行コードは残すため、環境secret等が設定済みでないことも別途確認する。
- 2026-10-07: TURN単体ページでの資格・relay疎通確認と実通話統合を区別。受信TURN資格のrequest ID照合、両端PeerConnectionへの適用、選択中ICE pair診断の自動テストを追加し`npm test`69件成功。ローカル`.dev.vars`がないため2台実通話relayは未検証。本番secret設定・deploy・公開運用は引き続き対象外。
- 現在: ホスト向けAuth0ログインとWorker側JWT/permission検証、ゲストの匿名招待参加、TURN資格発行のホスト認証を実装。旧permitコード・CLI・UIを削除し、`TURN_SETUP.md`をAuth0設定手順へ更新。76件のテスト、Auth bundle生成、Wrangler deploy dry-runは成功。実Auth0/Cloudflare設定、実ログイン、relay実機試験、本番deployは未実施。

参照資料:

1. [RTCRtpSender.setParameters / maxBitrateと互換性](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
2. [WebRTC perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
3. [W3C WebRTC / ICE・DataChannel・DTLS](https://www.w3.org/TR/webrtc/)
4. [WebRTCコーデック](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)
5. [RTCDataChannel / メッセージ上限とbuffer](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
6. [AudioWorkletProcessor.process](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process)
7. [File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
8. [Storage quota / eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
9. [Cloudflare managed TURN / UDP・TCP・TLS](https://developers.cloudflare.com/realtime/turn/)
10. [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
11. [Cloudflare Workers Rate Limiting binding / locationごとの制限](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)