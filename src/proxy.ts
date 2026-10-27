import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  AgentClientMessageSchema,
  AskQuestionErrorSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionResultSchema,
  BidiRequestIdSchema,
  ClientHeartbeatSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  ConversationActionSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  ExecClientThrowSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolDefinitionSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  ReadArgsSchema,
  ReadFileNotFoundSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestedModelSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  ResumeActionSchema,
  SetBlobResultSchema,
  SwitchModeRequestResponse_RejectedSchema,
  SwitchModeRequestResponseSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteShellStdinResultSchema,
  InteractionResponseSchema,
  type AgentServerMessage,
  type InteractionQuery,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb";
import {
  redirectNativeExec,
  sendNativeExecResult,
  type NativeExecBinding,
} from "./native-tools";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";

const CURSOR_API_URL = process.env.CURSOR_API_URL ?? "https://api2.cursor.sh";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const BRIDGE_PATH = pathResolve(import.meta.dir, "h2-bridge.mjs");
const CONNECT_END_STREAM_FLAG = 0b00000010;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;
const RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
const BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
export const CURSOR_DISABLE_HTTP2 = process.env.CURSOR_DISABLE_HTTP2 === "1";

let proxyModels: Array<{ id: string; name: string }> = [];
let proxyDisableHttp2 = CURSOR_DISABLE_HTTP2;

/** Plugin option and the CURSOR_DISABLE_HTTP2 env var both land here. */
export function setProxyDisableHttp2(value: boolean): void {
  proxyDisableHttp2 = value;
}

export function encodeConnectEnvelope(payload: Uint8Array, flags = 0): Uint8Array {
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = flags & 0xff;
  new DataView(framed.buffer, framed.byteOffset, framed.byteLength).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Uint8Array.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
  return concatBytes(encodeVarint(BigInt((fieldNumber << 3) | 2)), encodeVarint(BigInt(data.length)), data);
}

function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift <= 70n) {
    const byte = buf[pos]!;
    pos++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

/**
 * Unary BidiAppend body: hex(AgentClientMessage), nested request id, monotonic seqno.
 * aiserver.v1.BidiService is not in the generated agent proto, so this is encoded by hand.
 */
export function encodeBidiAppendRequest(
  message: Uint8Array,
  requestId: string,
  appendSeqno: number,
): Uint8Array {
  const data = new TextEncoder().encode(Buffer.from(message).toString("hex"));
  const nestedId = encodeLengthDelimited(1, new TextEncoder().encode(requestId));
  return concatBytes(
    encodeLengthDelimited(1, data),
    encodeLengthDelimited(2, nestedId),
    concatBytes(encodeVarint(BigInt((3 << 3) | 0)), encodeVarint(BigInt(appendSeqno))),
  );
}

export function decodeBidiAppendRequest(payload: Uint8Array): {
  dataHex: string;
  requestId: string;
  appendSeqno: number;
} {
  let offset = 0;
  let dataHex = "";
  let requestId = "";
  let appendSeqno = 0;
  while (offset < payload.length) {
    const [tag, afterTag] = readVarint(payload, offset);
    offset = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 2) {
      const [length, afterLen] = readVarint(payload, offset);
      offset = afterLen;
      const slice = payload.subarray(offset, offset + Number(length));
      offset += Number(length);
      if (field === 1) dataHex = new TextDecoder().decode(slice);
      else if (field === 2) requestId = decodeBidiRequestId(slice);
    } else if (wire === 0) {
      const [value, afterValue] = readVarint(payload, offset);
      offset = afterValue;
      if (field === 3) appendSeqno = Number(value);
    } else {
      throw new Error(`unsupported BidiAppend wire type ${wire}`);
    }
  }
  return { dataHex, requestId, appendSeqno };
}

function decodeBidiRequestId(payload: Uint8Array): string {
  let offset = 0;
  let requestId = "";
  while (offset < payload.length) {
    const [tag, afterTag] = readVarint(payload, offset);
    offset = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire !== 2) throw new Error("unsupported BidiRequestId wire type");
    const [length, afterLen] = readVarint(payload, offset);
    offset = afterLen;
    const slice = payload.subarray(offset, offset + Number(length));
    offset += Number(length);
    if (field === 1) requestId = new TextDecoder().decode(slice);
  }
  return requestId;
}

export function buildHttp1CursorRequest(
  rpcPath: string,
  body: Uint8Array,
  unary: boolean,
  requestId: string,
): { path: string; headers: Record<string, string>; body: Uint8Array } {
  const common = {
    "connect-protocol-version": "1",
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": requestId,
  };
  if (unary) {
    return {
      path: rpcPath,
      headers: { ...common, "Content-Type": "application/proto" },
      body,
    };
  }
  // RunSSE is server-streaming. Its request is only the correlation id;
  // the AgentClientMessage is the first BidiAppend, not this body.
  const requestIdBytes = toBinary(BidiRequestIdSchema, create(BidiRequestIdSchema, { requestId }));
  return {
    path: RUN_SSE_PATH,
    headers: {
      ...common,
      "Content-Type": "application/connect+proto",
      te: "trailers",
      "x-cursor-streaming": "true",
    },
    body: encodeConnectEnvelope(requestIdBytes),
  };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ContentPart {
  type: string;
  text?: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
}

interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  cloudRule?: string;
}

interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  native?: NativeExecBinding;
}

/** A bridge kept alive across requests for tool result continuation. */
interface ActiveBridge {
  bridge: ReturnType<typeof spawnBridge>;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  cloudRule?: string;
  pendingExecs: PendingExec[];
}

// Active bridges keyed by a session token (derived from conversation state).
// When tool_calls are returned, the bridge stays alive. The next request
// with tool results looks up the bridge and sends mcpResult messages.
const activeBridges = new Map<string, ActiveBridge>();

// Teardown hooks for live HTTP/1.1 streams, called by stopProxy().
const activeHttp1Streams = new Set<() => void>();

// After a tool call the HTTP/1.1 stream stays open, and the continuation is a
// new request. Cursor may never close the old one, so cap how long it lives.
const HTTP1_PAUSED_STREAM_MAX_MS = 10 * 60 * 1000;
let http1PausedStreamMaxMs = HTTP1_PAUSED_STREAM_MAX_MS;

/** Test hook: shorten the paused-stream cap. Call without an argument to restore it. */
export function setHttp1PausedStreamMaxMsForTesting(ms = HTTP1_PAUSED_STREAM_MAX_MS): void {
  http1PausedStreamMaxMs = ms;
}

const conversationStates = new Map<string, StoredConversation>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONVERSATION_DIR = pathResolve(
  process.env.XDG_CACHE_HOME ?? pathResolve(homedir(), ".cache"),
  "opencode-cursor",
  "conversations",
);

const PersistedConversationSchema = z.object({
  conversationId: z.string(),
  checkpoint: z.string().nullable(),
  blobs: z.record(z.string()),
  lastAccessMs: z.number(),
});

interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
}

function persistConversation(convKey: string, stored: StoredConversation): void {
  const payload = {
    conversationId: stored.conversationId,
    checkpoint: stored.checkpoint
      ? Buffer.from(stored.checkpoint).toString("base64")
      : null,
    blobs: Object.fromEntries(
      [...stored.blobStore].map(([id, data]) => [
        id,
        Buffer.from(data).toString("base64"),
      ]),
    ),
    lastAccessMs: stored.lastAccessMs,
  } satisfies z.infer<typeof PersistedConversationSchema>;
  void mkdir(CONVERSATION_DIR, { recursive: true })
    .then(() =>
      writeFile(
        pathResolve(CONVERSATION_DIR, `${convKey}.json`),
        JSON.stringify(payload),
      ),
    )
    .catch(() => {});
}

async function loadPersistedConversation(
  convKey: string,
): Promise<StoredConversation | undefined> {
  try {
    const raw = await readFile(
      pathResolve(CONVERSATION_DIR, `${convKey}.json`),
      "utf8",
    );
    const parsed = PersistedConversationSchema.parse(JSON.parse(raw));
    if (Date.now() - parsed.lastAccessMs > CONVERSATION_DISK_TTL_MS) {
      return undefined;
    }
    return {
      conversationId: parsed.conversationId,
      checkpoint: parsed.checkpoint
        ? new Uint8Array(Buffer.from(parsed.checkpoint, "base64"))
        : null,
      blobStore: new Map(
        Object.entries(parsed.blobs).map(([id, data]) => [
          id,
          new Uint8Array(Buffer.from(data, "base64")),
        ]),
      ),
      lastAccessMs: Date.now(),
    };
  } catch {
    return undefined;
  }
}

function pruneStaleConversationFiles(): void {
  void (async () => {
    try {
      const entries = await readdir(CONVERSATION_DIR);
      const cutoff = Date.now() - CONVERSATION_DISK_TTL_MS;
      for (const entry of entries) {
        const file = pathResolve(CONVERSATION_DIR, entry);
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      }
    } catch {}
  })();
}

function evictStaleConversations(): void {
  const now = Date.now();
  for (const [key, stored] of conversationStates) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      conversationStates.delete(key);
    }
  }
}

/** Length-prefix a message: [4-byte BE length][payload] */
function lpEncode(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload] */
function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

/**
 * Spawn the Node H2 bridge and return read/write handles.
 * The bridge uses length-prefixed framing on stdin/stdout.
 */
interface SpawnBridgeOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
  /** When true, use application/proto for unary RPCs instead of Connect streaming. */
  unary?: boolean;
}

function spawnBridge(options: SpawnBridgeOptions): {
  proc: ReturnType<typeof Bun.spawn>;
  write: (data: Uint8Array) => void;
  end: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  /** True while the bridge subprocess is still running. */
  get alive(): boolean;
} {
  const proc = Bun.spawn(["node", BRIDGE_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
    unary: options.unary ?? false,
  });
  proc.stdin.write(lpEncode(new TextEncoder().encode(config)));

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
  };

  // Track exit state so late onClose registrations fire immediately.
  let exited = false;
  let exitCode = 1;

  (async () => {
    const reader = proc.stdout.getReader();
    let pending = Buffer.alloc(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);

        while (pending.length >= 4) {
          const len = pending.readUInt32BE(0);
          if (pending.length < 4 + len) break;
          const payload = pending.subarray(4, 4 + len);
          pending = pending.subarray(4 + len);
          cbs.data?.(Buffer.from(payload));
        }
      }
    } catch {
      // Stream ended
    }

    const code = await proc.exited ?? 1;
    exited = true;
    exitCode = code;
    cbs.close?.(code);
  })();

  return {
    proc,
    get alive() { return !exited; },
    write(data) {
      try { proc.stdin.write(lpEncode(data)); } catch {}
    },
    end() {
      try {
        proc.stdin.write(lpEncode(new Uint8Array(0)));
        proc.stdin.end();
      } catch {}
    },
    onData(cb) { cbs.data = cb; },
    onClose(cb) {
      if (exited) {
        // Process already exited — invoke immediately so streams don't hang.
        queueMicrotask(() => cb(exitCode));
      } else {
        cbs.close = cb;
      }
    },
  };
}

interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
 ): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const bridge = spawnBridge({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
  });
  const chunks: Buffer[] = [];
  const { promise, resolve } = Promise.withResolvers<{
    body: Uint8Array;
    exitCode: number;
    timedOut: boolean;
  }>();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try { bridge.proc.kill(); } catch {}
      }, timeoutMs)
    : undefined;

  bridge.onData((chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  bridge.onClose((exitCode) => {
    if (timeout) clearTimeout(timeout);
    resolve({
      body: Buffer.concat(chunks),
      exitCode,
      timedOut,
    });
  });

  // Unary: send raw protobuf body (no Connect framing)
  bridge.write(options.requestBody);
  bridge.end();

  return promise;
}

function buildOpenAIModelList(models: ReadonlyArray<{ id: string; name: string }>): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}> {
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
  }));
}

export function getProxyPort(): number | undefined {
  return proxyPort;
}

let proxyServer: ReturnType<typeof Bun.serve> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;

export async function startProxy(
  getAccessToken: () => Promise<string>,
  models: ReadonlyArray<{ id: string; name: string }> = [],
  disableHttp2 = CURSOR_DISABLE_HTTP2,
): Promise<number> {
  proxyDisableHttp2 = disableHttp2;
  proxyAccessTokenProvider = getAccessToken;
  proxyModels = models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
  if (proxyServer && proxyPort) return proxyPort;

  pruneStaleConversationFiles();

  proxyServer = Bun.serve({
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: buildOpenAIModelList(proxyModels),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        try {
          const body = (await req.json()) as ChatCompletionRequest;
          if (!proxyAccessTokenProvider) {
            throw new Error("Cursor proxy access token provider not configured");
          }
          const accessToken = await proxyAccessTokenProvider();
          return handleChatCompletion(body, accessToken);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return new Response(
            JSON.stringify({
              error: { message, type: "server_error", code: "internal_error" },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  proxyPort = proxyServer.port;
  if (!proxyPort) throw new Error("Failed to bind proxy to a port");
  return proxyPort;
}

export function stopProxy(): void {
  if (proxyServer) {
    proxyServer.stop();
    proxyServer = undefined;
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
    proxyModels = [];
  }
  // Clean up any lingering bridges
  for (const active of activeBridges.values()) {
    clearInterval(active.heartbeatTimer);
    // end() only half-closes the request; killing also stops the response.
    try { active.bridge.proc.kill(); } catch {}
  }
  activeBridges.clear();
  for (const abort of [...activeHttp1Streams]) abort();
  activeHttp1Streams.clear();
  conversationStates.clear();
}


interface CallCursorOptions {
  unary?: boolean;
  timeoutMs?: number;
  requestId?: string;
  /** Aborts an in-flight HTTP/1.1 request, including its streaming body. */
  signal?: AbortSignal;
}

/**
 * One Cursor request over the active transport. HTTP/1.1 supports unary and
 * streaming (RunSSE). HTTP/2 is unary only: streaming Run uses a per-stream
 * bridge (spawnBridge) because the stream needs a live bidirectional channel.
 */
export async function callCursor(
  accessToken: string,
  rpcPath: string,
  body: Uint8Array,
  options?: CallCursorOptions,
): Promise<Response> {
  if (proxyDisableHttp2) return callCursorHttp1(accessToken, rpcPath, body, options);
  if (options?.unary !== true) {
    throw new Error("HTTP/2 streaming requests use a per-stream bridge, not callCursor");
  }
  const result = await callCursorUnaryRpc({
    accessToken,
    rpcPath,
    requestBody: body,
    timeoutMs: options.timeoutMs,
  });
  if (result.timedOut || result.exitCode !== 0) {
    if (process.env.CURSOR_PROXY_DEBUG) {
      console.error("[proxy] callCursor error:", result.timedOut ? "timeout" : `bridge exit ${result.exitCode}`);
    }
    throw new Error("Request to Cursor API failed");
  }
  return new Response(Buffer.from(result.body), { headers: { "content-type": "application/proto" } });
}

async function callCursorHttp1(
  accessToken: string,
  rpcPath: string,
  body: Uint8Array,
  options?: CallCursorOptions,
): Promise<Response> {
  const requestId = options?.requestId ?? crypto.randomUUID();
  const built = buildHttp1CursorRequest(rpcPath, body, options?.unary === true, requestId);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? (options?.unary ? 10_000 : 120_000),
  );
  options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  if (options?.signal?.aborted) controller.abort();
  try {
    const response = await fetch(`${CURSOR_API_URL}${built.path}`, {
      method: "POST",
      headers: { ...built.headers, Authorization: `Bearer ${accessToken}` },
      body: Buffer.from(built.body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    if (process.env.CURSOR_PROXY_DEBUG) {
      console.error("[proxy] callCursor error:", err);
    }
    throw new Error("Request to Cursor API failed");
  }
}

const BIDI_APPEND_ATTEMPTS = 4;

function createHttp1ClientChannel(
  accessToken: string,
  requestId: string,
  onFailure: (err: Error) => void,
): {
  sendFrame: (data: Uint8Array) => void;
  sendInitial: (data: Uint8Array) => Promise<void>;
  startHeartbeat: () => void;
  stop: () => void;
} {
  let appendSeqno = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  // The server applies appends in seqno order, so a lost seqno stalls the turn.
  const post = async (data: Uint8Array): Promise<void> => {
    const body = encodeBidiAppendRequest(data, requestId, appendSeqno++);
    let lastError: unknown;
    for (let attempt = 0; attempt < BIDI_APPEND_ATTEMPTS && !stopped; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      try {
        const response = await callCursor(accessToken, BIDI_APPEND_PATH, body, {
          unary: true,
          timeoutMs: 10_000,
          requestId,
        });
        if (response.ok) {
          await response.arrayBuffer().catch(() => {});
          return;
        }
        lastError = new Error(`BidiAppend failed: ${response.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    if (stopped) return;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
  const sendFrame = (data: Uint8Array) => {
    void post(data).catch((err: Error) => {
      if (stopped) return;
      console.error("[proxy] BidiAppend failed:", err.message);
      onFailure(err);
    });
  };
  const heartbeat = toBinary(
    AgentClientMessageSchema,
    create(AgentClientMessageSchema, {
      message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
    }),
  );
  return {
    sendFrame,
    sendInitial: post,
    startHeartbeat() {
      timer = setInterval(() => sendFrame(heartbeat), 5_000);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  /** Paths of Cursor edit tool calls in progress, keyed by tool call id. */
  editPaths: Map<string, string>;
}

function createStreamState(): StreamState {
  return { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, editPaths: new Map() };
}

function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens || completion_tokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
}

function sendInteractionResponse(
  id: number,
  resultCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(InteractionResponseSchema, {
    id,
    result: { case: resultCase as never, value: value as never },
  });
  const client = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, client));
}

function approveInteraction(
  query: InteractionQuery,
  resultCase: string,
  schema: Parameters<typeof create>[0],
  approvedSchema: Parameters<typeof create>[0],
  sendFrame: (data: Uint8Array) => void,
): void {
  sendInteractionResponse(
    query.id,
    resultCase,
    create(schema, {
      result: { case: "approved", value: create(approvedSchema, {}) },
    }),
    sendFrame,
  );
}

export function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
): void {
  const queryCase = query.query.case;
  if (queryCase === "webSearchRequestQuery") {
    approveInteraction(query, "webSearchRequestResponse", WebSearchRequestResponseSchema, WebSearchRequestResponse_ApprovedSchema, sendFrame);
    return;
  }
  if (queryCase === "exaSearchRequestQuery") {
    approveInteraction(query, "exaSearchRequestResponse", ExaSearchRequestResponseSchema, ExaSearchRequestResponse_ApprovedSchema, sendFrame);
    return;
  }
  if (queryCase === "exaFetchRequestQuery") {
    approveInteraction(query, "exaFetchRequestResponse", ExaFetchRequestResponseSchema, ExaFetchRequestResponse_ApprovedSchema, sendFrame);
    return;
  }
  if (queryCase === "switchModeRequestQuery") {
    sendInteractionResponse(
      query.id,
      "switchModeRequestResponse",
      create(SwitchModeRequestResponseSchema, {
        result: {
          case: "rejected",
          value: create(SwitchModeRequestResponse_RejectedSchema, { reason: "Mode switch is not available in this client." }),
        },
      }),
      sendFrame,
    );
    return;
  }
  if (queryCase === "askQuestionInteractionQuery") {
    sendInteractionResponse(
      query.id,
      "askQuestionInteractionResponse",
      create(AskQuestionInteractionResponseSchema, {
        result: create(AskQuestionResultSchema, {
          result: { case: "error", value: create(AskQuestionErrorSchema, { errorMessage: "Asking the user is not available in this client." }) },
        }),
      }),
      sendFrame,
    );
    return;
  }
  if (queryCase === "createPlanRequestQuery") {
    sendInteractionResponse(
      query.id,
      "createPlanRequestResponse",
      create(CreatePlanRequestResponseSchema, {
        result: create(CreatePlanResultSchema, {
          planUri: "",
          result: { case: "error", value: create(CreatePlanErrorSchema, { error: "Plan files are not available in this client." }) },
        }),
      }),
      sendFrame,
    );
    return;
  }
  const unknown = (query.$unknown ?? []).find((field) => field.wireType === WIRE_LEN && field.no === 9);
  if (unknown) {
    const response = concatBytes(protoVarintField(1, query.id), encodeLengthDelimited(9, encodeLengthDelimited(1, new Uint8Array())));
    sendFrame(encodeLengthDelimited(6, response));
    return;
  }
  if (process.env.CURSOR_PROXY_DEBUG) {
    console.error(`[proxy] unhandled interaction query: ${queryCase ?? "unknown"}`);
  }
}

function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
): void {
  const msgCase = msg.message.case;

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(msg.message.value, state, onText);
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      cloudRule,
      sendFrame,
      onMcpExec,
      state.editPaths,
    );
  } else if (msgCase === "interactionQuery") {
    handleInteractionQuery(msg.message.value as InteractionQuery, sendFrame);
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  }
}

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
): void {
  const updateCase = update.message?.case;
  if (updateCase === "textDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, false);
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, true);
  } else if (updateCase === "tokenDelta") {
    state.outputTokens += update.message.value.tokens ?? 0;
  } else if (updateCase === "toolCallStarted") {
    const { callId, toolCall } = update.message.value;
    if (callId && toolCall?.tool?.case === "editToolCall") {
      const path = toolCall.tool.value?.args?.path;
      if (path) state.editPaths.set(callId, path);
    }
  } else if (updateCase === "toolCallCompleted") {
    const callId = update.message.value.callId;
    if (callId) state.editPaths.delete(callId);
  }
}

function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMsg));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case;
  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    if (process.env.CURSOR_PROXY_DEBUG) {
      console.error(`[proxy] getBlob ${blobIdKey.slice(0, 16)} ${blobData ? `hit (${blobData.length}b)` : "MISS"}`);
    }
    sendKvResponse(kvMsg, "getBlobResult", create(GetBlobResultSchema, blobData ? { blobData } : {}), sendFrame);
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    if (process.env.CURSOR_PROXY_DEBUG) {
      console.error(`[proxy] setBlob ${Buffer.from(blobId).toString("hex").slice(0, 16)} (${blobData.length}b)`);
    }
    sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
  }
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

function protoVarintField(field: number, value: number): Uint8Array {
  return concatBytes(encodeVarint(BigInt(field << 3)), encodeVarint(BigInt(value)));
}

function protoStringField(field: number, value: string): Uint8Array {
  return encodeLengthDelimited(field, new TextEncoder().encode(value));
}

interface ProtoField {
  no: number;
  wire: number;
  payload: Uint8Array;
}

function readProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [tag, tagNext] = readVarint(buf, i);
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    i = tagNext;
    if (wire === WIRE_VARINT) {
      const [, valueNext] = readVarint(buf, i);
      fields.push({ no, wire, payload: buf.subarray(i, valueNext) });
      i = valueNext;
    } else if (wire === WIRE_FIXED64) {
      if (i + 8 > buf.length) break;
      fields.push({ no, wire, payload: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === WIRE_LEN) {
      const [len, lenNext] = readVarint(buf, i);
      const start = lenNext;
      const end = start + Number(len);
      if (end > buf.length) break;
      fields.push({ no, wire, payload: buf.subarray(start, end) });
      i = end;
    } else if (wire === WIRE_FIXED32) {
      if (i + 4 > buf.length) break;
      fields.push({ no, wire, payload: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}

function unknownFieldPayload(data: Uint8Array): Uint8Array {
  const [len, next] = readVarint(data, 0);
  const end = next + Number(len);
  if (end > data.length) return new Uint8Array();
  return data.subarray(next, end);
}

function fieldString(fields: ProtoField[], no: number): string {
  const field = fields.find((item) => item.no === no && item.wire === WIRE_LEN);
  return field ? new TextDecoder().decode(field.payload) : "";
}

function fieldVarint(fields: ProtoField[], no: number): number | undefined {
  const field = fields.find((item) => item.no === no && item.wire === WIRE_VARINT);
  if (!field) return undefined;
  const [value] = readVarint(field.payload, 0);
  return Number(value);
}

function sendRawExecResult(
  execMsg: ExecServerMessage,
  resultField: number,
  result: Uint8Array,
  sendFrame: (data: Uint8Array) => void,
): void {
  const parts = [protoVarintField(1, execMsg.id)];
  if (execMsg.execId) parts.push(protoStringField(15, execMsg.execId));
  parts.push(encodeLengthDelimited(resultField, result));
  sendFrame(encodeLengthDelimited(2, concatBytes(...parts)));
}

function sendExecThrow(
  execMsg: ExecServerMessage,
  error: string,
  sendFrame: (data: Uint8Array) => void,
): void {
  const control = create(ExecClientControlMessageSchema, {
    message: {
      case: "throw",
      value: create(ExecClientThrowSchema, { id: execMsg.id, error }),
    },
  });
  const client = create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: control },
  });
  sendFrame(toBinary(AgentClientMessageSchema, client));
}

function answerControlExec(
  fieldNo: number,
  payload: Uint8Array,
  execMsg: ExecServerMessage,
  sendFrame: (data: Uint8Array) => void,
): boolean {
  if (fieldNo === 27) {
    const request = readProtoFields(payload).find((field) => field.no === 1 && field.wire === WIRE_LEN);
    const requestCase = request
      ? readProtoFields(request.payload).find((field) => field.wire === WIRE_LEN)?.no
      : undefined;
    const response = requestCase ? encodeLengthDelimited(requestCase, new Uint8Array()) : new Uint8Array();
    sendRawExecResult(execMsg, 27, encodeLengthDelimited(1, response), sendFrame);
    return true;
  }
  if (fieldNo === 36) {
    sendRawExecResult(execMsg, 36, encodeLengthDelimited(1, new Uint8Array()), sendFrame);
    return true;
  }
  if (fieldNo === 38) {
    sendRawExecResult(execMsg, 38, encodeLengthDelimited(1, protoVarintField(1, 1)), sendFrame);
    return true;
  }
  if (fieldNo === 41 || fieldNo === 42 || fieldNo === 43) {
    sendRawExecResult(execMsg, fieldNo, protoVarintField(1, 1), sendFrame);
    return true;
  }
  return false;
}

function pickTool(mcpTools: McpToolDefinition[], candidates: string[]): string | undefined {
  const available = new Set(mcpTools.map((tool) => tool.name || tool.toolName).filter(Boolean));
  return candidates.find((name) => available.has(name));
}

function redirectUnknownTool(
  fieldNo: number,
  payload: Uint8Array,
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  onMcpExec: (exec: PendingExec) => void,
): boolean {
  const emit = (toolName: string | undefined, decodedArgs: Record<string, unknown>, toolCallId?: string) => {
    if (!toolName) return false;
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decodedArgs),
    });
    return true;
  };

  if (fieldNo === 29) {
    const args = fromBinary(ReadArgsSchema, payload);
    return emit(pickTool(mcpTools, ["read"]), { filePath: args.path ?? "" }, args.toolCallId);
  }

  const fields = readProtoFields(payload);
  if (fieldNo === 45) {
    const decoded: Record<string, unknown> = { filePath: fieldString(fields, 1) };
    const offset = fieldVarint(fields, 2);
    const limit = fieldVarint(fields, 3);
    if (offset) decoded.offset = offset;
    if (limit) decoded.limit = limit;
    return emit(pickTool(mcpTools, ["read"]), decoded);
  }
  if (fieldNo === 46) {
    return emit(pickTool(mcpTools, ["bash"]), { command: fieldString(fields, 1), description: "Runs shell command" });
  }
  if (fieldNo === 47) {
    const edit = fields.find((field) => field.no === 2 && field.wire === WIRE_LEN);
    const replacement = edit ? readProtoFields(edit.payload) : [];
    return emit(pickTool(mcpTools, ["edit"]), {
      filePath: fieldString(fields, 1),
      oldString: fieldString(replacement, 1),
      newString: fieldString(replacement, 2),
    });
  }
  if (fieldNo === 48) {
    return emit(pickTool(mcpTools, ["write"]), {
      filePath: fieldString(fields, 1),
      content: fieldString(fields, 2),
    });
  }
  if (fieldNo === 49) {
    const decoded: Record<string, unknown> = { pattern: fieldString(fields, 1) || "." };
    const path = fieldString(fields, 2);
    const glob = fieldString(fields, 3);
    if (path) decoded.path = path;
    if (glob) decoded.include = glob;
    return emit(pickTool(mcpTools, ["grep"]), decoded);
  }
  if (fieldNo === 50) {
    const decoded: Record<string, unknown> = { pattern: fieldString(fields, 1) };
    const path = fieldString(fields, 2);
    if (path) decoded.path = path;
    return emit(pickTool(mcpTools, ["glob", "find"]), decoded);
  }
  if (fieldNo === 51) {
    return emit(pickTool(mcpTools, ["glob"]), { pattern: "*", path: fieldString(fields, 1) });
  }
  return false;
}

const CONTROL_EXEC_FIELDS = new Set([27, 36, 38, 41, 42, 43]);
const TOOL_EXEC_FIELDS = new Set([29, 45, 46, 47, 48, 49, 50, 51]);

export function answerUnknownExec(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): void {
  const unknown = (execMsg.$unknown ?? []).filter((field) => field.wireType === WIRE_LEN);
  const chosen = unknown.find((field) => CONTROL_EXEC_FIELDS.has(field.no) || TOOL_EXEC_FIELDS.has(field.no)) ?? unknown[0];
  if (chosen) {
    const payload = unknownFieldPayload(chosen.data);
    if (answerControlExec(chosen.no, payload, execMsg, sendFrame)) return;
    if (redirectUnknownTool(chosen.no, payload, execMsg, mcpTools, onMcpExec)) return;
    if (process.env.CURSOR_PROXY_DEBUG) console.error(`[proxy] unhandled exec field ${chosen.no}`);
  }
  sendExecThrow(execMsg, "This Cursor tool is not available. Use the MCP tools provided instead.", sendFrame);
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
  editPaths: Map<string, string> = new Map(),
): void {
  const execCase = execMsg.message.case;
  if (process.env.CURSOR_PROXY_DEBUG) {
    console.error(`[proxy] exec: ${execCase}`);
  }

  // Cursor applies an edit server-side: it reads the file, then sends writeArgs.
  // Redirecting that read to OpenCode ends the turn and the edit is lost.
  if (execCase === "readArgs") {
    const { path, toolCallId } = execMsg.message.value;
    if (path && isAbsolute(path) && (editPaths.has(toolCallId) || [...editPaths.values()].includes(path))) {
      void answerEditRead(execMsg, path, sendFrame);
      return;
    }
  }

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [], cloudRule, repositoryInfo: [], tools: mcpTools,
      gitRepos: [], projectLayouts: [], mcpInstructions: [],
      fileContents: {}, customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = execMsg.message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    onMcpExec({
      execId: execMsg.execId, execMsgId: execMsg.id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  const redirect = redirectNativeExec(execMsg, mcpTools);
  if (redirect) {
    if (process.env.CURSOR_PROXY_DEBUG) console.error(`[proxy] redirect ${execCase} -> ${redirect.toolName}`);
    onMcpExec({ execId: execMsg.execId, execMsgId: execMsg.id, toolCallId: redirect.toolCallId, toolName: redirect.toolName, decodedArgs: redirect.decodedArgs, native: redirect.binding });
    return;
  }

  const REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";
  const rejectAndSend = (resultType: string, schema: any) => {
    sendExecResult(execMsg, resultType, create(schema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: "", reason: REJECT_REASON }) } }), sendFrame);
  };

  if (execCase === "readArgs") { sendExecResult(execMsg, "readResult", create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: (execMsg.message.value as any).path, reason: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "lsArgs") { sendExecResult(execMsg, "lsResult", create(LsResultSchema, { result: { case: "rejected", value: create(LsRejectedSchema, { path: (execMsg.message.value as any).path, reason: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "grepArgs") { sendExecResult(execMsg, "grepResult", create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "writeArgs") { sendExecResult(execMsg, "writeResult", create(WriteResultSchema, { result: { case: "rejected", value: create(WriteRejectedSchema, { path: (execMsg.message.value as any).path, reason: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "deleteArgs") { sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, { result: { case: "rejected", value: create(DeleteRejectedSchema, { path: (execMsg.message.value as any).path, reason: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") { sendExecResult(execMsg, "shellResult", create(ShellResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: (execMsg.message.value as any).command ?? "", workingDirectory: (execMsg.message.value as any).workingDirectory ?? "", reason: REJECT_REASON, isReadonly: false }) } }), sendFrame); return; }
  if (execCase === "backgroundShellSpawnArgs") { sendExecResult(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: (execMsg.message.value as any).command ?? "", workingDirectory: (execMsg.message.value as any).workingDirectory ?? "", reason: REJECT_REASON, isReadonly: false }) } }), sendFrame); return; }
  if (execCase === "writeShellStdinArgs") { sendExecResult(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, { result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "fetchArgs") { sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url: (execMsg.message.value as any).url ?? "", error: REJECT_REASON }) } }), sendFrame); return; }
  if (execCase === "diagnosticsArgs") { sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame); return; }

  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) { sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame); return; }
  if (!execCase) {
    answerUnknownExec(execMsg, mcpTools, sendFrame, onMcpExec);
    return;
  }
  if (process.env.CURSOR_PROXY_DEBUG) console.error(`[proxy] unhandled exec: ${execCase}`);
  sendExecThrow(execMsg, "This Cursor tool is not available. Use the MCP tools provided instead.", sendFrame);
}

async function answerEditRead(
  execMsg: ExecServerMessage,
  path: string,
  sendFrame: (data: Uint8Array) => void,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const result = code === "ENOENT"
      ? create(ReadResultSchema, { result: { case: "fileNotFound", value: create(ReadFileNotFoundSchema, { path }) } })
      : create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path, reason: String(code ?? err) }) } });
    sendExecResult(execMsg, "readResult", result, sendFrame);
    return;
  }
  sendNativeExecResult(
    { execId: execMsg.execId, execMsgId: execMsg.id },
    { resultType: "readResult", args: { path } },
    text,
    sendFrame,
  );
}

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id, execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
}

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      const message = error.message ?? "Unknown error";
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

interface BodyParser {
  push(chunk: Uint8Array): void;
  flush(): void;
}

function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): BodyParser {
  let pending = Buffer.alloc(0);
  return {
    push(incoming: Uint8Array) {
      pending = Buffer.concat([pending, Buffer.from(incoming)]);
      while (pending.length >= 5) {
        const flags = pending[0]!;
        const msgLen = pending.readUInt32BE(1);
        if (pending.length < 5 + msgLen) break;
        const messageBytes = pending.subarray(5, 5 + msgLen);
        pending = pending.subarray(5 + msgLen);
        if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
        else onMessage(messageBytes);
      }
    },
    flush() {},
  };
}

function isSingleConnectEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  return bytes.length === 5 + length;
}

function consumeSseEvent(
  event: string,
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
  frames: BodyParser,
): void {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return;
  if (data.startsWith("{")) {
    onEndStream(new TextEncoder().encode(data));
    return;
  }
  const compact = data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return;
  const bytes = new Uint8Array(Buffer.from(compact, "base64"));
  if (isSingleConnectEnvelope(bytes)) frames.push(bytes);
  else onMessage(bytes);
}

function createEventStreamParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): BodyParser {
  let buffer = "";
  const frames = createConnectFrameParser(onMessage, onEndStream);
  const consume = (event: string) => consumeSseEvent(event, onMessage, onEndStream, frames);
  return {
    push(chunk: Uint8Array) {
      buffer += new TextDecoder().decode(chunk).replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) consume(event);
    },
    flush() {
      if (!buffer.trim()) return;
      const event = buffer;
      buffer = "";
      consume(event);
    },
  };
}

function createResponseBodyParser(
  contentType: string | null,
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): BodyParser {
  const frames = createConnectFrameParser(onMessage, onEndStream);
  if (!contentType?.includes("text/event-stream")) return frames;

  // Cursor's HTTP/1.1 fallback sets text/event-stream, but the body is still
  // raw Connect envelopes (HealthService/StreamSSE and AgentService/RunSSE).
  const events = createEventStreamParser(onMessage, onEndStream);
  let decided: BodyParser | undefined;
  const buffered: Uint8Array[] = [];
  return {
    push(chunk: Uint8Array) {
      if (decided) {
        decided.push(chunk);
        return;
      }
      buffered.push(chunk);
      const first = buffered.find((part) => part.length > 0)?.[0];
      if (first === undefined) return;
      decided = first <= 0x03 ? frames : events;
      for (const pending of buffered) decided.push(pending);
      buffered.length = 0;
    },
    flush() {
      if (!decided && buffered.length > 0) {
        decided = events;
        for (const pending of buffered) decided.push(pending);
        buffered.length = 0;
      }
      (decided ?? frames).flush();
    },
  };
}

const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent'];
const MAX_THINKING_TAG_LEN = 16;

function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
} {
  let buffer = '';
  let inThinking = false;
  return {
    process(text: string) {
      const input = buffer + text;
      buffer = '';
      let content = '';
      let reasoning = '';
      let lastIdx = 0;
      const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join('|')})\\s*>`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before; else content += before;
        inThinking = match[1] !== '/';
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf('<');
      if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before; else content += before;
      } else {
        if (inThinking) reasoning += rest; else content += rest;
      }
      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = '';
      if (!b) return { content: '', reasoning: '' };
      return inThinking ? { content: '', reasoning: b } : { content: b, reasoning: '' };
    },
  };
}

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name, description: fn.description || "",
      providerIdentifier: "opencode", toolName: fn.name, inputSchema,
    });
  });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try { const parsed = fromBinary(ValueSchema, value); return toJson(ValueSchema, parsed); } catch {}
  return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) { decoded[key] = decodeMcpArgValue(value); }
  return decoded;
}

function deriveBridgeKey(modelId: string, messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`bridge:${modelId}:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

function deriveConversationKey(messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`conv:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${(0x8 | (parseInt(hex[16]!, 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n");
}

async function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
): Promise<Response> {
  const { systemPrompts, userText, history, toolResults } = parseMessages(body.messages);
  const modelId = body.model;
  const tools = body.tools ?? [];

  if (!userText && history.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: "No user message found",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // bridgeKey: model-specific, for active tool-call bridges
  // convKey: model-independent, for conversation state that survives model switches
  const bridgeKey = deriveBridgeKey(modelId, body.messages);
  const convKey = deriveConversationKey(body.messages);
  const activeBridge = activeBridges.get(bridgeKey);

  if (activeBridge && toolResults.length > 0) {
    activeBridges.delete(bridgeKey);

    if (activeBridge.bridge.alive) {
      // Resume the live bridge with tool results
      return handleToolResultResume(activeBridge, toolResults, userText, modelId, bridgeKey, convKey);
    }

    // Bridge died (timeout, server disconnect, etc.).
    // Clean up and fall through to start a fresh bridge.
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
  }

  // Clean up stale bridge if present
  if (activeBridge && activeBridges.has(bridgeKey)) {
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
    activeBridges.delete(bridgeKey);
  }

  let stored = conversationStates.get(convKey);
  if (!stored) {
    // Fall back to the disk cache so conversations survive proxy restarts
    // and in-memory TTL eviction (issues #22/#29).
    stored = (await loadPersistedConversation(convKey)) ?? {
      conversationId: deterministicUuid(`cursor-conv-id:${convKey}`),
      checkpoint: null,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    };
    conversationStates.set(convKey, stored);
  }
  stored.lastAccessMs = Date.now();
  evictStaleConversations();

  // Build the request. When the bridge died mid tool-call, history already
  // contains the tool results and the request goes out as a resumeAction.
  const mcpTools = buildMcpToolDefinitions(tools);
  const payload = buildCursorRequest(
    modelId, systemPrompts, userText, history,
    stored.conversationId, stored.checkpoint, stored.blobStore, toolResults,
  );
  payload.mcpTools = mcpTools;

  if (body.stream === false) {
    return handleNonStreamingResponse(payload, accessToken, modelId, convKey);
  }
  return handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey);
}


async function handleHttp1StreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  let cancelStream: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const sendSSE = (data: object) => { if (closed) return; controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
      const sendDone = () => { if (closed) return; controller.enqueue(encoder.encode("data: [DONE]\n\n")); };
      const closeController = () => { if (closed) return; closed = true; controller.close(); };
      const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id: completionId, object: "chat.completion.chunk", created, model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const makeUsageChunk = () => { const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state); return { id: completionId, object: "chat.completion.chunk", created, model: modelId, choices: [], usage: { prompt_tokens, completion_tokens, total_tokens } }; };

      const state = createStreamState();
      const tagFilter = createThinkingTagFilter();
      let mcpExecReceived = false;
      const requestId = crypto.randomUUID();
      let channelError: Error | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const http1 = createHttp1ClientChannel(accessToken, requestId, (err) => {
        channelError ??= err;
        void reader?.cancel(err).catch(() => {});
      });
      const sendFrame = http1.sendFrame;
      const abort = new AbortController();
      // Stops BidiAppend retries and the heartbeat, and aborts the RunSSE body.
      let pausedTimer: ReturnType<typeof setTimeout> | undefined;
      const teardown = () => {
        clearTimeout(pausedTimer);
        http1.stop();
        abort.abort();
        activeHttp1Streams.delete(teardown);
      };
      activeHttp1Streams.add(teardown);
      cancelStream = () => {
        if (closed) return;
        closed = true;
        teardown();
      };

      const processChunk = (messageBytes: Uint8Array) => {
        try {
          const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
          processServerMessage(serverMessage, payload.blobStore, payload.mcpTools, payload.cloudRule,
            sendFrame, state,
            (text, isThinking) => {
              if (isThinking) { sendSSE(makeChunk({ reasoning_content: text })); }
              else { const { content, reasoning } = tagFilter.process(text); if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning })); if (content) sendSSE(makeChunk({ content })); }
            },
            (exec) => {
              state.pendingExecs.push(exec); mcpExecReceived = true;
              const flushed = tagFilter.flush();
              if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
              if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));
              const toolCallIndex = state.toolCallIndex++;
              sendSSE(makeChunk({ tool_calls: [{ index: toolCallIndex, id: exec.toolCallId, type: "function", function: { name: exec.toolName, arguments: exec.decodedArgs } }] }));
              sendSSE(makeChunk({}, "tool_calls")); sendDone(); closeController();
              // The SSE is closed but the upstream stays open; bound it.
              pausedTimer ??= setTimeout(teardown, http1PausedStreamMaxMs);
              pausedTimer.unref?.();
            },
            (checkpointBytes) => {
              const stored = conversationStates.get(convKey);
              if (stored) { stored.checkpoint = checkpointBytes; for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v); stored.lastAccessMs = Date.now(); persistConversation(convKey, stored); }
            },
          );
        } catch { /* Skip */ }
      };

      const handleEndStream = (endStreamBytes: Uint8Array) => {
        const endError = parseConnectEndStream(endStreamBytes);
        if (endError) {
          sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
          sendSSE(makeChunk({}, "stop")); sendSSE(makeUsageChunk()); sendDone(); closeController();
        }
      };

      (async () => {
        try {
          const response = await callCursor(
            accessToken,
            "/agent.v1.AgentService/Run",
            payload.requestBytes,
            { requestId, signal: abort.signal },
          );
          await http1.sendInitial(payload.requestBytes);
          http1.startHeartbeat();
          reader = response.body!.getReader();
          if (channelError) await reader.cancel(channelError).catch(() => {});
          const parser = createResponseBodyParser(
            response.headers.get("content-type"),
            processChunk,
            handleEndStream,
          );

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(value);
          }
          if (channelError) throw channelError;
          parser.flush();
        } catch (e) {
          if (!closed) {
            sendSSE(makeChunk({ content: `\n[Error: ${e instanceof Error ? e.message : String(e)}]` }));
            sendSSE(makeChunk({}, "stop")); sendDone(); closeController();
          }
        } finally {
          teardown();
        }
        if (!mcpExecReceived && !closed) {
          const flushed = tagFilter.flush();
          if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
          if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));
          sendSSE(makeChunk({}, "stop")); sendSSE(makeUsageChunk()); sendDone(); closeController();
        }
      })();
    },
    cancel() {
      cancelStream?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}


/** Create an SSE streaming Response that reads from a live bridge. */
function createBridgeStreamResponse(
  bridge: ReturnType<typeof spawnBridge>,
  heartbeatTimer: NodeJS.Timeout,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  modelId: string,
  bridgeKey: string,
  convKey: string,
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  let closed = false;
  let cancelStream: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const sendSSE = (data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const sendDone = () => {
        if (closed) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const stopBridge = () => {
        if (activeBridges.get(bridgeKey)?.bridge === bridge) {
          activeBridges.delete(bridgeKey);
        }
        clearInterval(heartbeatTimer);
        // end() only half-closes the request; killing also stops the response.
        try { bridge.proc.kill(); } catch {}
      };
      const closeController = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      // A paused bridge closes its controller on purpose and stays registered
      // in activeBridges for tool-result continuation. Tearing that down would
      // break the round-trip OpenCode is about to make.
      cancelStream = () => {
        if (closed) return;
        closed = true;
        stopBridge();
      };

      const makeChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
      ) => ({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

      const makeUsageChunk = () => {
        const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
        return {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [],
          usage: { prompt_tokens, completion_tokens, total_tokens },
        };
      };

      const state = createStreamState();
      const tagFilter = createThinkingTagFilter();

      let mcpExecReceived = false;

      const parser = createConnectFrameParser(
        (messageBytes) => {
          try {
            const serverMessage = fromBinary(
              AgentServerMessageSchema,
              messageBytes,
            );
            processServerMessage(
              serverMessage,
              blobStore,
              mcpTools,
              cloudRule,
              (data) => bridge.write(frameConnectMessage(data)),
              state,
              (text, isThinking) => {
                if (isThinking) {
                  sendSSE(makeChunk({ reasoning_content: text }));
                } else {
                  const { content, reasoning } = tagFilter.process(text);
                  if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
                  if (content) sendSSE(makeChunk({ content }));
                }
              },
              // onMcpExec — the model wants to execute a tool.
              (exec) => {
                state.pendingExecs.push(exec);
                mcpExecReceived = true;

                const flushed = tagFilter.flush();
                if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
                if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));

                const toolCallIndex = state.toolCallIndex++;
                sendSSE(makeChunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    id: exec.toolCallId,
                    type: "function",
                    function: {
                      name: exec.toolName,
                      arguments: exec.decodedArgs,
                    },
                  }],
                }));

                // Keep the bridge alive for tool result continuation.
                activeBridges.set(bridgeKey, {
                  bridge,
                  heartbeatTimer,
                  blobStore,
                  mcpTools,
                  cloudRule,
                  pendingExecs: state.pendingExecs,
                });

                sendSSE(makeChunk({}, "tool_calls"));
                sendDone();
                closeController();
              },
              (checkpointBytes) => {
                const stored = conversationStates.get(convKey);
                if (stored) {
                  stored.checkpoint = checkpointBytes;
                  // Merge live blobs before persisting: the checkpoint may
                  // reference blobs set during this stream.
                  for (const [k, v] of blobStore) stored.blobStore.set(k, v);
                  stored.lastAccessMs = Date.now();
                  persistConversation(convKey, stored);
                }
              },
            );
          } catch {
            // Skip unparseable messages
          }
        },
        (endStreamBytes) => {
          const endError = parseConnectEndStream(endStreamBytes);
          if (process.env.CURSOR_PROXY_DEBUG) {
            console.error(`[proxy] endStream: ${endError ? endError.message : "clean"}`);
          }
          if (endError) {
            // Surface the error and shut down: the server is done with this
            // stream, and heartbeats would otherwise keep the bridge (and the
            // SSE response) open forever.
            sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }));
            sendSSE(makeChunk({}, "stop"));
            sendSSE(makeUsageChunk());
            sendDone();
            stopBridge();
            closeController();
          }
        },
      );

      bridge.onData((chunk) => parser.push(chunk));

      bridge.onClose((code) => {
        clearInterval(heartbeatTimer);
        const stored = conversationStates.get(convKey);
        if (stored) {
          for (const [k, v] of blobStore) stored.blobStore.set(k, v);
          stored.lastAccessMs = Date.now();
          persistConversation(convKey, stored);
        }
        if (!mcpExecReceived) {
          const flushed = tagFilter.flush();
          if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
          if (flushed.content) sendSSE(makeChunk({ content: flushed.content }));
          sendSSE(makeChunk({}, "stop"));
          sendSSE(makeUsageChunk());
          sendDone();
          closeController();
        } else if (code !== 0) {
          // Bridge died while tool calls are pending (timeout, crash, etc.).
          // Close the SSE stream so the client doesn't hang forever.
          sendSSE(makeChunk({ content: "\n[Error: bridge connection lost]" }));
          sendSSE(makeChunk({}, "stop"));
          sendSSE(makeUsageChunk());
          sendDone();
          closeController();
          // Remove stale entry so the next request doesn't try to resume it.
          // A delayed exit from an old bridge must not evict a newer one.
          if (activeBridges.get(bridgeKey)?.bridge === bridge) {
            activeBridges.delete(bridgeKey);
          }
        }
      });
    },
    cancel() {
      cancelStream?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

/** Spawn a bridge, send the initial request frame, and start heartbeat. */
function startBridge(
  accessToken: string,
  requestBytes: Uint8Array,
): { bridge: ReturnType<typeof spawnBridge>; heartbeatTimer: NodeJS.Timeout } {
  const bridge = spawnBridge({
    accessToken,
    rpcPath: "/agent.v1.AgentService/Run",
  });
  bridge.write(frameConnectMessage(requestBytes));
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
): Response | Promise<Response> {
  if (proxyDisableHttp2) {
    return handleHttp1StreamingResponse(payload, accessToken, modelId, bridgeKey, convKey);
  }
  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    payload.blobStore, payload.mcpTools, payload.cloudRule,
    modelId, bridgeKey, convKey,
  );
}

/** Resume a paused bridge by sending MCP results and continuing to stream. */
function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  userText: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
): Response {
  const { bridge, heartbeatTimer, blobStore, mcpTools, cloudRule, pendingExecs } = active;

  // Answer each pending exec with a matching tool result: redirected native
  // execs get their typed native result frame, MCP execs get an mcpResult.
  const lastExecId = pendingExecs[pendingExecs.length - 1]?.execId;
  for (const exec of pendingExecs) {
    const result = toolResults.find(
      (r) => r.toolCallId === exec.toolCallId,
    );
    // A user message sent alongside tool results (e.g. the explanation typed
    // after rejecting an edit) would otherwise be dropped: the paused bridge
    // only accepts tool results. Attach it to the last result so the model
    // sees it (issue #23).
    let text = result ? result.content : "Tool result not provided";
    if (userText && exec.execId === lastExecId) {
      text += `\n\n<user_message>\n${userText}\n</user_message>`;
    }

    if (result && exec.native) {
      const sent = sendNativeExecResult(exec, exec.native, text, (bytes) =>
        bridge.write(frameConnectMessage(bytes)),
      );
      if (sent) continue;
    }

    const mcpResult = result
      ? create(McpResultSchema, {
          result: {
            case: "success",
            value: create(McpSuccessSchema, {
              content: [
                create(McpToolResultContentItemSchema, {
                  content: {
                    case: "text",
                    value: create(McpTextContentSchema, { text }),
                  },
                }),
              ],
              isError: false,
            }),
          },
        })
      : create(McpResultSchema, {
          result: {
            case: "error",
            value: create(McpErrorSchema, { error: text }),
          },
        });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: {
        case: "mcpResult" as never,
        value: mcpResult as never,
      },
    });

    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });

    bridge.write(
      frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)),
    );
  }

  return createBridgeStreamResponse(
    bridge, heartbeatTimer,
    blobStore, mcpTools, cloudRule,
    modelId, bridgeKey, convKey,
  );
}

async function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  let collected: CollectedResponse;
  if (proxyDisableHttp2) {
    try {
      collected = await collectFullResponseHttp1(payload, accessToken, convKey);
    } catch (err) {
      // Same shape as the proxy's other server errors.
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: { message, type: "server_error", code: "internal_error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  } else {
    collected = await collectFullResponse(payload, accessToken, convKey);
  }
  const { text, usage } = collected;
  return new Response(JSON.stringify({ id: completionId, object: "chat.completion", created, model: modelId, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }), { headers: { "Content-Type": "application/json" } });
}

async function collectFullResponseHttp1(
  payload: CursorRequestPayload,
  accessToken: string,
  convKey: string,
): Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>();
  let fullText = "";
  const requestId = crypto.randomUUID();
  let channelError: Error | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const http1 = createHttp1ClientChannel(accessToken, requestId, (err) => {
    channelError ??= err;
    void reader?.cancel(err).catch(() => {});
  });
  const sendFrame = http1.sendFrame;
  const abort = new AbortController();
  const teardown = () => {
    http1.stop();
    abort.abort();
    activeHttp1Streams.delete(teardown);
  };
  activeHttp1Streams.add(teardown);
  let response: Response;
  try {
    response = await callCursor(accessToken, "/agent.v1.AgentService/Run", payload.requestBytes, { requestId, signal: abort.signal });
    await http1.sendInitial(payload.requestBytes);
  } catch (err) {
    teardown();
    throw err;
  }
  http1.startHeartbeat();
  const state = createStreamState();
  const tagFilter = createThinkingTagFilter();
  const bodyReader = response.body!.getReader();
  reader = bodyReader;
  const parser = createResponseBodyParser(
    response.headers.get("content-type"),
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
        processServerMessage(serverMessage, payload.blobStore, payload.mcpTools, payload.cloudRule, sendFrame, state, (text, isThinking) => { if (isThinking) return; const { content } = tagFilter.process(text); fullText += content; }, () => {}, (checkpointBytes) => { const stored = conversationStates.get(convKey); if (stored) { stored.checkpoint = checkpointBytes; for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v); stored.lastAccessMs = Date.now(); persistConversation(convKey, stored); } },
      ); } catch { /* Skip */ }
    },
    () => {},
  );
  const pump = async (): Promise<void> => {
    let failure: unknown;
    try {
      while (true) { const { done, value } = await bodyReader.read(); if (done) break; parser.push(value); }
      if (channelError) throw channelError;
      parser.flush();
    }
    catch (e) { failure = e; }
    finally { teardown(); }
    const stored = conversationStates.get(convKey);
    if (stored) { for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v); stored.lastAccessMs = Date.now(); persistConversation(convKey, stored); }
    if (failure) {
      reject(failure instanceof Error ? failure : new Error(String(failure)));
      return;
    }
    const flushed = tagFilter.flush(); fullText += flushed.content;
    resolve({ text: fullText, usage: computeUsage(state) });
  };
  void pump();
  return promise;
}

function toolCallIdParts(id: string): string[] {
  return id.split(/[\s\n]+/).map((part) => part.trim()).filter(Boolean);
}

export function settlePendingToolCalls(
  pending: readonly string[],
  toolResults: readonly { toolCallId: string }[],
): string[] {
  if (pending.length === 0 || toolResults.length === 0) return [...pending];
  const settledIds = new Set(toolResults.flatMap((result) => toolCallIdParts(result.toolCallId)));
  const isSettled = (toolCallId: string) => toolCallIdParts(toolCallId).some((part) => settledIds.has(part));
  const next: string[] = [];
  for (const raw of pending) {
    let parsed: {
      content?: Array<{ type?: string; toolCallId?: string }>;
      providerOptions?: { cursor?: { pendingToolExecutionContracts?: Record<string, unknown> } };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      next.push(raw);
      continue;
    }
    if (!Array.isArray(parsed.content)) {
      next.push(raw);
      continue;
    }
    const content = parsed.content.filter((part) => part?.type !== "tool-call" || !isSettled(String(part.toolCallId ?? "")));
    if (content.length === parsed.content.length) {
      next.push(raw);
      continue;
    }
    if (!content.some((part) => part?.type === "tool-call")) continue;
    const contracts = parsed.providerOptions?.cursor?.pendingToolExecutionContracts;
    if (contracts) {
      for (const key of Object.keys(contracts)) {
        if (isSettled(key)) delete contracts[key];
      }
    }
    next.push(JSON.stringify({ ...parsed, content }));
  }
  return next;
}

function buildCursorRequest(
  modelId: string, systemPrompts: string[], userText: string,
  history: { kind: string; text: string }[], conversationId: string,
  checkpoint: Uint8Array | null, existingBlobStore?: Map<string, Uint8Array>,
  toolResults?: { toolCallId: string; content: string }[],
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);
  const storeBlob = (bytes: Uint8Array): Uint8Array => {
    const blobId = new Uint8Array(createHash("sha256").update(bytes).digest());
    blobStore.set(Buffer.from(blobId).toString("hex"), bytes);
    return blobId;
  };
  const storeJsonBlob = (obj: unknown): Uint8Array => storeBlob(new TextEncoder().encode(JSON.stringify(obj)));
  const prompts = systemPrompts.length > 0 ? systemPrompts : ["You are a helpful assistant."];
  const systemBlobIds = prompts.map((content) => storeJsonBlob({ role: "system", content }));
  const rootPromptMessagesJson = [...systemBlobIds];
  for (const entry of history) {
    if (entry.kind === "assistant") { rootPromptMessagesJson.push(storeJsonBlob({ role: "assistant", content: [{ type: "text", text: entry.text }] })); }
    else { const text = entry.kind === "tool" ? `[Tool Result]\n${entry.text}` : entry.text; rootPromptMessagesJson.push(storeJsonBlob({ role: "user", content: [{ type: "text", text }] })); }
  }
  const turnBlobIds: Uint8Array[] = [];
  let currentTurn: { userMessageBlobId: Uint8Array; stepBlobIds: Uint8Array[] } | null = null;
  const flushTurn = () => {
    if (!currentTurn) return;
    const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: currentTurn.userMessageBlobId, steps: currentTurn.stepBlobIds });
    const turnStructure = create(ConversationTurnStructureSchema, { turn: { case: "agentConversationTurn", value: agentTurn } });
    turnBlobIds.push(storeBlob(toBinary(ConversationTurnStructureSchema, turnStructure)));
    currentTurn = null;
  };
  for (const entry of history) {
    if (entry.kind === "user") {
      flushTurn();
      const userMsg = create(UserMessageSchema, { text: entry.text, messageId: deterministicUuid(`u:${turnBlobIds.length}:${entry.text}`) });
      currentTurn = { userMessageBlobId: storeBlob(toBinary(UserMessageSchema, userMsg)), stepBlobIds: [] };
    } else if (currentTurn) {
      const text = entry.kind === "tool" ? `[Tool Result]\n${entry.text}` : entry.text;
      const step = create(ConversationStepSchema, { message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text }) } });
      currentTurn.stepBlobIds.push(storeBlob(toBinary(ConversationStepSchema, step)));
    }
  }
  flushTurn();
  let baseState: ConversationStateStructure | null = null;
  if (checkpoint) {
    try {
      const decoded = fromBinary(ConversationStateStructureSchema, checkpoint);
      const head = decoded.rootPromptMessagesJson.slice(0, systemBlobIds.length);
      const matches = head.length === systemBlobIds.length && systemBlobIds.every((id, idx) => Buffer.from(head[idx]!).equals(Buffer.from(id)));
      if (matches) baseState = decoded;
    } catch {}
  }
  const pendingToolCalls = baseState
    ? settlePendingToolCalls(baseState.pendingToolCalls, toolResults ?? [])
    : [];
  const conversationState = baseState ? create(ConversationStateStructureSchema, { ...baseState, rootPromptMessagesJson, turns: turnBlobIds, pendingToolCalls }) : create(ConversationStateStructureSchema, { rootPromptMessagesJson, turns: turnBlobIds, todos: [], pendingToolCalls: [], previousWorkspaceUris: [], fileStates: {}, fileStatesV2: {}, summaryArchives: [], turnTimings: [], subagentStates: {}, selfSummaryCount: 0, readPaths: [] });
  const hasToolResults = toolResults && toolResults.length > 0;
  const action = hasToolResults
    ? create(ConversationActionSchema, { action: { case: "resumeAction" as const, value: create(ResumeActionSchema, {}) } })
    : userText
      ? create(ConversationActionSchema, { action: { case: "userMessageAction" as const, value: create(UserMessageActionSchema, { userMessage: create(UserMessageSchema, { text: userText, messageId: crypto.randomUUID() }) }) } })
      : create(ConversationActionSchema, { action: { case: "resumeAction" as const, value: create(ResumeActionSchema, {}) } });
  const cursorModelId = modelId === "auto" ? "default" : modelId;
  const displayName = modelId === "auto" ? "Auto" : modelId;
  const requestedModel = create(RequestedModelSchema, { modelId: cursorModelId });
  const modelDetails = create(ModelDetailsSchema, { modelId: cursorModelId, displayModelId: cursorModelId, displayName, displayNameShort: displayName });
  const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, requestedModel, conversationId });
  const clientMessage = create(AgentClientMessageSchema, { message: { case: "runRequest", value: runRequest } });
  return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [], cloudRule: prompts.join("\n\n").trim() || undefined };
}

function parseMessages(messages: OpenAIMessage[]): { systemPrompts: string[]; userText: string; history: { kind: string; text: string }[]; toolResults: { toolCallId: string; content: string }[] } {
  const systemPrompts = messages.filter((m) => m.role === "system").map((m) => textContent(m.content)).filter((text) => text.length > 0);
  const toolResults: { toolCallId: string; content: string }[] = [];
  const history: { kind: string; text: string }[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const content = textContent(msg.content);
      toolResults.push({ toolCallId: msg.tool_call_id ?? "", content });
      if (content) history.push({ kind: "tool", text: content });
    } else if (msg.role === "user") { history.push({ kind: "user", text: textContent(msg.content) }); }
    else if (msg.role === "assistant") { const text = textContent(msg.content); if (text) history.push({ kind: "assistant", text }); }
  }
  let userText = "";
  const last = history[history.length - 1];
  if (last?.kind === "user") { userText = last.text; history.pop(); }
  return { systemPrompts, userText, history, toolResults };
}

interface CollectedResponse {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function collectFullResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  convKey: string,
): Promise<CollectedResponse> {
  const { promise, resolve } = Promise.withResolvers<CollectedResponse>();
  let fullText = "";

  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);

  const state = createStreamState();
  const tagFilter = createThinkingTagFilter();

  const parser = createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(
          AgentServerMessageSchema,
          messageBytes,
        );
        processServerMessage(
          serverMessage,
          payload.blobStore,
          payload.mcpTools,
          payload.cloudRule,
          (data) => bridge.write(frameConnectMessage(data)),
          state,
          (text, isThinking) => {
            if (isThinking) return;
            const { content } = tagFilter.process(text);
            fullText += content;
          },
          () => {},
          (checkpointBytes) => {
            const stored = conversationStates.get(convKey);
            if (stored) {
              stored.checkpoint = checkpointBytes;
              for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
              stored.lastAccessMs = Date.now();
              persistConversation(convKey, stored);
            }
          },
        );
      } catch {
        // Skip
      }
    },
    () => {},
  );
  bridge.onData((chunk) => parser.push(chunk));

  bridge.onClose(() => {
    clearInterval(heartbeatTimer);
    const stored = conversationStates.get(convKey);
    if (stored) {
      for (const [k, v] of payload.blobStore) stored.blobStore.set(k, v);
      stored.lastAccessMs = Date.now();
      persistConversation(convKey, stored);
    }
    const flushed = tagFilter.flush();
    fullText += flushed.content;

    const usage = computeUsage(state);
    resolve({
      text: fullText,
      usage,
    });
  });

  return promise;
}
