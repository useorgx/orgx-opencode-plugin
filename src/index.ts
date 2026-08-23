// OpenCode invokes every package-root export as a plugin factory. Keep this
// entry point deliberately closed-world; library helpers live at ./sdk.
export { OrgXOpenCodePlugin } from './plugin.js';
