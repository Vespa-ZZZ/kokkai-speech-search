import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildQuery, fetchPage, normalizeRecord, searchPages } from '../src/kokkai.js';

const readFixture = (mode) => JSON.parse(readFileSync(new URL(`./fixtures/${mode}.json`, import.meta.url), 'utf8'));
const speechPage = readFixture('speech');
const meetingListPage = readFixture('meeting_list');
const meetingPage = readFixture('meeting');
const speech = speechPage.speechRecord[0];
const exampleUrl = new URL('https://kokkai.ndl.go.jp/api/speech?any=AI');

async function collectPages(input, options) {
    const pages = [];
    for await (const page of searchPages(input, options)) pages.push(page);
    return pages;
}

test('buildQuery serializes the supported filters, preserving spaces between search terms', () => {
    const filters = {
        any: '生成AI 著作権',
        speaker: '発言者A 発言者B',
        nameOfHouse: '衆議院',
        nameOfMeeting: '予算委員会 本会議',
        speakerGroup: '会派',
        speakerPosition: '大臣',
        speakerRole: '参考人',
        from: '2025-01-01',
        until: '2025-12-31',
        sessionFrom: 217,
        sessionTo: 219,
        searchRange: '本文',
    };
    const query = buildQuery({ ...filters, mode: 'speech', maxResults: 45, requestIntervalSecs: 3 }, 101, 45);
    const expected = { ...filters, startRecord: 101, maximumRecords: 45, recordPacking: 'json' };
    assert.deepEqual(Object.fromEntries(query), Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [key, String(value)]),
    ));
    assert.match(query.toString(), /any=%E7%94%9F%E6%88%90AI\+%E8%91%97/);
});

test('buildQuery omits empty filters and only sends searchRange with keywords', () => {
    const query = buildQuery({ any: ' ', nameOfHouse: '', speakerRole: '', from: '2025-01-01', searchRange: '本文' }, 1, 5);
    assert.deepEqual(Object.fromEntries(query), {
        from: '2025-01-01', startRecord: '1', maximumRecords: '5', recordPacking: 'json',
    });
});

test('searchPages rejects a missing search condition before fetching', async (t) => {
    const fetchImpl = t.mock.fn();
    await assert.rejects(collectPages({ any: ' ', nameOfHouse: '', searchRange: '本文' }, { fetchImpl }), /at least one search condition/);
    assert.equal(fetchImpl.mock.callCount(), 0);
});

test('normalizeRecord emits the requested speech fields and numeric session and order', () => {
    assert.deepEqual(normalizeRecord('speech', speech), {
        speechId: speech.speechID, issueId: speech.issueID, session: 217, nameOfHouse: speech.nameOfHouse,
        nameOfMeeting: speech.nameOfMeeting, issue: speech.issue, date: speech.date, speechOrder: 1,
        speaker: speech.speaker, speakerYomi: null, speakerGroup: null, speakerPosition: null, speakerRole: null,
        speech: speech.speech, startPage: 1, speechURL: speech.speechURL, meetingURL: speech.meetingURL, pdfURL: null,
    });
});

test('normalizeRecord preserves meeting metadata and normalizes nested speech links', () => {
    const raw = meetingListPage.meetingRecord[0];
    const { issueID, session, speechRecord, ...metadata } = raw;
    const { speechID, speaker, speechURL } = speechRecord[0];
    assert.deepEqual(normalizeRecord('meeting_list', raw), {
        ...metadata, issueId: issueID, session: Number(session),
        speechRecord: [{ speechId: speechID, speaker, speechURL, speechOrder: 1 }],
    });
    assert.deepEqual(normalizeRecord('meeting_list', { ...raw, speechRecord: null }).speechRecord, []);
});

test('normalizeRecord preserves the full speech array and text in meeting mode', () => {
    const raw = meetingPage.meetingRecord[0];
    const normalized = normalizeRecord('meeting', raw);
    assert.equal(normalized.issueId, raw.issueID);
    assert.equal(normalized.session, 217);
    assert.deepEqual(normalized.speechRecord.map(({ speechOrder, speech: text }) => [speechOrder, text]), [
        [0, raw.speechRecord[0].speech], [1, raw.speechRecord[1].speech],
    ]);
    assert.equal(normalized.speechRecord[1].updateTime, raw.speechRecord[1].updateTime);
    assert.equal(normalized.speechRecord[1].speechId, raw.speechRecord[1].speechID);
    assert.ok(!('speechID' in normalized.speechRecord[1]));
});

test('searchPages follows the API cursor, enforces the pacing floor and stops at maxResults', async () => {
    const sequence = [];
    const fetchImpl = async (url, options) => {
        const start = url.searchParams.get('startRecord');
        sequence.push([url.pathname, start, url.searchParams.get('maximumRecords')]);
        assert.equal(options.headers['User-Agent'], 'kokkai-speech-search-actor/1.0');
        if (start === '1') {
            return Response.json({ ...speechPage, numberOfRecords: 200, nextRecordPosition: 9 });
        }
        const lastSpeech = { ...speech, speechID: `${speech.issueID}_009`, speechOrder: 9 };
        return Response.json({ ...speechPage, numberOfRecords: 200, nextRecordPosition: 10, speechRecord: [lastSpeech, speech] });
    };
    const wait = async (ms) => { sequence.push(ms); };

    const pages = await collectPages({ any: '生成AI', maxResults: 2, requestIntervalSecs: 2 }, { fetchImpl, wait });
    assert.deepEqual(sequence, [['/api/speech', '1', '2'], 3000, ['/api/speech', '9', '1']]);
    assert.deepEqual(pages.map(({ total, records }) => [total, records[0].speechOrder, records.length]), [
        [200, 1, 1], [200, 9, 1],
    ]);
});

test('searchPages applies per-endpoint page sizes and stops when the cursor is absent or null', async () => {
    for (const [mode, fixture, limit] of [
        ['speech', speechPage, '100'], ['meeting_list', meetingListPage, '100'], ['meeting', meetingPage, '10'],
    ]) {
        const fetchImpl = async (url) => {
            assert.equal(url.pathname, `/api/${mode}`);
            assert.equal(url.searchParams.get('maximumRecords'), limit);
            return Response.json(fixture);
        };
        const wait = async () => assert.fail('No request should follow the last page');
        const pages = await collectPages({ any: '生成AI', mode }, { fetchImpl, wait });
        assert.equal(pages.length, 1);
        assert.equal(pages[0].records.length, 1);
    }
});

test('searchPages returns zero records successfully, including when the API omits the record array', async () => {
    const fetchImpl = async () => Response.json({ numberOfRecords: 0, numberOfReturn: 0, startRecord: 1 });
    assert.deepEqual(await collectPages({ any: '生成AI' }, { fetchImpl }), [{ records: [], total: 0 }]);
});

test('searchPages rejects a non-advancing cursor without another request', async (t) => {
    const fetchImpl = t.mock.fn(async () => Response.json({ ...speechPage, nextRecordPosition: 1 }));
    await assert.rejects(collectPages({ any: '生成AI' }, { fetchImpl }), /invalid next record position/);
    assert.equal(fetchImpl.mock.callCount(), 1);
});

test('fetchPage retries network errors, HTTP 429 and HTTP 5xx with backoff', async (t) => {
    const responses = [
        () => { throw new TypeError('connection reset'); },
        () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '9' } }),
        () => Response.json({ message: 'Service unavailable' }, { status: 503 }),
        () => Response.json(speechPage),
    ];
    const fetchImpl = t.mock.fn(async () => responses.shift()());
    const wait = t.mock.fn(async () => {});

    assert.deepEqual(await fetchPage(exampleUrl, { fetchImpl, wait, intervalMs: 4000 }), speechPage);
    assert.equal(fetchImpl.mock.callCount(), 4);
    assert.deepEqual(wait.mock.calls.map(({ arguments: args }) => args[0]), [4000, 9000, 12000]);
});

test('fetchPage gives up after three retries and keeps the final API error', async (t) => {
    const fetchImpl = t.mock.fn(async () => Response.json({ message: 'Service unavailable' }, { status: 503 }));
    const wait = t.mock.fn(async () => {});

    await assert.rejects(fetchPage(exampleUrl, { fetchImpl, wait }), /Service unavailable/);
    assert.equal(fetchImpl.mock.callCount(), 4);
    assert.equal(wait.mock.callCount(), 3);
});

test('fetchPage surfaces API message and details without retrying a search error', async (t) => {
    for (const status of [200, 400]) {
        const fetchImpl = t.mock.fn(async () => Response.json({
            message: '検索条件の入力に誤りがあります。', details: ['Invalid from date.', 'Use YYYY-MM-DD.'],
        }, { status }));
        await assert.rejects(fetchPage(exampleUrl, { fetchImpl }), /検索条件の入力に誤りがあります。 Invalid from date\. Use YYYY-MM-DD\./);
        assert.equal(fetchImpl.mock.callCount(), 1);
    }
});
