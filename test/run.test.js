import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSearch, sanitizeErrorMessage } from '../src/run.js';

const logger = { info() {}, warning() {} };

function mockRun(t, input, pages, { state = new Map(), pushData = async () => {} } = {}) {
    const actor = {
        getInput: async () => ({ any: '生成AI', ...input }),
        pushData: t.mock.fn(pushData),
        openKeyValueStore: t.mock.fn(async (name) => {
            assert.equal(name, 'kokkai-speech-search-state');
            return {
                getValue: async (key) => state.get(key),
                setValue: async (key, value) => { state.set(key, value); },
            };
        }),
    };
    const fetchImpl = t.mock.fn(async (url) => {
        const start = Number(url.searchParams.get('startRecord'));
        assert.ok(pages[start], `Unexpected API request at record ${start}`);
        return Response.json(pages[start]);
    });
    const wait = async () => {};
    return { actor, fetchImpl, run: () => runSearch(actor, logger, { fetchImpl, wait }) };
}

test('onlyNew tracks individual speech IDs and emits zero records on an unchanged second run', async (t) => {
    const state = new Map();
    const input = { onlyNew: true };
    const pages = {
        1: {
            numberOfRecords: 2,
            speechRecord: [
                { speechID: 'issue-1_001', issueID: 'issue-1' },
                { speechID: 'issue-1_002', issueID: 'issue-1' },
            ],
        },
    };

    const first = mockRun(t, input, pages, { state });
    await first.run();
    assert.equal(first.actor.pushData.mock.callCount(), 2);
    assert.deepEqual(state.get('state-default'), { seen: ['issue-1_001', 'issue-1_002'], pending: [] });

    const second = mockRun(t, input, pages, { state });
    await second.run();
    assert.equal(second.actor.pushData.mock.callCount(), 0);

    const normal = mockRun(t, {}, pages, { state });
    await normal.run();
    assert.equal(normal.actor.openKeyValueStore.mock.callCount(), 0);
    assert.equal(normal.actor.pushData.mock.calls[0].arguments[0].length, 2);
});

test('a failed push remains pending and is retried beyond a seen page', async (t) => {
    const state = new Map();
    const input = { mode: 'meeting', onlyNew: true, stateKey: 'committee' };
    const meetings = Array.from({ length: 10 }, (_, index) => ({ issueID: `meeting-${index + 1}` }));
    const failedMeeting = { issueID: 'meeting-11' };
    const pages = {
        1: { numberOfRecords: 11, meetingRecord: meetings, nextRecordPosition: 11 },
        11: { numberOfRecords: 11, meetingRecord: [failedMeeting] },
    };
    const first = mockRun(t, input, pages, {
        state,
        pushData: async ({ issueId }) => {
            if (issueId === failedMeeting.issueID) throw new Error('Dataset unavailable');
        },
    });
    await assert.rejects(first.run(), /Dataset unavailable/);
    assert.deepEqual(state.get('state-committee'), {
        seen: meetings.map(({ issueID }) => issueID),
        pending: [failedMeeting.issueID],
    });

    const retry = mockRun(t, { ...input, maxResults: 1 }, pages, { state });
    await retry.run();
    assert.equal(retry.fetchImpl.mock.callCount(), 2);
    assert.equal(retry.actor.pushData.mock.callCount(), 1);
    assert.equal(retry.actor.pushData.mock.calls[0].arguments[0].issueId, failedMeeting.issueID);
    assert.deepEqual(state.get('state-committee'), {
        seen: [...meetings.map(({ issueID }) => issueID), failedMeeting.issueID],
        pending: [],
    });

    const third = mockRun(t, input, pages, { state });
    await third.run();
    assert.equal(third.fetchImpl.mock.callCount(), 1);
    assert.equal(third.actor.pushData.mock.callCount(), 0);

    const separate = mockRun(t, { ...input, mode: 'meeting_list', stateKey: 'other', maxResults: 1 }, pages, { state });
    await separate.run();
    assert.equal(separate.actor.pushData.mock.callCount(), 1);
    assert.deepEqual(state.get('state-other'), { seen: ['meeting-1'], pending: [] });
});

test('a partially successful page saves only the records pushed successfully', async (t) => {
    const state = new Map();
    const input = { onlyNew: true };
    const pages = {
        1: { numberOfRecords: 2, speechRecord: [{ speechID: 'first' }, { speechID: 'second' }] },
    };
    const run = mockRun(t, input, pages, {
        state,
        pushData: async ({ speechId }) => {
            if (speechId === 'second') throw new Error('Push failed');
        },
    });
    await assert.rejects(run.run(), /Push failed/);
    assert.deepEqual(state.get('state-default'), { seen: ['first'], pending: ['second'] });
});

test('onlyNew retains the last 20,000 successfully pushed IDs per key', async (t) => {
    const seen = Array.from({ length: 20_000 }, (_, index) => `old-${index}`);
    const state = new Map([['state-default', { seen, pending: [] }]]);
    const run = mockRun(t, { onlyNew: true }, {
        1: { numberOfRecords: 1, speechRecord: [{ speechID: 'new' }] },
    }, { state });

    await run.run();
    assert.deepEqual(state.get('state-default'), { seen: [...seen.slice(1), 'new'], pending: [] });
});

test('invalid monitoring inputs are rejected before accessing the API or storage', async (t) => {
    for (const [input, message] of [
        [{ onlyNew: 'true' }, /onlyNew/],
        [{ stateKey: 'bad/key' }, /stateKey/],
        [{ stateKey: '' }, /stateKey/],
        [{ stateKey: 'a'.repeat(51) }, /stateKey/],
    ]) {
        const run = mockRun(t, input, {});
        await assert.rejects(run.run(), message);
        assert.equal(run.fetchImpl.mock.callCount(), 0);
        assert.equal(run.actor.openKeyValueStore.mock.callCount(), 0);
    }
});

test('error messages redact absolute paths and preserve HTTP URLs without appending a stack', () => {
    const error = new Error(String.raw`Failed to open 'C:\test data\run.json', /workspace/job/run.json, \\server\share\run.json, or file:///tmp/run.json. See https://example.invalid/reference.`);
    assert.equal(sanitizeErrorMessage(error),
        "Failed to open '<path>', <path>, <path>, or <path>. See https://example.invalid/reference.");
    assert.equal(sanitizeErrorMessage(new Error('ENOENT:/tmp/run.json', { cause: error })), 'ENOENT:<path>');
});
