# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## OpenCode V2

This plugin targets OpenCode V2 only. It was verified against OpenCode 2.1.4:
the plugin loads and registers the `cursor` integration and its OAuth method.
Model discovery and chat need a real Cursor login, which that check did not
cover.

Install the plugin from a local checkout. Clone this repository, then build it:

```sh
npm run build
```

Create `~/.config/opencode/plugins/opencode-cursor-v2.js` with one line, where
`<checkout>` is the absolute path of your clone:

```js
export { default } from "<checkout>/dist/v2.js";
```

Restart OpenCode to load the plugin. Rebuild and restart after each change to
the source.

Start `opencode`.
Run `/connect`.
Select Cursor.

The plugin adds Cursor OAuth and the available models to the V2 catalog.

Two other routes do not work on OpenCode 2.1.4. A path entry in the `plugins`
array of `opencode.jsonc` (a directory path, a `file://` URL, or a symlink) is
not loaded. `opencode plugin add` refuses a `file:` tarball: the target must be
an npm registry package or a Git package specifier.

## Use

Start OpenCode and select any Cursor model. Once a Cursor login exists, the
plugin starts a local OpenAI-compatible proxy and routes requests through
Cursor's gRPC API.

## How it works

1. OAuth — browser-based login to Cursor via PKCE.
2. Model discovery — queries Cursor's gRPC API for all available models.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — redirects Cursor's built-in filesystem/shell tools
   to the equivalent OpenCode tools, and exposes OpenCode's tool surface via
   Cursor MCP.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

### HTTP/1.1 fallback

HTTP/2 stays the default. Use the HTTP/1.1 transport when the H2 bridge cannot
connect, for example behind corporate proxies that block HTTP/2. Start OpenCode
with `CURSOR_DISABLE_HTTP2=1` in its environment:

```sh
CURSOR_DISABLE_HTTP2=1 opencode
```

Model discovery and agent turns use the same transport.

The HTTP/1.1 transport has only been tested against a fake backend, not a real
blocking proxy.

Unary RPCs such as model discovery are a plain HTTP/1.1 `POST` with
`Content-Type: application/proto` and the raw protobuf body.

Agent turns use Cursor's HTTP/1.1 fallback and do stream:

- `POST /agent.v1.AgentService/RunSSE` with `Content-Type: application/connect+proto`,
  header `x-cursor-streaming: true`, and one Connect envelope whose payload is
  `BidiRequestId` (the same id as `x-request-id`).
- The run request and every later client message (tool results, KV replies,
  heartbeats) go to `POST /aiserver.v1.BidiService/BidiAppend`. The `data`
  field is the hex encoding of an `AgentClientMessage`, and `request_id`
  matches the `RunSSE` `x-request-id`. `append_seqno` starts at 0 for the run
  request and increases by one for each message.

The response is a stream of Connect envelopes. Cursor labels this response
`text/event-stream`, but the bytes are still envelopes, not `data:` events.
The proxy reads them as they arrive and emits OpenAI SSE chunks. A final
envelope with flag `0x02` ends the stream. While the turn is open the proxy
sends a client heartbeat on `BidiAppend` every 5 seconds.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model calls a tool:
   - native tools (readArgs, shellArgs, grepArgs, ...) with an OpenCode
     equivalent are redirected to it (read, bash, grep, glob, webfetch, write)
   - native tools without an equivalent are rejected with a typed error
   - MCP tools arrive as mcpArgs exec messages
3. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
4. OpenCode executes tool, sends result in follow-up request
5. Proxy resumes H2 stream with the typed native result (or mcpResult),
   streams continuation
```

### Conversation state

Conversation history is rebuilt from the OpenAI messages on every request
(`rootPromptMessagesJson` + content-addressed turn blobs), and server
checkpoints are persisted to `~/.cache/opencode-cursor/conversations/`
(`$XDG_CACHE_HOME/opencode-cursor/conversations/` when set) so
context survives restarts. Set `CURSOR_PROXY_DEBUG=1` to log the KV blob
handshake and exec traffic when debugging.

## Develop locally

```sh
git config core.hooksPath .githooks
bun install
bun run build
bun test/smoke.ts
```

The first line turns on the git hooks that refuse commits and pushes on `main`.

`bash scripts/load-local.sh` (on `main`) rebuilds the plugin and checks that the running OpenCode lists the `cursor` integration.

`@opencode/plugin` is only a devDependency (types and the smoke test): the OpenCode host provides it to plugins at runtime.

## Requirements

- [OpenCode](https://opencode.ai) V2 (2.1.4 verified)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription