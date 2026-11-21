# Japan Diet Proceedings Search (Kokkai)

Search public Japanese National Diet proceedings through the National Diet Library (NDL) search API. The Actor writes one dataset item per matching speech or meeting, with links back to the original proceedings. No API key is required. [NDL API documentation](https://kokkai.ndl.go.jp/api.html)

| Mode | Dataset item |
| --- | --- |
| `speech` (default) | One matching speech, including its text and meeting metadata. |
| `meeting_list` | One matching meeting with links to matching speeches when available. |
| `meeting` | One matching meeting with the text of all speeches in that meeting. |

The `meeting` mode returns up to 10 meetings per request. With `maxResults: 1000` and that many matches, expect about 100 requests and five minutes or more at the default request interval.

## Input examples

Include at least one search condition, such as `any`, `speaker`, `nameOfMeeting`, or `from`. Use spaces between keywords to require every term. Use spaces in `speaker` or `nameOfMeeting` to match any term. Dates use `YYYY-MM-DD`. With a single session bound, the API searches that session only. [NDL search parameters](https://kokkai.ndl.go.jp/api.html)

Find up to five speeches mentioning generative AI from January 2025 onwards.

```json
{
  "any": "生成AI",
  "from": "2025-01-01",
  "maxResults": 5
}
```

Find House of Representatives budget committee meetings in a date range.

```json
{
  "mode": "meeting_list",
  "nameOfHouse": "衆議院",
  "nameOfMeeting": "予算委員会",
  "from": "2025-01-01",
  "until": "2025-03-31",
  "maxResults": 20
}
```

## Example dataset item

This abbreviated speech item uses illustrative values. In the meeting modes, `speechRecord` contains an array of speech records. The Actor uses `speechId` and `issueId` for identifiers and numbers for `session` and `speechOrder`.

```json
{
  "speechId": "121705261X00120250124_001",
  "issueId": "121705261X00120250124",
  "session": 217,
  "nameOfHouse": "衆議院",
  "nameOfMeeting": "本会議",
  "date": "2025-01-24",
  "speaker": "発言者名",
  "speechOrder": 1,
  "speech": "生成AIの利用について議論します。",
  "speechURL": "https://kokkai.ndl.go.jp/txt/121705261X00120250124/1"
}
```

## Use cases

- Monitor policy debates by tracking keywords and committees over time.
- Find primary sources for media research and link readers to the proceedings.
- Feed speeches and source links into retrieval-augmented generation (RAG) or AI agents.

### Policy monitoring with a daily keyword search

Create an Actor task with this input and schedule it to run daily. This example tracks Diet speeches mentioning generative AI.

```json
{
  "mode": "speech",
  "any": "生成AI",
  "onlyNew": true,
  "stateKey": "policy-generative-ai",
  "maxResults": 100
}
```

The first run can output existing matches. Later runs skip results already saved under the same key. `maxResults` caps the number of new items written per run. The `kokkai-speech-search-state` key-value store keeps up to 20,000 successfully saved IDs per key, using `speechId` for speeches and `issueId` for either meeting mode. A failed push can be retried on the next run if the search still returns the record.

Reuse the same key for the same search and give each different search its own key. Run one task at a time per key. Results arrive newest first, so the Actor can stop after a page of already saved records. Use a regular search for historical backfills.

## Request pacing and reuse

The Actor sends requests sequentially. `requestIntervalSecs` defaults to `3` seconds, and retries can take longer. Keep searches focused and reuse saved datasets to reduce repeat requests. [NDL API terms of use](https://kokkai.ndl.go.jp/api.html)

Follow the NDL website content terms. Copyright in individual speeches generally belongs to the speakers. The NDL holds copyright in the database and in speeches by NDL staff. Japan's Copyright Act allows certain uses of public political speeches under Article 40 and certain information analysis under Article 30-4, subject to each provision's conditions. Users are responsible for confirming whether their reuse requires permission. [NDL website content terms](https://www.ndl.go.jp/sitepolicy/terms) · [NDL proceedings API terms](https://kokkai.ndl.go.jp/api.html) · [Japan's Copyright Act](https://laws.e-gov.go.jp/law/345AC0000000048)

## Run locally

Use Node.js 22 and the Apify CLI. Save an input example as UTF-8 in `input.json` in this directory and run the following commands.

```sh
npm install
npm test
apify run --purge --input-file ./input.json
```

The local default dataset is stored in `storage/datasets/default/`.

## 日本語

国立国会図書館の公開 API で国会会議録を検索し、発言や会議ごとに原文へのリンク付きで保存します。上の1つ目の例は、2025年1月1日以降の「生成AI」を含む発言を最大5件取得します。政策動向の把握、報道の資料調査、RAG や AI エージェントの参照データ作成に使えます。発言を再利用するときは、利用規約と著作権法の適用条件をご確認ください。 [国会会議録検索 API 仕様・利用条件](https://kokkai.ndl.go.jp/api.html)

### 政策モニタリング: キーワードで毎日スケジュール実行

上の政策モニタリング例を Actor タスクの入力に設定し、毎日実行するようスケジュールします。`onlyNew: true` で「生成AI」を含む発言を検索し、同じ `stateKey` で出力済みの発言を除きます。キーワードやモードの異なるタスクには別のキーを指定します。
