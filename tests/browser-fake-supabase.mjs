// Browser-only acceptance fake. It never represents a deployed Supabase project.
// It binds to loopback, stores only fictional data in memory, and creates ephemeral
// session strings without logging or persisting them.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createEmptyData, createFictionalDataset, validateDatabase } from "../src/core.mjs";

const port = 54321;
const ownerId = "00000000-0000-4000-8000-000000000012";
let current = null;
let revision = 0;
let conflictNext = false;

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,apikey,content-type,x-client-info,prefer,accept-profile,content-profile,x-supabase-api-version", "access-control-expose-headers": "content-range", ...extra });
  response.end(JSON.stringify(value));
}

function sessionValue() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: ownerId, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.${randomUUID().replaceAll("-", "")}`;
}

function teacherUser(email = "fictional.teacher@example.test") {
  return { id: ownerId, aud: "authenticated", role: "authenticated", email, email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} };
}

function row() {
  return current ? { owner_id: ownerId, payload: current, revision, created_at: "2026-08-11T00:00:00.000Z", updated_at: new Date().toISOString() } : null;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === "OPTIONS") return json(response, 200, {});
  if (request.method === "POST" && url.pathname === "/__test__/conflict") {
    conflictNext = true;
    return json(response, 200, { ready: true });
  }
  if (request.method === "POST" && url.pathname === "/auth/v1/token") {
    const input = await body(request);
    const user = teacherUser(String(input.email ?? "fictional.teacher@example.test"));
    return json(response, 200, { access_token: sessionValue(), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: sessionValue(), user });
  }
  if (request.method === "POST" && url.pathname === "/auth/v1/logout") return json(response, 200, {});
  if (request.method === "GET" && url.pathname === "/auth/v1/user") return json(response, 200, teacherUser());
  if (request.method === "GET" && url.pathname === "/rest/v1/teacher_databases") return json(response, 200, current ? [row()] : [], { "content-range": current ? "0-0/1" : "*/0" });
  if (request.method === "GET" && url.pathname === "/rest/v1/teacher_database_history") return json(response, 200, []);
  if (request.method === "POST" && url.pathname === "/rest/v1/rpc/save_teacher_database") {
    const input = await body(request);
    if (conflictNext) {
      const remote = createFictionalDataset();
      remote.settings.teacherName = "虚构云端冲突版本";
      current = validateDatabase(remote);
      revision += 1;
      conflictNext = false;
      return json(response, 409, { code: "40001", message: "revision_conflict", details: null, hint: null });
    }
    if (!Number.isSafeInteger(input.p_expected_revision) || input.p_expected_revision !== revision) return json(response, 409, { code: "40001", message: "revision_conflict", details: null, hint: null });
    current = validateDatabase(input.p_payload ?? createEmptyData());
    revision += 1;
    return json(response, 200, [row()]);
  }
  return json(response, 404, { message: "not_found" });
});

server.listen(port, "127.0.0.1");
