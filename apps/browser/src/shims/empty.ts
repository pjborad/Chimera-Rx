// Stands in for packages the browser build never calls (a server-side static file plugin, the AWS SDK).
const unavailable = () => { throw new Error("Not available in the browser preview"); };
export default unavailable;
export const BedrockRuntimeClient = unavailable;
export const ConverseCommand = unavailable;
