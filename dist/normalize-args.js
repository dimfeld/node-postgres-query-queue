function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isSubmittable(value) {
    return isObject(value) && typeof value.submit === 'function';
}
function hasConfigCallback(value) {
    return isObject(value) && typeof value.callback === 'function';
}
function readDescription(firstArg) {
    if (typeof firstArg === 'string') {
        return firstArg.slice(0, 80);
    }
    if (isObject(firstArg) && typeof firstArg.text === 'string') {
        return firstArg.text.slice(0, 80);
    }
    return undefined;
}
function dispatchQuery(raw, args) {
    return raw.query(...args);
}
export function normalizeQueryArgs(args) {
    const firstArg = args[0];
    const description = readDescription(firstArg);
    if (isSubmittable(firstArg)) {
        const preservedArgs = [...args];
        return {
            kind: 'submittable',
            dispatch: (raw) => dispatchQuery(raw, preservedArgs),
            ...(description !== undefined ? { description } : {}),
        };
    }
    const lastArg = args.at(-1);
    if (typeof lastArg === 'function') {
        const userCallback = lastArg;
        const dispatchArgs = args.slice(0, -1);
        return {
            kind: 'callback',
            dispatchArgs,
            dispatch: (raw) => dispatchQuery(raw, dispatchArgs),
            userCallback,
            ...(description !== undefined ? { description } : {}),
        };
    }
    if (hasConfigCallback(firstArg)) {
        const { callback, ...dispatchConfig } = firstArg;
        return {
            kind: 'callback',
            dispatchArgs: [dispatchConfig, ...args.slice(1)],
            dispatch: (raw) => dispatchQuery(raw, [dispatchConfig, ...args.slice(1)]),
            userCallback: callback,
            ...(description !== undefined ? { description } : {}),
        };
    }
    const preservedArgs = [...args];
    return {
        kind: 'promise',
        dispatch: (raw) => dispatchQuery(raw, preservedArgs),
        ...(description !== undefined ? { description } : {}),
    };
}
//# sourceMappingURL=normalize-args.js.map