# 完了済みlocal-only成果物の後日公開

完了taskを再実行せず、元runのmode・lease・結果・開発操作台帳を変更せずに、別の明示承認で固定headをpushし、epic宛てdraft PRまで作成する。モデルを呼ばず、mergeや配備はしない。

## 承認と権限

管理者は対象repoのregistryに `approvedPublicationAllowed:true` を明示する。省略/falseでは後日公開workerは停止する。既存の `publishAuthorized` は新規開発taskの自動公開可否であり、別の設定である。local-onlyを維持する配置では `publishAuthorized:false` のままにする。

既存ownerのviewer資格情報は、従来のtask作成・cancelと同様に操作権限を持つ。公開承認APIはviewerだけ、公開台帳の操作はworkerだけが実行できる。どちらも同じownerのレコードだけにアクセスする。新credentialや認証権限の追加は不要。資格情報をモデルに渡さない。モデルが返した `approved:true` は利用者承認の代替にならず、運用担当が利用者の対象承認を受けた後にのみAPIを呼ぶ。

`POST /api/development/publications` に `Idempotency-Key` と次のJSONを送る。ownerは認証主体から決定し、callerから受け付けない。

```json
{
  "taskId": "00000000-0000-0000-0000-000000000000",
  "artifactId": "<64桁のmanifest SHA256>",
  "repoId": "local-GPT-live",
  "headSha": "<承認された40桁の成果物commit>",
  "baseRef": "epic/transport-playback",
  "baseSha": "<成果物作成時の40桁base commit>",
  "remoteBaseSha": "<公開前に再確認した現在のepic commit>",
  "title": "利用者の承認範囲に含まれるPRタイトル",
  "body": "公開する説明と検証結果。秘密や生ログを含めない。",
  "approved": true
}
```

artifactIdはhead SHAとは異なる。成果物ファイル名の64桁hashを使う。taskはsucceededかつleaseと容量hold解放済みである必要がある。SQLiteの完了結果とartifact操作結果、ローカルの保護されたmanifest、Git commitの親/head/blob、実ファイルの内容・mode、固定repo ID・visibility・push権限を照合する。変更パス・ファイル数・出力量・秘密らしい文字列も再検査する。baseは許可されたepicだけで、任意root/argv/shell/remoteは入力できない。

承認は1時間有効。同じkeyの再送は同じ承認を返し、内容変更は409。未予約で期限切れの承認は、新しいkeyと明示承認によってのみ置換できる。旧レコードはsupersededとして保存する。pushまたはPRが一度でも予約された場合は自動置換しない。

## 実行と再試行

既存の安全な環境変数供給経路を使う。tokenをコマンド引数やログへ出さない。

```sh
# 対象JSONとkeyは運用担当が利用者承認を照合して指定する。
# CONTROL_URL / VIEWER_TOKEN / PUBLICATION_REQUEST_FILE / PUBLICATION_KEY
node --import tsx scripts/publication-approve.ts

# 返されたIDを指定。CONTROL_URL / WORKER_TOKEN / DEVELOPMENT_REGISTRY_FILE / PUBLICATION_ID
node --import tsx scripts/publication-worker.ts
```

workerは単発で、モデル・定期poller・元runを起動しない。`GET /api/development/publications/<id>` で承認、状態、push/PRの操作台帳を確認できる。GUI/MCPへの承認ボタンは今回追加していない。

公開前に現在のepic SHAを照合し、fetchしたそのSHAと成果物の `merge-tree` で競合を検査する。Git refや成果物をrebase/mergeしない。公開先featureは不存在またはexact headだけを許す。pushは空refを期待するcompare-and-swap（空のforce-with-lease）で新規作成し、既存branchを上書きしない。PRは同じrepositoryのexact head・base・draft・タイトル・本文を照合する。既存のclosed/merged/non-draft PRや別内容のPRは停止する。

各外部writeはSQLiteのpublication_operationsへ先に予約する。最初の予約だけがwriteを実行でき、予約済みはremote照合のみ行う。応答喪失後にremoteが一致すれば結果を確定できるが、結果不明ならoperation_blockedで停止する。TTLで予約を消さず、二重送信や別キーでの迂回をしない。完了台帳を再読するときも現remoteを照合する。期限後は既存予約のremote結果記録だけ可能で、新しいwrite予約は不可。

GitHubの変更とSQLiteの更新は分散トランザクションではない。ref/PRの外部変更との完全な原子性やexactly-onceは保証しない。承認後のbase変更、競合、権限変更、成果物変更、不明な副作用では止まり、運用担当が現remoteと承認範囲を再確認する。予約済みの不明結果を強制解除するAPIは提供しない。host subprocessは固定argv・shell:false・10分の独立deadline guardで停止する。

## 配備・検証・rollback

`0005_publications.sql` を追加した。control-planeと単発publication workerを同じ版に更新し、migrationを適用してから明示実行する。既存モデルworkerの再起動はこの公開経路には不要。registryの専用許可は別途運用担当が設定する。このPR自体では配備環境・token・成果物・remote branchを変更しない。

導入時の検証記録：検証は実SQLiteの承認/owner/競合/期限/再承認、remote fixtureの応答喪失/重複/変更検出、実Gitの0600/実行可能ファイルと改変拒否、ローカルD1と認証APIを含む。既存の承認済みbrowser成果物は読み取りだけでmanifestとGit内容の照合成功を確認した。実GitHub push/PRは未実施であり、fixture成功を外部公開成功とは扱わない。

rollback時は新規承認・publication workerを止め、前版へ戻す。追加2テーブルと元run/成果物は保存する。予約済みの副作用を不明のまま削除しない。既存の開発/定期run台帳を変更するdown migrationは不要。
