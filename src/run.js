import { searchPages } from './kokkai.js';

const STATE_STORE = 'kokkai-speech-search-state';
const MAX_SEEN_IDS = 20_000;

export function sanitizeErrorMessage(error) {
    const message = typeof error === 'string' ? error : error?.message;
    if (typeof message !== 'string' || !message) return 'Actor failed.';

    return message
        .replace(/(['"`])(?:file:\/\/|[A-Z]:[\\/]|[\\/])(?:(?!\1)[^\r\n])*\1/gi, '$1<path>$1')
        .replace(/https?:\/\/[^\s'"`<>]+|(?:file:\/\/|\b[A-Z]:[\\/]|(?<![\w/\\])[\\/](?=[^\s'"`<>()\[\],;]))[^\s'"`<>]*/gi,
            (match) => {
                if (/^https?:\/\//i.test(match)) return match;
                const trailingPunctuation = match.match(/[.,;:)\]}]+$/)?.[0] ?? '';
                return `<path>${trailingPunctuation}`;
            });
}

export async function runSearch(actor, logger, options) {
    const input = (await actor.getInput()) ?? {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.');

    const { mode = 'speech', maxResults = 100, onlyNew = false, stateKey = 'default' } = input;
    if (typeof onlyNew !== 'boolean') throw new Error('onlyNew must be a boolean.');
    if (typeof stateKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
        throw new Error('stateKey must contain 1 to 50 letters, digits, hyphens, or underscores.');
    }

    const pages = searchPages(input, { ...options, scanAll: onlyNew });
    if (onlyNew) {
        await runMonitoringSearch(actor, logger, pages, { mode, maxResults, stateKey });
        return;
    }

    let pushed = 0;
    for await (const { records, total } of pages) {
        const result = records.length ? await actor.pushData(records) : undefined;
        const chargeLimitReached = result?.eventChargeLimitReached === true;
        pushed += chargeLimitReached ? result.chargedCount : records.length;
        logger.info(`Fetched ${pushed} / ${Math.min(total, maxResults)}`);
        if (chargeLimitReached) {
            logger.warning('Pay-per-event charge limit reached. Stopping dataset output.');
            return;
        }
    }
    if (pushed === 0) logger.warning('No records matched the search conditions.');
}

async function runMonitoringSearch(actor, logger, pages, { mode, maxResults, stateKey }) {
    const store = await actor.openKeyValueStore(STATE_STORE);
    const key = `state-${stateKey}`;
    const state = await store.getValue(key);
    const seen = new Set(state?.seen ?? []);
    const pending = new Set(state?.pending ?? []);
    const idField = mode === 'speech' ? 'speechId' : 'issueId';
    let pushed = 0;
    let resumeFromId = state?.resumeFromId;
    let passedResumeId = false;
    let chargeLimitReached = false;
    const saveState = () => store.setValue(key, {
        seen: [...seen].slice(-MAX_SEEN_IDS), pending: [...pending],
        ...(resumeFromId ? { resumeFromId } : {}),
    });

    for await (const { records } of pages) {
        let changed = false;
        try {
            for (const record of records) {
                const id = record[idField];
                if (typeof id !== 'string' || !id) throw new Error(`Kokkai API returned a record without a valid ${idField}.`);
                if (id === resumeFromId) {
                    passedResumeId = true;
                    changed = true;
                }
                if (seen.has(id)) continue;

                pending.add(id);
                changed = true;
                const result = await actor.pushData(record);
                chargeLimitReached = result?.eventChargeLimitReached === true;
                if (!chargeLimitReached || result.chargedCount > 0) {
                    seen.add(id);
                    pending.delete(id);
                    pushed++;
                }
                if ((chargeLimitReached || (resumeFromId && pushed === maxResults)) && (!resumeFromId || passedResumeId)) {
                    resumeFromId = id;
                }
                if (chargeLimitReached) logger.warning('Pay-per-event charge limit reached. Stopping dataset output.');
                if (chargeLimitReached || pushed === maxResults) break;
            }
        } finally {
            if (changed) {
                await saveState();
            }
        }

        // A pending push or the previous charge cutoff can sit beyond an already-seen page.
        if (chargeLimitReached || pushed === maxResults) break;
        if ((!resumeFromId || passedResumeId) && !changed && records.length > 0 && pending.size === 0) break;
    }
    if (resumeFromId && !chargeLimitReached && pushed < maxResults) {
        resumeFromId = undefined;
        await saveState();
    }

    if (pushed === 0 && !chargeLimitReached) logger.info('No new records matched the search conditions.');
    else logger.info(`Pushed ${pushed} new records.`);
}
