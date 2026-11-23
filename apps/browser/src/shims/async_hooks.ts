// AsyncLocalStorage for the browser build. The page runs one API call at a time (see transport.ts), so a stack is enough:
// run() sets the value for the callback (and for as long as a returned promise is pending) and then puts the old one back.
// A Fastify hook that hands its continuation to done() would lose the value after its first await, so the transport also sets
// `AsyncLocalStorage.base` (the store named by the session cookie) before each request; getStore() falls back to it.
export class AsyncLocalStorage<T> {
  static base: unknown;
  private cur: T | undefined;
  getStore(): T | undefined { return this.cur ?? (AsyncLocalStorage.base as T | undefined); }
  run<R>(store: T, fn: (...a: any[]) => R, ...args: any[]): R {
    const prev = this.cur;
    this.cur = store;
    let out: R;
    try { out = fn(...args); } catch (e) { this.cur = prev; throw e; }
    if (out && typeof (out as any).then === "function") {
      const restore = () => { this.cur = prev; };
      (out as any).then(restore, restore);
    } else this.cur = prev;
    return out;
  }
  enterWith(store: T) { this.cur = store; }
  disable() { this.cur = undefined; }
  exit<R>(fn: (...a: any[]) => R, ...args: any[]): R { return fn(...args); }
}
export class AsyncResource {
  constructor(public type: string) {}
  runInAsyncScope<R>(fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R { return fn.apply(thisArg, args); }
  emitDestroy() { return this; }
  asyncId() { return 0; }
  triggerAsyncId() { return 0; }
  bind<F extends (...a: any[]) => any>(fn: F): F { return fn; }
  static bind<F extends (...a: any[]) => any>(fn: F): F { return fn; }
}
export const executionAsyncId = () => 0;
export const createHook = () => ({ enable() { return this; }, disable() { return this; } });
export default { AsyncLocalStorage, AsyncResource, executionAsyncId, createHook };
