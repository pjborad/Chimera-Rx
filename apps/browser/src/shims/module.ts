import * as sqlite from "./sqlite";
export const createRequire = (_url: string) => (id: string) => {
  if (id === "node:sqlite") return sqlite;
  throw new Error(`require("${id}") is not available in the browser build`);
};
export default { createRequire };
