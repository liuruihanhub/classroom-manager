import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createFictionalDataset } from "../src/core.mjs";

const host = "127.0.0.1";
const port = 54331;
const userId = "11111111-1111-4111-8111-111111111111";
const now = () => new Date().toISOString();
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, aud: "authenticated", role: "authenticated", email: "fictional.teacher@example.invalid", exp: Math.floor(Date.now() / 1000) + 3600 })}.fake-signature`;
const user = { id: userId, aud: "authenticated", role: "authenticated", email: "fictional.teacher@example.invalid", email_confirmed_at: now(), confirmed_at: now(), last_sign_in_at: now(), app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: now(), updated_at: now(), is_anonymous: false };

const currentPayload = createFictionalDataset();
currentPayload.settings.teacherName = "虚构同步教师";
currentPayload.settings.onboarding.completedVersion = null;
const historicalPayload = createFictionalDataset();
historicalPayload.settings.teacherName = "虚构历史版本教师";
historicalPayload.settings.onboarding.completedVersion = "2.0";
let current = { owner_id: userId, payload: currentPayload, revision: 5, created_at: now(), updated_at: now() };
let histories = [{ owner_id: userId, payload: historicalPayload, revision: 3, archived_at: "2026-08-11T08:00:00.000Z" }];
let authExpired = false;
const metrics = { auth: 0, currentReads: 0, historyReads: 0, rpc: 0, conflicts: 0, writes: 0, realtimeJoins: 0 };

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,prefer,accept-profile,content-profile,x-supabase-api-version");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "Content-Range");
}
function json(response, status, body) {
  cors(response); response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body));
}
async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function authorized(request) { return !authExpired && String(request.headers.authorization ?? "").startsWith("Bearer "); }
function archiveAndWrite(payload) {
  histories.unshift({ owner_id: userId, payload: structuredClone(current.payload), revision: current.revision, archived_at: now() });
  histories = histories.filter((item, index, rows) => rows.findIndex((candidate) => candidate.revision === item.revision) === index).slice(0, 20);
  current = { ...current, payload: structuredClone(payload), revision: current.revision + 1, updated_at: now() };
}

const server = createServer(async (request, response) => {
  cors(response);
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname === "/auth/v1/token" && request.method === "POST") {
    metrics.auth += 1;
    const body = await bodyOf(request);
    if (body.email && body.password || url.searchParams.get("grant_type") === "refresh_token") return json(response, 200, { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "fake-browser-refresh-token", user });
    return json(response, 400, { message: "Invalid login credentials" });
  }
  if (url.pathname === "/auth/v1/user") return authorized(request) ? json(response, 200, user) : json(response, 401, { code: "PGRST301", message: "JWT expired" });
  if (url.pathname === "/auth/v1/logout") { response.writeHead(204); response.end(); return; }
  if (url.pathname === "/rest/v1/teacher_databases" && request.method === "GET") {
    metrics.currentReads += 1;
    if (!authorized(request)) return json(response, 401, { code: "PGRST301", message: "JWT expired" });
    response.setHeader("Content-Range", "0-0/1"); return json(response, 200, current);
  }
  if (url.pathname === "/rest/v1/teacher_database_history" && request.method === "GET") {
    metrics.historyReads += 1;
    if (!authorized(request)) return json(response, 401, { code: "PGRST301", message: "JWT expired" });
    response.setHeader("Content-Range", `0-${Math.max(0, histories.length - 1)}/${histories.length}`); return json(response, 200, histories);
  }
  if (url.pathname === "/rest/v1/rpc/save_teacher_database" && request.method === "POST") {
    metrics.rpc += 1;
    if (!authorized(request)) return json(response, 401, { code: "PGRST301", message: "JWT expired" });
    const body = await bodyOf(request);
    if (body.p_expected_revision !== current.revision) { metrics.conflicts += 1; return json(response, 409, { code: "40001", message: "revision_conflict", details: null, hint: null }); }
    archiveAndWrite(body.p_payload);
    metrics.writes += 1;
    return json(response, 200, [current]);
  }
  if (url.pathname === "/__state") return json(response, 200, { current, histories, authExpired, metrics });
  if (url.pathname === "/__compete" && request.method === "POST") {
    const payload = structuredClone(current.payload); payload.settings.teacherName = `另一设备先写入-${current.revision + 1}`; archiveAndWrite(payload); return json(response, 200, { current });
  }
  if (url.pathname === "/__expire" && request.method === "POST") { authExpired = true; return json(response, 200, { authExpired }); }
  if (url.pathname === "/__unexpire" && request.method === "POST") { authExpired = false; return json(response, 200, { authExpired }); }
  return json(response, 404, { message: "fake endpoint not found" });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (!request.url.startsWith("/realtime/v1/websocket")) return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.event === "phx_join") { metrics.realtimeJoins += 1; socket.send(JSON.stringify({ topic: message.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: message.ref, join_ref: message.join_ref })); }
    else if (message.event === "heartbeat") socket.send(JSON.stringify({ topic: "phoenix", event: "phx_reply", payload: { status: "ok", response: {} }, ref: message.ref }));
  });
});

server.listen(port, host, () => process.stdout.write(`FAKE_SUPABASE_READY http://${host}:${port}\n`));
function shutdown() { wss.close(); server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
