# schemas/

JSON Schemas for two files claude-box's `authd`/`check-in`/`--remote-serve`
wiring depends on, but doesn't own: `$CLAUDE_CONFIG_DIR/.credentials.json`
and `$CLAUDE_CONFIG_DIR/.claude.json`, both written by the `claude` CLI
itself. There is no official published schema for either — `anthropics/claude-code`
does not publish source or type definitions for its config formats (confirmed
2026-07-04, see below). These were hand-derived and cross-checked against
three sources:

1. **Direct introspection** of a real, logged-in `.claude.json`/`.credentials.json`
   pair on this machine — key names and value *types* only, via:
   ```sh
   jq 'to_entries | map({(.key): (.value | type)}) | add' .claude.json
   jq '.oauthAccount | to_entries | map({(.key): (.value | type)}) | add' .claude.json
   jq '{claudeAiOauth: (.claudeAiOauth | to_entries | map({(.key): (.value|type)}) | add), mcpOAuth: (.mcpOAuth | type)}' .credentials.json
   ```
   Never dumped actual secret *values* — only shapes.
2. A community doc, [cabinlab/claude-code-sdk-docker](https://github.com/cabinlab/claude-code-sdk-docker/blob/main/docs/AUTHENTICATION.md),
   describing roughly the same `claudeAiOauth`/`oauthAccount` split.
3. [anthropics/claude-code#57026](https://github.com/anthropics/claude-code/issues/57026)
   ("oauthAccount not hydrated to ~/.claude.json") — confirms `oauthAccount` is
   a separate profile/org hydration step, not part of the OAuth token exchange
   itself. This is the exact mechanism `claude-box check-in` works around: a
   box that gets a leased `.credentials.json` but never triggers this
   hydration fails `claude remote-control` with "Unable to determine your
   organization for Remote Control eligibility" even with a fully valid
   access token (confirmed live in this repo, 2026-07-04).

`claude-json.schema.json` deliberately leaves almost everything as
`additionalProperties: true` — `.claude.json` is Claude Code's own internal
state (~90 top-level keys as of v2.1.199: UI/onboarding caches, feature
flags, usage counters), it evolves independently of this repo, and pinning
fields claude-box doesn't use would just be brittle busywork. Only
`oauthAccount` and `projects[path].hasTrustDialogAccepted` are typed
precisely, because claude-box's own code reads/writes them.
