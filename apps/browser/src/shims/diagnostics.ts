// node:diagnostics_channel: Fastify publishes request events on it; nobody listens in the browser.
const ch = { hasSubscribers: false, publish() { /* no subscribers */ }, subscribe() { /* none */ }, unsubscribe() { return false; }, runStores<R>(_d: unknown, fn: () => R) { return fn(); }, bindStore() { /* none */ } };
export const channel = () => ch;
export const tracingChannel = () => ({ ...ch, traceSync: <R,>(fn: () => R) => fn(), tracePromise: <R,>(fn: () => R) => fn(), traceCallback: <R,>(fn: () => R) => fn() });
export const hasSubscribers = () => false;
export const subscribe = () => undefined;
export const unsubscribe = () => false;
export default { channel, tracingChannel, hasSubscribers, subscribe, unsubscribe };
