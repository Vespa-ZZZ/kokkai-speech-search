import { setTimeout as sleep } from 'node:timers/promises';

const API_URL = 'https://kokkai.ndl.go.jp/api/';
const USER_AGENT = 'kokkai-speech-search-actor/1.0';
const MODE_PAGE_SIZES = new Map([
    ['speech', 100],
    ['meeting_list', 100],
    ['meeting', 10],
]);
const MIN_INTERVAL_MS = 3000;
const MAX_RETRIES = 3;
const MAX_TIMER_MS = 2 ** 31 - 1;

const TEXT_FILTERS = [
    'any', 'speaker', 'nameOfHouse', 'nameOfMeeting', 'speakerGroup', 'speakerPosition',
    'speakerRole', 'from', 'until',
];
const SESSION_FILTERS = ['sessionFrom', 'sessionTo'];
const FILTER_VALUES = {
    nameOfHouse: ['衆議院', '参議院', '両院'],
    speakerRole: ['証人', '参考人', '公述人'],
    searchRange: ['冒頭', '本文', '冒頭・本文'],
};
const SPEECH_FIELDS = [
    'speechId', 'issueId', 'session', 'nameOfHouse', 'nameOfMeeting', 'issue', 'date',
    'speechOrder', 'speaker', 'speakerYomi', 'speakerGroup', 'speakerPosition', 'speakerRole',
    'speech', 'startPage', 'speechURL', 'meetingURL', 'pdfURL',
];

function getTextFilter(input, field) {
    const value = input[field] ?? '';
    if (typeof value !== 'string') throw new Error(`${field} must be a string.`);

    const trimmed = value.trim();
    const allowed = FILTER_VALUES[field];
    if (trimmed && allowed && !allowed.includes(trimmed)) {
        throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
    }
    return trimmed;
}

export function buildQuery(input, startRecord, pageSize) {
    const query = new URLSearchParams();
    for (const field of TEXT_FILTERS) {
        const value = getTextFilter(input, field);
        if (value) query.set(field, value);
    }
    for (const field of SESSION_FILTERS) {
        const value = input[field];
        if (value == null) continue;
        if (!Number.isInteger(value) || value < 1 || value > 999) {
            throw new Error(`${field} must be an integer from 1 to 999.`);
        }
        query.set(field, value);
    }
    if (!query.size) {
        throw new Error('Provide at least one search condition, such as any, speaker, nameOfMeeting, or from.');
    }
    if (query.has('any')) {
        const range = getTextFilter(input, 'searchRange');
        if (range) query.set('searchRange', range);
    }

    query.set('startRecord', startRecord);
    query.set('maximumRecords', pageSize);
    query.set('recordPacking', 'json');
    return query;
}

function normalizeSpeech(raw) {
    const { speechID, speechOrder, ...speech } = raw;
    return {
        ...speech,
        speechId: speechID,
        speechOrder: speechOrder == null ? null : Number(speechOrder),
    };
}

export function normalizeRecord(mode, raw) {
    const { issueID, session, ...record } = raw;
    const normalized = { ...record, issueId: issueID, session: session == null ? null : Number(session) };
    if (mode === 'speech') {
        const speech = normalizeSpeech(normalized);
        return Object.fromEntries(SPEECH_FIELDS.map((field) => [field, speech[field] ?? null]));
    }

    return { ...normalized, speechRecord: (record.speechRecord ?? []).map(normalizeSpeech) };
}

function apiErrorMessage(body) {
    return [body?.message, body?.details].flat()
        .filter((part) => typeof part === 'string' && part.trim()).join(' ');
}

function retryAfterMs(header) {
    if (!header) return 0;
    return /^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now()) || 0;
}

async function waitFor(milliseconds) {
    // Node uses a 1 ms delay above the timer limit, so wait in chunks when necessary.
    while (milliseconds > MAX_TIMER_MS) {
        await sleep(MAX_TIMER_MS);
        milliseconds -= MAX_TIMER_MS;
    }
    await sleep(Math.ceil(milliseconds));
}

export async function fetchPage(url, { fetchImpl = fetch, wait = waitFor, intervalMs = MIN_INTERVAL_MS } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        let response;
        let body;
        let networkError;
        try {
            response = await fetchImpl(url, {
                headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
                redirect: 'manual',
                signal: AbortSignal.timeout(30_000),
            });
            body = await response.json().catch((error) => {
                if (!(error instanceof SyntaxError)) throw error;
                return undefined;
            });
        } catch (error) {
            networkError = error;
        }

        const status = response?.status;
        const detail = apiErrorMessage(body);
        if (!networkError && response?.ok && !detail && body && typeof body === 'object') return body;

        const message = networkError?.message ?? (response?.ok ? 'invalid JSON response' : `HTTP ${status}`);
        const error = new Error(`Kokkai API: ${detail || message}`, { cause: networkError });
        const retryable = networkError || status === 429 || (status >= 500 && status <= 599);
        if (!retryable || attempt === MAX_RETRIES) throw error;

        const backoffMs = MIN_INTERVAL_MS * 2 ** attempt;
        const serverDelayMs = retryAfterMs(response?.headers.get('retry-after'));
        await wait(Math.max(intervalMs, backoffMs, serverDelayMs));
    }
}

export async function* searchPages(input, { fetchImpl = fetch, wait = waitFor, scanAll = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.');

    const { mode = 'speech', maxResults = 100, requestIntervalSecs = 3 } = input;
    const pageLimit = MODE_PAGE_SIZES.get(mode);
    if (!pageLimit) throw new Error('mode must be speech, meeting_list, or meeting.');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10_000) {
        throw new Error('maxResults must be an integer from 1 to 10000.');
    }
    if (!Number.isFinite(requestIntervalSecs) || requestIntervalSecs < 2) {
        throw new Error('requestIntervalSecs must be a number of at least 2.');
    }

    const intervalMs = Math.max(MIN_INTERVAL_MS, requestIntervalSecs * 1000);
    const recordKey = mode === 'speech' ? 'speechRecord' : 'meetingRecord';
    let startRecord = 1;
    let remaining = maxResults;
    while (remaining > 0) {
        const pageSize = scanAll ? pageLimit : Math.min(pageLimit, remaining);
        const url = new URL(mode, API_URL);
        url.search = buildQuery(input, startRecord, pageSize);
        const page = await fetchPage(url, { fetchImpl, wait, intervalMs });
        const total = Number(page.numberOfRecords);
        const rawRecords = page[recordKey] ?? (total === 0 ? [] : undefined);
        if (page.numberOfRecords == null || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(rawRecords)) {
            throw new Error(`Kokkai API returned an invalid ${mode} page at record ${startRecord}.`);
        }

        const records = rawRecords.slice(0, scanAll ? pageSize : remaining).map((raw) => normalizeRecord(mode, raw));
        if (!scanAll) remaining -= records.length;
        yield { records, total };

        if (remaining === 0 || page.nextRecordPosition == null) return;
        const next = Number(page.nextRecordPosition);
        if (!Number.isSafeInteger(next) || next <= startRecord) {
            throw new Error(`Kokkai API returned an invalid next record position after ${startRecord}.`);
        }
        startRecord = next;
        await wait(intervalMs);
    }
}
