import { Actor, log } from 'apify';
import { runSearch, sanitizeErrorMessage } from './run.js';

try {
    await Actor.init();
    await runSearch(Actor, log);
    await Actor.exit();
} catch (error) {
    const message = sanitizeErrorMessage(error);
    log.error(message);
    await Actor.fail(message).catch((failure) => {
        log.error(sanitizeErrorMessage(failure));
        process.exitCode = 1;
    });
}
