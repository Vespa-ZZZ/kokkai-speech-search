# Japan Diet Proceedings Search (Kokkai)

Search public Japanese National Diet proceedings through the National Diet Library (NDL) search API. The Actor writes one dataset item per matching speech or meeting, with links back to the original proceedings. No API key is required. [NDL API documentation](https://kokkai.ndl.go.jp/api.html)

| Mode | Dataset item |
| --- | --- |
| `speech` (default) | One matching speech, including its text and meeting metadata. |
| `meeting_list` | One matching meeting with links to matching speeches when available. |
| `meeting` | One matching meeting with the text of all speeches in that meeting. |

The `meeting` mode returns up to 10 meetings per request. With `maxResults: 1000` and that many matches, expect about 100 requests and five minutes or more at the default request interval.

## Output fields in speech mode

Each item in `speech` mode has the following fields. Missing values are written as `null`.

| Field | Description |
| --- | --- |
| `speechId` | NDL speech identifier. |
| `issueId` | NDL meeting record identifier. |
| `session` | Number of the Diet session. |
| `nameOfHouse` | House or joint body that held the meeting. |
| `nameOfMeeting` | Name of the plenary, committee, or other meeting. |
| `issue` | Issue number of the meeting record, such as `第1号`. |
| `date` | Meeting date in `YYYY-MM-DD` format. |
| `speechOrder` | Numeric position of the speech in the meeting record. |
| `speaker` | Speaker name as recorded in the proceedings. |
| `speakerYomi` | Japanese reading of the speaker name. |
| `speakerGroup` | Speaker's parliamentary group as recorded in the proceedings. |
| `speakerPosition` | Speaker's title or position as recorded in the proceedings. |
| `speakerRole` | Role in the meeting, such as witness. |
| `speech` | Speech text. |
| `startPage` | Page on which the speech begins. |
| `speechURL` | URL of the speech in the NDL proceedings. |
| `meetingURL` | URL of the full meeting transcript. |
| `pdfURL` | URL of the meeting record PDF, when available. |

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

- Schedule daily monitoring for a bill name such as `子ども・子育て支援法` or a policy keyword such as `生成AI`. Review new matches and use `speechURL` to read each mention in context.
- Follow a committee's proceedings over a session. For example, use `meeting_list` and `nameOfMeeting: "予算委員会"` to build a timeline of Budget Committee meetings, then open each `meetingURL` to read the full proceedings.
- Verify a quotation for a news article by searching for its wording and meeting date, then link to the matching `speechURL`.
- Build a retrieval-augmented generation (RAG) corpus. Export `speech` records for a defined topic and date range, and retain `date`, `nameOfMeeting`, and `speechURL` with each text chunk so answers can cite the original proceedings.

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

On the first run for a `stateKey`, the Actor writes up to `maxResults` of the newest matches and marks the successfully written items as seen. Later runs skip items already saved under that key and can stop at a page made up entirely of seen items, skipping all older matches beyond that page. If the first run reaches the cap partway through a page, older matches left on that page can still appear on later runs. To collect historical matches, run a regular search with `onlyNew: false` before enabling monitoring.

`maxResults` caps new items per run. The `kokkai-speech-search-state` key-value store keeps up to 20,000 successfully saved IDs per key, using `speechId` for speeches and `issueId` for either meeting mode. A failed push can be retried on the next run if the search still returns the record.

When the pay-per-event spending limit is reached, the run stops with a warning. The next monitoring run continues past the earlier cutoff and retries remaining records that still match the search.

Reuse the same key for the same search and give each different search its own key. Run one task at a time per key.

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

上の政策モニタリング例を Actor タスクの入力に設定し、毎日実行するようスケジュールします。`onlyNew: true` の初回は、新しい順に最大 `maxResults` 件を出力し、出力に成功した分を既読にします。次回以降は同じ `stateKey` の既読分を除き、全件が既読のページに達して打ち切ると、それより古い一致は取得しません。初回にページの途中で上限に達した場合、そのページに残った古い一致が次回以降に出力されることがあります。過去分も必要なら、監視を始める前に通常モード（`onlyNew: false`）で取得してください。キーワードやモードの異なるタスクには別のキーを指定します。
