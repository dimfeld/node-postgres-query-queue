export declare class ClientReleasedError extends Error {
    constructor();
}
export declare class ClientBrokenError extends Error {
    constructor(cause: Error);
}
export declare class ReleaseAbortedError extends Error {
    constructor(cause: unknown);
}
export declare class DoubleReleaseError extends Error {
    constructor();
}
//# sourceMappingURL=errors.d.ts.map