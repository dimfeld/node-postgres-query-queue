export class FifoQueue {
    items = [];
    head = 0;
    get length() {
        return this.items.length - this.head;
    }
    push(item) {
        this.items.push(item);
    }
    shift() {
        if (this.head >= this.items.length) {
            return undefined;
        }
        const item = this.items[this.head];
        this.items[this.head] = undefined;
        this.head += 1;
        if (this.head > 1024 && this.head * 2 >= this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return item;
    }
    drain() {
        if (this.length === 0) {
            this.items = [];
            this.head = 0;
            return [];
        }
        const drained = this.items.slice(this.head);
        this.items = [];
        this.head = 0;
        return drained;
    }
}
function notifyStateChange(hooks) {
    hooks.onStateChange?.();
}
function isPromiseLike(value) {
    return typeof value === 'object' && value !== null && 'then' in value;
}
function isEventEmitterLike(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'on' in value &&
        typeof value.on === 'function' &&
        'off' in value &&
        typeof value.off === 'function' &&
        'once' in value &&
        typeof value.once === 'function');
}
function toError(value) {
    if (value instanceof Error) {
        return value;
    }
    return new Error(String(value));
}
export function pump(state, hooks) {
    if (state.broken || state.rawReleased || state.active) {
        return;
    }
    if (state.queue.length === 0) {
        if (state.releaseRequested) {
            hooks.doRawRelease(state.releaseError);
            return;
        }
        if (!state.lastEmittedDrain) {
            state.lastEmittedDrain = true;
            notifyStateChange(hooks);
            hooks.emitDrain();
        }
        return;
    }
    state.lastEmittedDrain = false;
    const item = state.queue.shift();
    if (item === undefined) {
        return;
    }
    state.active = true;
    state.activeItem = item;
    notifyStateChange(hooks);
    try {
        const dispatchResult = item.dispatch(state.raw);
        if (item.kind === 'callback') {
            return;
        }
        if (item.kind === 'promise') {
            if (!isPromiseLike(dispatchResult)) {
                item.finalize(new Error('Expected promise-like result from promise query dispatch'));
                return;
            }
            Promise.resolve(dispatchResult).then((result) => item.finalize(null, result), (error) => item.finalize(toError(error)));
            return;
        }
        if (!isEventEmitterLike(dispatchResult)) {
            item.finalize(new Error('Expected event-emitter result from submittable query dispatch'));
            return;
        }
        const onEnd = () => item.finalize(null);
        const onError = (error) => item.finalize(toError(error));
        item.cleanup = () => {
            dispatchResult.off('end', onEnd);
            dispatchResult.off('error', onError);
        };
        dispatchResult.once('end', onEnd);
        dispatchResult.once('error', onError);
    }
    catch (error) {
        item.finalize(toError(error));
        hooks.schedulePump();
    }
}
//# sourceMappingURL=queue.js.map