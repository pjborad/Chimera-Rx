// Small stand-ins for node modules the API imports but a browser build never uses.
const no = (n: string) => () => { throw new Error(`${n} is not available in the browser build`); };
export const execFile = no("child_process.execFile");
export const execFileSync = no("child_process.execFileSync");
export const spawn = no("child_process.spawn");
export const promises = { lookup: async () => { throw Object.assign(new Error("DNS is not available in the browser build"), { code: "ENOTFOUND" }); } };
export const lookup = () => { throw new Error("DNS is not available in the browser build"); };
export const userInfo = () => ({ username: "browser" });
export const tmpdir = () => "/tmp";
export const platform = () => "browser";
export const networkInterfaces = () => ({});
// node:net address checks, used to refuse private or loopback destinations
const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const isIPv4 = (s: string) => v4.test(s);
export const isIPv6 = (s: string) => { try { return s.includes(":") && !!new URL(`http://[${s}]/`); } catch { return false; } };
export const isIP = (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);
export default { execFile, execFileSync, spawn, promises, lookup, userInfo, tmpdir, platform, networkInterfaces, isIPv4, isIPv6, isIP };
