const CLIENT_RELEASED_MESSAGE = 'Client has been released and cannot accept new queued queries';
const CLIENT_BROKEN_MESSAGE = 'Wrapped client is broken and cannot accept new queued queries';
const RELEASE_ABORTED_MESSAGE = 'Queued query was aborted because the client was released with an error';
const DOUBLE_RELEASE_MESSAGE = 'Release called more than once on wrapped client';
export class ClientReleasedError extends Error {
    constructor() {
        super(CLIENT_RELEASED_MESSAGE);
        this.name = 'ClientReleasedError';
    }
}
export class ClientBrokenError extends Error {
    constructor(cause) {
        super(CLIENT_BROKEN_MESSAGE, { cause });
        this.name = 'ClientBrokenError';
    }
}
export class ReleaseAbortedError extends Error {
    constructor(cause) {
        super(RELEASE_ABORTED_MESSAGE, { cause });
        this.name = 'ReleaseAbortedError';
    }
}
export class DoubleReleaseError extends Error {
    constructor() {
        super(DOUBLE_RELEASE_MESSAGE);
        this.name = 'DoubleReleaseError';
    }
}
//# sourceMappingURL=errors.js.map