// Root entrypoint for OpenCode v2 directory-form plugin registration.
//
// OpenCode V2 hosts (2.0.4 or later) require config plugin entries to be directories
// with an index entrypoint (`index.js`) and reject bare file paths
// ("configured plugin path must be a directory"). npm/git package installs
// resolve via package.json `main`; this file only serves the directory form,
// an absolute path such as `"plugins": ["/path/to/opencode-codebuddy-oauth"]`.
//
// Requires a prior `npm run build` — this re-exports the bundled V2 entry.
export { default } from "./dist/index.js";
