import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import http2 from "node:http2";
import net, { type AddressInfo } from "node:net";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  BidiRequestIdSchema,
  ClientHeartbeatSchema,
  ExecServerMessageSchema,
  GetUsableModelsResponseSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";
import { Credential, Integration } from "@opencode/plugin";
import type CursorV2PluginModule from "../src/v2";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  refreshCursorToken: typeof import("../src/auth").refreshCursorToken;
  CursorV2Plugin: typeof CursorV2PluginModule;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

type V2Context = Parameters<TestModules["CursorV2Plugin"]["setup"]>[0];
type IntegrationTransform = Parameters<
  V2Context["integration"]["transform"]
>[0];
type IntegrationDraft = Parameters<IntegrationTransform>[0];
type IntegrationMethod = Parameters<IntegrationDraft["method"]["update"]>[0];
type ProviderTransform = Parameters<V2Context["provider"]["transform"]>[0];
type ProviderDraft = Parameters<ProviderTransform>[0];
type ProviderInfo = Parameters<ProviderDraft["add"]>[0]["info"];

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  setHoldRunStream: (hold: boolean) => void;
  /** While holding, also emit an MCP tool call with this id; the stream answers the tool result and ends. */
  setRunStreamToolCall: (toolCallId: string | undefined) => void;
  getOpenRunStreamCount: () => number;
  /** Refuse connections of the other protocol, like a network that blocks HTTP/2. */
  setAllowedTransport: (transport: "both" | "h1" | "h2") => void;
  /** One `h1 <path>` / `h2 <path>` entry per request that reached the backend. */
  getRequests: () => string[];
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  waitForRunStreamClose: () => Promise<void>;
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** A Connect-framed text delta, enough to make the proxy emit its first SSE chunk. */
function frameRunTextDelta(text: string): Buffer {
  return frameConnectUnaryMessage(
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: {
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, {
            message: { case: "textDelta", value: { text } },
          }),
        },
      }),
    ),
  );
}

/** A Connect-framed MCP tool call, which makes the proxy pause the stream for a tool result. */
function frameRunToolCall(toolCallId: string): Buffer {
  return frameConnectUnaryMessage(
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 1,
            execId: "exec-1",
            message: {
              case: "mcpArgs",
              value: create(McpArgsSchema, { name: "echo", toolName: "echo", toolCallId }),
            },
          }),
        },
      }),
    ),
  );
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  let runStreamClosed = Promise.withResolvers<void>();
  const heldRunStreams = new Set<http2.ServerHttp2Stream>();
  const heldHttp1Responses = new Set<http.ServerResponse>();
  let holdRunStream = false;
  let runStreamToolCallId: string | undefined;
  const refreshAuthHeaders: string[] = [];
  const requests: string[] = [];
  let allowedTransport: "both" | "h1" | "h2" = "both";

  const discoveryProto = () =>
    toBinary(
      GetUsableModelsResponseSchema,
      create(GetUsableModelsResponseSchema, {
        models: discoveredModels.map((model) =>
          create(ModelDetailsSchema, {
            modelId: model.id,
            displayModelId: model.id,
            displayName: model.name,
            displayNameShort: model.name,
            aliases: [],
          }),
        ),
      }),
    );

  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  // HTTP/1.1 twin of the h2 handler below: the transport the fallback uses.
  const http1Server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(`h1 ${path}`);
    const authHeader = req.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));
        if (discoveryMode === "auth-error" || authHeader === "Bearer expired-access") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "unauthenticated", message: "expired token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/proto" });
        res.end(discoveryMode === "empty" ? Buffer.alloc(0) : Buffer.from(discoveryProto()));
        return;
      }
      if (path === "/agent.v1.AgentService/RunSSE") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (holdRunStream) {
          const closed = runStreamClosed;
          heldHttp1Responses.add(res);
          res.on("close", () => {
            heldHttp1Responses.delete(res);
            closed.resolve();
          });
          res.write(frameRunTextDelta("streaming"));
          return;
        }
        res.end(frameRunTextDelta("from-http1"));
        return;
      }
      if (path === "/aiserver.v1.BidiService/BidiAppend") {
        res.writeHead(200, { "Content-Type": "application/proto" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  const http2Server = http2.createServer();
  http2Server.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    requests.push(`h2 ${path}`);
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      const closed = runStreamClosed;
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.on("close", () => {
        heldRunStreams.delete(stream);
        closed.resolve();
      });
      if (holdRunStream) {
        // Cancellation can only be observed on a stream still running when the
        // client goes away. Bun also withholds SSE response headers until the
        // first body byte, so emit one to unblock the caller's fetch.
        heldRunStreams.add(stream);
        stream.write(frameRunTextDelta("streaming"));
        if (runStreamToolCallId) {
          stream.write(frameRunToolCall(runStreamToolCallId));
          // Answer the tool result (and only that; heartbeats are ignored) to
          // prove the continuation reached this very stream.
          let pending = Buffer.alloc(0);
          stream.on("data", (chunk) => {
            pending = Buffer.concat([pending, Buffer.from(chunk)]);
            while (pending.length >= 5) {
              const len = pending.readUInt32BE(1);
              if (pending.length < 5 + len) break;
              const message = fromBinary(AgentClientMessageSchema, pending.subarray(5, 5 + len));
              pending = pending.subarray(5 + len);
              if (message.message.case === "execClientMessage") {
                stream.write(frameRunTextDelta("after-tool"));
                stream.end();
              }
            }
          });
        }
      } else {
        stream.end();
      }
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (
          discoveryMode === "auth-error" ||
          authHeader === "Bearer expired-access"
        ) {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(discoveryProto());
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  // One port serves both protocols: cleartext HTTP/2 starts with the "PRI " preface.
  const sockets = new Set<net.Socket>();
  const apiServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (first) => {
      socket.pause();
      socket.unshift(first);
      const isH2 = first.toString("latin1", 0, 4) === "PRI ";
      if (allowedTransport !== "both" && allowedTransport !== (isH2 ? "h2" : "h1")) {
        socket.destroy();
        return;
      }
      (isH2 ? http2Server : http1Server).emit("connection", socket);
      socket.resume();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    setHoldRunStream(hold) {
      holdRunStream = hold;
      if (!hold) {
        for (const stream of heldRunStreams) stream.close();
        for (const res of heldHttp1Responses) res.end();
      }
    },
    setRunStreamToolCall(toolCallId) {
      runStreamToolCallId = toolCallId;
    },
    getOpenRunStreamCount() {
      return heldRunStreams.size + heldHttp1Responses.size;
    },
    setAllowedTransport(transport) {
      allowedTransport = transport;
    },
    getRequests() {
      return [...requests];
    },
    resetObservations() {
      requests.length = 0;
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
      runStreamClosed = Promise.withResolvers<void>();
    },
    waitForRunStreamClose() {
      return runStreamClosed.promise;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  // These imports must run after the test sets the Cursor endpoint environment variables.
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const v2 = await import("../src/v2");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    refreshCursorToken: auth.refreshCursorToken,
    CursorV2Plugin: v2.default,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testStreamCancellationStopsBridge(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing SSE cancellation teardown...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  const controller = new AbortController();
  try {
    const port = await modules.startProxy(async () => "test-token");
    const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }
    assertEqual(res.status, 200, "Expected a streaming response");

    controller.abort();
    // The bridge subprocess holds the only handle on this Run stream, so its
    // closure proves the subprocess was killed.
    await withTimeout(
      backend.waitForRunStreamClose(),
      "the Cursor Run stream to close after the client disconnects",
    );
  } finally {
    controller.abort();
    modules.stopProxy();
    backend.setHoldRunStream(false);
  }
  console.log("[test] SSE cancellation teardown OK");
}

async function testHttp1StreamCancellationAndStop(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing HTTP/1.1 stream teardown on cancel and stopProxy...");
  for (const how of ["cancel", "stopProxy"] as const) {
    backend.resetObservations();
    backend.setHoldRunStream(true);
    const controller = new AbortController();
    try {
      const port = await modules.startProxy(async () => "test-token", [], true);
      const res = await postChat(
        port,
        [{ role: "user", content: `hello ${how}` }],
        controller.signal,
      );
      assertEqual(res.status, 200, "Expected a streaming response");
      await waitFor(
        () => backend.getOpenRunStreamCount() === 1,
        "the HTTP/1.1 RunSSE stream to open",
      );
      if (how === "cancel") controller.abort();
      else modules.stopProxy();
      await withTimeout(
        backend.waitForRunStreamClose(),
        `the HTTP/1.1 RunSSE stream to close after ${how}`,
      );
      // Teardown also ends the BidiAppend heartbeat.
      await Bun.sleep(50);
      const appends = backend.getRequests().filter((r) => r.endsWith("/BidiAppend")).length;
      await Bun.sleep(300);
      assertEqual(
        backend.getRequests().filter((r) => r.endsWith("/BidiAppend")).length,
        appends,
        `Expected no BidiAppend after ${how}`,
      );
    } finally {
      controller.abort();
      modules.stopProxy();
      backend.setHoldRunStream(false);
    }
  }
  console.log("[test] HTTP/1.1 stream teardown OK");
}

/** A plugin installed under a path with a space and a non-ASCII character must still find its bridge. */
async function testBridgeResolvesUnderOddInstallPath(backend: TestCursorBackend) {
  console.log("[test] Testing HTTP/2 bridge under a path with spaces and non-ASCII...");
  const root = mkdtempSync(join(tmpdir(), "cursor-bridge-"));
  try {
    const installDir = join(root, "Application Support ñ", "plugin");
    mkdirSync(installDir, { recursive: true });
    cpSync(resolve(import.meta.dir, "../src"), join(installDir, "src"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"));
    writeFileSync(
      join(installDir, "run.ts"),
      `import { getCursorModels } from "./src/models";
console.log(JSON.stringify((await getCursorModels("test-token", false)).map((m) => m.id)));
process.exit(0);
`,
    );
    backend.resetObservations();
    backend.setDiscoveryMode("success");
    backend.setDiscoveredModels([{ id: "odd-path-model", name: "Odd Path Model" }]);
    backend.setAllowedTransport("h2");
    const child = Bun.spawn([process.execPath, join(installDir, "run.ts")], {
      env: { ...process.env, CURSOR_API_URL: process.env.CURSOR_API_URL! },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assertArrayEqual(
      JSON.parse(out.trim().split("\n").pop() ?? "[]").sort(),
      ["auto", "odd-path-model"],
      `Expected HTTP/2 discovery from the odd install path, not the fallback list (stderr: ${err})`,
    );
  } finally {
    backend.setAllowedTransport("both");
    rmSync(root, { recursive: true, force: true });
  }
  console.log("[test] Bridge path under odd install dir OK");
}

async function waitFor(condition: () => boolean, message: string) {
  await withTimeout(
    (async () => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 20));
    })(),
    message,
  );
}

function postChat(port: number, messages: unknown[], signal: AbortSignal) {
  return fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "composer-2", stream: true, messages }),
    signal,
  });
}

/** Read an SSE response until [DONE]; the stream is paused for a tool call by then. */
async function readUntilDone(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("[DONE]")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const toolCallMessages = (toolCallId: string, withResult: boolean) => [
  { role: "user", content: "run a tool" },
  ...(withResult
    ? [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: toolCallId, type: "function", function: { name: "echo", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: toolCallId, content: "tool output" },
      ]
    : []),
];

async function testCancelPausedBridgeKeepsBridge(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing client disconnect on a paused bridge...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  backend.setRunStreamToolCall("call-paused");
  const first = new AbortController();
  const second = new AbortController();
  try {
    const port = await modules.startProxy(async () => "test-token");
    const res = await postChat(port, toolCallMessages("call-paused", false), first.signal);
    const paused = await readUntilDone(res);
    assert(paused.includes("call-paused"), `Expected the tool call in the stream, got: ${paused}`);

    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEqual(backend.getOpenRunStreamCount(), 1, "Paused bridge must survive the disconnect");

    const resumed = await postChat(port, toolCallMessages("call-paused", true), second.signal);
    assertEqual(resumed.status, 200, "Expected the continuation to succeed");
    const body = await withTimeout(resumed.text(), "the continuation response to finish");
    assert(body.includes("after-tool"), `Expected the tool result to reach the same stream, got: ${body}`);
  } finally {
    first.abort();
    second.abort();
    modules.stopProxy();
    backend.setRunStreamToolCall(undefined);
    backend.setHoldRunStream(false);
  }
  console.log("[test] Paused bridge disconnect OK");
}

async function testStopProxyClearsPausedBridges(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing stopProxy with a paused bridge...");
  backend.resetObservations();
  backend.setHoldRunStream(true);
  backend.setRunStreamToolCall("call-reused");
  const controller = new AbortController();
  try {
    let port = await modules.startProxy(async () => "test-token");
    const first = await readUntilDone(
      await postChat(port, toolCallMessages("call-reused", false), controller.signal),
    );
    assert(first.includes("call-reused"), `Expected the tool call, got: ${first}`);
    assertEqual(backend.getOpenRunStreamCount(), 1, "Expected one paused bridge");

    modules.stopProxy();
    await withTimeout(
      backend.waitForRunStreamClose(),
      "the paused bridge to be killed by stopProxy",
    );

    port = await modules.startProxy(async () => "test-token");
    const again = await readUntilDone(
      await postChat(port, toolCallMessages("call-reused", false), controller.signal),
    );
    assert(again.includes("call-reused"), `Expected the reused tool-call id to be accepted, got: ${again}`);
  } finally {
    controller.abort();
    modules.stopProxy();
    backend.setRunStreamToolCall(undefined);
    backend.setHoldRunStream(false);
  }
  console.log("[test] stopProxy paused bridge cleanup OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testV2Plugin(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Checking V2 plugin...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "v2-model", name: "V2 Model", reasoning: true },
  ]);

  let integrationTransform: IntegrationTransform | undefined;
  let providerTransform: ProviderTransform | undefined;
  let authMethod: IntegrationMethod | undefined;
  let integrationName: string | undefined;
  let providerInfo: ProviderInfo | undefined;
  let providerReloads = 0;
  const modelIDs: string[] = [];

  const integration = { id: "cursor", name: "cursor" };
  const integrationDraft: IntegrationDraft = {
    list() {
      return [integration];
    },
    get(id) {
      return id === integration.id ? integration : undefined;
    },
    update(id, update) {
      assertEqual(id, integration.id, "Expected Cursor integration update");
      update(integration);
      integrationName = integration.name;
    },
    remove() {},
    method: {
      list() {
        return [];
      },
      update(method) {
        authMethod = method;
      },
      remove() {},
    },
  };

  const providerDraft: ProviderDraft = {
    list() {
      return [];
    },
    get() {
      return undefined;
    },
    add(input) {
      providerInfo = input.info;
      for (const model of input.models) modelIDs.push(model.id);
    },
    update() {},
    remove() {},
    models: {
      set() {},
      update() {},
      remove() {},
    },
  };

  let markReload: (() => void) | undefined;
  let failReload = false;
  function waitForReload(): Promise<void> {
    const pending = Promise.withResolvers<void>();
    markReload = pending.resolve;
    return Promise.race([
      pending.promise,
      Bun.sleep(500).then(() => {
        throw new Error("Expected V2 provider reload");
      }),
    ]);
  }
  let connected = true;
  let credential = Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("cursor-oauth"),
    refresh: "valid-refresh",
    access: "expired-access",
    expires: Date.now() - 1,
  });
  type TestEvent =
    | { id: string; created: number; type: "credential.updated"; data: {} }
    | {
        id: string;
        created: number;
        type: "credential.switched";
        data: { integrationID: string; credentialID: string | null };
      };
  const credentialUpdated: TestEvent = {
    id: "credential-updated",
    created: Date.now(),
    type: "credential.updated",
    data: {},
  };
  function credentialSwitched(integrationID: string): TestEvent {
    return {
      id: `credential-switched-${integrationID}`,
      created: Date.now(),
      type: "credential.switched",
      data: { integrationID, credentialID: null },
    };
  }
  let eventClosed = false;
  const eventQueue: TestEvent[] = [];
  let sendEvent: ((result: IteratorResult<TestEvent>) => void) | undefined;
  function emit(event: TestEvent): void {
    if (sendEvent) {
      const send = sendEvent;
      sendEvent = undefined;
      send({ done: false, value: event });
      return;
    }
    eventQueue.push(event);
  }
  const eventStream = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TestEvent>> {
          if (eventClosed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const event = eventQueue.shift();
          if (event) {
            return Promise.resolve({ done: false, value: event });
          }
          return new Promise((resolve) => {
            sendEvent = resolve;
          });
        },
        return(): Promise<IteratorResult<TestEvent>> {
          eventClosed = true;
          sendEvent?.({ done: true, value: undefined });
          sendEvent = undefined;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const context = {
    options: {},
    integration: {
      async transform(transform: IntegrationTransform) {
        integrationTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        assert(integrationTransform, "Expected V2 integration transform");
        integrationTransform(integrationDraft);
      },
      connection: {
        async active() {
          if (!connected) return undefined;
          return {
            type: "credential" as const,
            id: "cursor-test",
            label: "Cursor",
          };
        },
        async resolve() {
          if (
            credential.expires <= Date.now() + 5 * 60 * 1000 &&
            authMethod &&
            "refresh" in authMethod &&
            authMethod.refresh
          ) {
            credential = await authMethod.refresh(credential);
          }
          return credential;
        },
      },
    },
    provider: {
      async transform(transform: ProviderTransform) {
        providerTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        providerReloads++;
        modelIDs.length = 0;
        assert(providerTransform, "Expected V2 provider transform");
        providerTransform(providerDraft);
        markReload?.();
        markReload = undefined;
        if (failReload) {
          failReload = false;
          throw new Error("Injected provider reload failure");
        }
      },
    },
    event: {
      subscribe() {
        return eventStream;
      },
    },
  };

  // SAFETY: The plugin only reads the integration, provider, and event domains
  // supplied by this public-entrypoint harness.
  const cleanup = await modules.CursorV2Plugin.setup(
    context as unknown as V2Context,
  );
  assert(integrationTransform, "Expected V2 integration transform");
  failReload = true;
  const failedReload = waitForReload();
  emit(credentialUpdated);
  await failedReload;

  const retry = waitForReload();
  emit(credentialSwitched("cursor"));
  await retry;

  const reloadsBeforeOther = providerReloads;
  emit(credentialSwitched("other"));
  await Bun.sleep(50);
  assertEqual(
    providerReloads,
    reloadsBeforeOther,
    "Expected credential.switched for another integration to be ignored",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected V2 startup to refresh an expired credential",
  );
  const discoveryHeaders = backend.getDiscoveryAuthHeaders();
  assert(
    discoveryHeaders.length > 0 &&
      discoveryHeaders.every((header) => header !== "Bearer expired-access"),
    `Expected V2 discovery to use refreshed auth, got ${JSON.stringify(discoveryHeaders)}`,
  );

  assertEqual(
    modules.CursorV2Plugin.id,
    "opencode.cursor-oauth",
    "Expected stable V2 plugin ID",
  );
  assertEqual(integrationName, "Cursor", "Expected Cursor integration name");
  assert(
    authMethod && "authorize" in authMethod,
    "Expected Cursor OAuth method",
  );
  assertEqual(authMethod.method.type, "oauth", "Expected OAuth method type");
  assert(providerInfo, "Expected V2 provider info");
  assertEqual(
    providerInfo.integrationID,
    "cursor",
    "Expected Cursor provider integration",
  );
  assertEqual(
    providerInfo.package,
    "@opencode/ai/providers/openai-compatible",
    "Expected V2 OpenAI-compatible provider",
  );
  const providerBaseURL = providerInfo.settings?.baseURL;
  assertEqual(
    providerBaseURL,
    `http://localhost:${modules.getProxyPort()}/v1`,
    "Expected V2 provider base URL to point at the local proxy",
  );
  assertArrayEqual(
    modelIDs.sort(),
    ["auto", "v2-model"],
    "Expected V2 provider models",
  );

  const modelsResponse = await fetch(`${providerBaseURL}/models`);
  assertEqual(modelsResponse.status, 200, "Expected V2 proxy model list");
  const modelsBody = await modelsResponse.json();
  assertArrayEqual(
    modelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "v2-model"],
    "Expected V2 proxy models",
  );

  assert(authMethod.refresh, "Expected V2 OAuth refresh callback");
  backend.resetObservations();
  const refreshed = await authMethod.refresh(
    Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("cursor-oauth"),
      refresh: "valid-refresh",
      access: "expired",
      expires: Date.now() - 1,
    }),
  );
  assertEqual(
    refreshed.methodID,
    Integration.MethodID.make("cursor-oauth"),
    "Expected refreshed V2 credential method",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected V2 refresh token request",
  );

  connected = false;
  const stopped = waitForReload();
  emit(credentialUpdated);
  await stopped;
  assertEqual(
    modules.getProxyPort(),
    undefined,
    "Expected V2 disconnect to stop the proxy",
  );

  assert(typeof cleanup === "function", "Expected V2 cleanup");
  const cleanedUp = await Promise.race([
    cleanup().then(() => true),
    Bun.sleep(500).then(() => false),
  ]);
  assert(cleanedUp, "Expected V2 cleanup to finish");
  assert(eventClosed, "Expected V2 cleanup to close the event stream");
  assertEqual(
    modules.getProxyPort(),
    undefined,
    "Expected V2 cleanup to stop the proxy",
  );
  console.log("[test] V2 plugin OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  const refreshed = await modules.refreshCursorToken("valid-refresh");
  assert(
    refreshed.access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );

  const models = await modules.getCursorModels(refreshed.access);
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${refreshed.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assertArrayEqual(
    models.map((model) => model.id),
    ["auto", "fresh-model"],
    "Expected models to come from successful discovery",
  );

  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const accessToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const fallbackModels = await modules.getCursorModels(accessToken);
  assert(
    fallbackModels.length > 1 && fallbackModels.some((model) => model.id === "auto"),
    "Expected fallback models (plus auto) when discovery fails",
  );

  const fallbackPort = await modules.startProxy(async () => accessToken, fallbackModels);
  const fallbackRes = await fetch(`http://localhost:${fallbackPort}/v1/models`);
  assertEqual(fallbackRes.status, 200, "Expected degraded /v1/models to succeed");
  const fallbackBody = await fallbackRes.json();
  assertEqual(
    fallbackBody.data.length,
    fallbackModels.length,
    "Expected proxy /v1/models to expose fallback models",
  );
  modules.stopProxy();

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discovered = await modules.getCursorModels(accessToken);
  assertArrayEqual(
    discovered.map((model) => model.id).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected successful discovery to replace fallback models",
  );

  const discoveredPort = await modules.startProxy(async () => accessToken, discovered);
  const discoveredRes = await fetch(`http://localhost:${discoveredPort}/v1/models`);
  assertEqual(discoveredRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredBody = await discoveredRes.json();
  assertArrayEqual(
    discoveredBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected proxy /v1/models to expose discovered models",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}


async function testBridgeFraming() {
  console.log("[test] Testing bridge frame format...");
  
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = new Uint8Array(4 + payload.length);
  frame.set(new Uint8Array([
    (payload.length >> 24) & 0xff,
    (payload.length >> 16) & 0xff,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
  ]));
  frame.set(payload, 4);
  
  if (frame.length !== 9) {
    throw new Error(`Expected frame length 9, got ${frame.length}`);
  }
  const len = (frame[0] << 24) | (frame[1] << 16) | (frame[2] << 8) | frame[3];
  if (len !== 5) {
    throw new Error(`Expected length 5, got ${len}`);
  }
  for (let i = 0; i < 5; i++) {
    if (frame[4 + i] !== payload[i]) {
      throw new Error(`Payload mismatch at index ${i}`);
    }
  }
  
  console.log("[test] Bridge framing OK");
}

async function testStreamingFrameParser() {
  console.log("[test] Testing streaming frame parser...");
  
  const frame1 = Buffer.alloc(8);
  frame1[0] = 0;
  frame1.writeUInt32BE(3, 1);
  frame1.set([1, 2, 3], 5);
  
  const frame2 = Buffer.alloc(7);
  frame2[0] = 0;
  frame2.writeUInt32BE(2, 1);
  frame2.set([4, 5], 5);
  
  const combined = Buffer.concat([frame1, frame2]);
  
  const messages: Uint8Array[] = [];
  let endStreamCalled = false;
  
  let pending = Buffer.alloc(0);
  const parser = (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & 0b00000010) { endStreamCalled = true; }
      else { messages.push(new Uint8Array(messageBytes)); }
    }
  };
  
  parser(combined);
  
  if (messages.length !== 2) {
    throw new Error(`Expected 2 messages, got ${messages.length}`);
  }
  if (messages[0]!.length !== 3 || messages[1]!.length !== 2) {
    throw new Error("Message lengths incorrect");
  }
  
  console.log("[test] Streaming frame parser OK");
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string): void {
  if (Buffer.from(actual).equals(Buffer.from(expected))) return;
  throw new Error(
    `${message}: expected ${Buffer.from(expected).toString("hex")}, got ${Buffer.from(actual).toString("hex")}`,
  );
}

async function testHttp1WireFormat() {
  console.log("[test] Testing HTTP/1.1 wire format...");
  const {
    encodeConnectEnvelope,
    buildHttp1CursorRequest,
    encodeBidiAppendRequest,
    decodeBidiAppendRequest,
  } = await import("../src/proxy");

  const jsonPayload = new TextEncoder().encode('{"payload":"foo"}');
  assertEqual(jsonPayload.length, 17, "Expected documented StreamSSE payload length");
  const envelope = encodeConnectEnvelope(jsonPayload);
  assertEqual(envelope[0], 0, "Expected connect envelope flags 0");
  assertEqual(envelope[1], 0, "Expected length byte 1");
  assertEqual(envelope[2], 0, "Expected length byte 2");
  assertEqual(envelope[3], 0, "Expected length byte 3");
  assertEqual(envelope[4], 0x11, "Expected length 17");
  assertBytesEqual(envelope.subarray(5), jsonPayload, "Expected envelope payload");

  const raw = new Uint8Array([0xff, 0x01]);
  const unary = buildHttp1CursorRequest(
    "/agent.v1.AgentService/GetUsableModels",
    raw,
    true,
    "rid-unary",
  );
  assertEqual(unary.path, "/agent.v1.AgentService/GetUsableModels", "Expected unary path");
  assertEqual(unary.headers["Content-Type"], "application/proto", "Expected unary content type");
  assert(unary.body === raw, "Expected unary body to be the original protobuf bytes");
  assert(!("x-cursor-streaming" in unary.headers), "Expected unary request without streaming header");

  const heartbeatMessage = create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
  const heartbeat = toBinary(AgentClientMessageSchema, heartbeatMessage);
  const unaryMessage = buildHttp1CursorRequest(
    "/agent.v1.AgentService/GetUsableModels",
    heartbeat,
    true,
    "rid-unary-msg",
  );
  assert(unaryMessage.body === heartbeat, "Expected unary AgentClientMessage bytes unchanged");
  assert(
    new TextDecoder().decode(unaryMessage.body) !== JSON.stringify(toJson(AgentClientMessageSchema, heartbeatMessage)),
    "Expected unary body not to be JSON",
  );
  assertEqual(unaryMessage.body.length, heartbeat.length, "Expected no connect envelope on unary");

  const stream = buildHttp1CursorRequest("/agent.v1.AgentService/Run", heartbeat, false, "rid-stream");
  assertEqual(stream.path, "/agent.v1.AgentService/RunSSE", "Expected RunSSE path");
  assertEqual(stream.headers["Content-Type"], "application/connect+proto", "Expected streaming content type");
  assertEqual(stream.headers["x-cursor-streaming"], "true", "Expected streaming header");
  assertEqual(stream.headers["x-request-id"], "rid-stream", "Expected request id header");
  assertEqual(stream.body[0], 0, "Expected envelope flags");
  const requestId = fromBinary(BidiRequestIdSchema, stream.body.subarray(5));
  assertEqual(requestId.requestId, "rid-stream", "Expected RunSSE body to carry the request id");

  const message = new Uint8Array([1, 2, 3, 255]);
  const first = decodeBidiAppendRequest(encodeBidiAppendRequest(message, "req-123", 0));
  assertEqual(first.dataHex, "010203ff", "Expected hex AgentClientMessage");
  assertEqual(first.requestId, "req-123", "Expected BidiAppend request id");
  assertEqual(first.appendSeqno, 0, "Expected append seqno 0");
  const second = decodeBidiAppendRequest(encodeBidiAppendRequest(message, "req-123", 1));
  assertEqual(second.appendSeqno, 1, "Expected append seqno 1");

  console.log("[test] HTTP/1.1 wire format OK");
}

/** Minimal V2 context: a connected Cursor credential and a provider that records its models. */
function createModeContext(options: Record<string, unknown>) {
  let integrationTransform: IntegrationTransform | undefined;
  let providerTransform: ProviderTransform | undefined;
  const modelIDs: string[] = [];
  const integrationDraft = {
    update(_id: string, update: (integration: { name: string }) => void) {
      update({ name: "cursor" });
    },
    method: { update() {} },
  };
  const providerDraft = {
    add(input: { models: Array<{ id: string }> }) {
      for (const model of input.models) modelIDs.push(model.id);
    },
  };
  const credential = Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("cursor-oauth"),
    refresh: "valid-refresh",
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    expires: Date.now() + 60 * 60 * 1000,
  });
  const context = {
    options,
    integration: {
      async transform(transform: IntegrationTransform) {
        integrationTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        integrationTransform?.(integrationDraft as unknown as IntegrationDraft);
      },
      connection: {
        async active() {
          return { type: "credential" as const, id: "cursor-test", label: "Cursor" };
        },
        async resolve() {
          return credential;
        },
      },
    },
    provider: {
      async transform(transform: ProviderTransform) {
        providerTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        modelIDs.length = 0;
        providerTransform?.(providerDraft as unknown as ProviderDraft);
      },
    },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: true as const, value: undefined }),
              return: () => Promise.resolve({ done: true as const, value: undefined }),
            };
          },
        };
      },
    },
  };
  // SAFETY: The plugin only reads the options, integration, provider, and event domains.
  return { context: context as unknown as V2Context, modelIDs };
}

/**
 * Starts the V2 plugin with the given options, then checks which protocol both
 * model discovery and a chat request used. The other protocol is refused, so a
 * mismatch shows up as fallback models or a failed request.
 */
async function expectPluginTransport(
  modules: TestModules,
  backend: TestCursorBackend,
  options: Record<string, unknown>,
  expected: "h1" | "h2",
  label: string,
) {
  modules.stopProxy();
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([{ id: "mode-model", name: "Mode Model" }]);
  backend.setAllowedTransport(expected);
  try {
    const { context, modelIDs } = createModeContext(options);
    const cleanup = await modules.CursorV2Plugin.setup(context);
    try {
      assertArrayEqual(
        modelIDs.sort(),
        ["auto", "mode-model"],
        `${label}: expected discovery over ${expected}, not the fallback list`,
      );
      const discovery = backend.getRequests().filter((r) => r.endsWith("/GetUsableModels"));
      assert(
        discovery.length > 0 && discovery.every((r) => r.startsWith(expected)),
        `${label}: expected discovery over ${expected}, got ${JSON.stringify(discovery)}`,
      );

      const port = modules.getProxyPort();
      assert(port, `${label}: expected the plugin to start the proxy`);
      const res = await postChat(port, [{ role: "user", content: "hello" }], AbortSignal.timeout(5_000));
      const body = await readUntilDone(res);
      const run = backend.getRequests().filter((r) => /\/(Run|RunSSE|BidiAppend)$/.test(r));
      assert(
        run.length > 0 && run.every((r) => r.startsWith(expected)),
        `${label}: expected chat over ${expected}, got ${JSON.stringify(run)}`,
      );
      if (expected === "h1") {
        assert(
          run.some((r) => r.endsWith("/RunSSE")) && run.some((r) => r.endsWith("/BidiAppend")),
          `${label}: expected RunSSE and BidiAppend, got ${JSON.stringify(run)}`,
        );
        assert(body.includes("from-http1"), `${label}: expected the RunSSE reply in the stream, got ${body}`);
      }
    } finally {
      await cleanup();
    }
  } finally {
    backend.setAllowedTransport("both");
    modules.stopProxy();
    modules.clearModelCache();
  }
}

/** The env var is read at import, so `envDisabled` says what this process was started with. */
async function testHttpTransportSelection(
  modules: TestModules,
  backend: TestCursorBackend,
  envDisabled: boolean,
) {
  console.log(`[test] Testing HTTP transport selection (CURSOR_DISABLE_HTTP2=${envDisabled ? "1" : "unset"})...`);
  const fromEnv = envDisabled ? "h1" : "h2";
  await expectPluginTransport(modules, backend, { disableHttp2: true }, "h1", "option true");
  await expectPluginTransport(modules, backend, { disableHttp2: false }, "h2", "option false");
  await expectPluginTransport(modules, backend, {}, fromEnv, "no option");
  await expectPluginTransport(modules, backend, { disableHttp2: "true" }, fromEnv, "non-boolean option");
  console.log("[test] HTTP transport selection OK");
}

async function testHttpTransportFromEnv() {
  console.log("[test] Testing CURSOR_DISABLE_HTTP2=1 in a fresh process...");
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, CURSOR_DISABLE_HTTP2: "1", SMOKE_ENV_HTTP2_ONLY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assertEqual(code, 0, `Expected the CURSOR_DISABLE_HTTP2=1 run to pass:\n${out}\n${err}`);
  console.log("[test] CURSOR_DISABLE_HTTP2=1 OK");
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    if (process.env.SMOKE_ENV_HTTP2_ONLY) {
      await testHttpTransportSelection(modules, backend, true);
      process.exitCode = 0;
      return;
    }
    await testBridgeFraming();
    await testHttp1WireFormat();
    await testProxyStartStop(modules);
    await testStreamingFrameParser();
    await testStreamCancellationStopsBridge(modules, backend);
    await testBridgeResolvesUnderOddInstallPath(backend);
    await testHttp1StreamCancellationAndStop(modules, backend);
    await testCancelPausedBridgeKeepsBridge(modules, backend);
    await testStopProxyClearsPausedBridges(modules, backend);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testV2Plugin(modules, backend);
    await testHttpTransportSelection(modules, backend, false);
    await testHttpTransportFromEnv();
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();
