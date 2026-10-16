// End-to-end test of the Worker against an in-memory fake of the GitHub API.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import worker from "../src/worker.js";

const ORIGIN = "https://booker.example";
const REPO = "student1/hku-room-booker";

function fakeGitHub() {
  const state = {
    bookings: [],
    sha: 1,
    secrets: new Set(),
    repoDispatches: [],
    workflowDispatches: [],
    putCount: 0,
    failNextPut: false,
  };
  const reply = (body, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  state.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const path = url.pathname;
    const route = `${method} ${url.host}${path}`;

    if (route === "POST github.com/login/oauth/access_token") {
      return reply({ access_token: "ghu_user", refresh_token: "ghr_refresh", expires_in: 28800 });
    }
    if (route === "GET api.github.com/user") return reply({ login: "student1", avatar_url: "https://a/x.png" });
    if (route === "GET api.github.com/user/installations") {
      return reply({ installations: [{ id: 42, account: { login: "student1" } }] });
    }
    if (route === "GET api.github.com/user/installations/42/repositories") {
      return reply({
        repositories: [
          { name: "other", full_name: "student1/other", html_url: "", private: true, default_branch: "main" },
          { name: "hku-room-booker", full_name: "rohanasrani3/hku-room-booker", html_url: "", private: false, default_branch: "main" },
          { name: "hku-room-booker", full_name: REPO, html_url: `https://github.com/${REPO}`, private: true, default_branch: "main" },
        ],
      });
    }
    if (route === `GET api.github.com/repos/${REPO}/contents/.github/workflows/book.yml`) return reply({ sha: "wf" });
    if (route === `GET api.github.com/repos/${REPO}/actions/secrets`) {
      return reply({ secrets: [...state.secrets].map((name) => ({ name })) });
    }
    if (route === `GET api.github.com/repos/${REPO}/actions/secrets/public-key`) return reply({ key_id: "k1", key: "AAAA" });
    if (method === "PUT" && path.startsWith(`/repos/${REPO}/actions/secrets/`)) {
      assert.equal(body.key_id, "k1");
      state.secrets.add(path.split("/").pop());
      return reply(null, 201);
    }
    if (route === `GET api.github.com/repos/${REPO}/contents/bookings.json`) {
      const content = Buffer.from(JSON.stringify(state.bookings)).toString("base64");
      return reply({ content, sha: String(state.sha) });
    }
    if (route === `PUT api.github.com/repos/${REPO}/contents/bookings.json`) {
      state.putCount++;
      if (state.failNextPut) {
        state.failNextPut = false;
        state.sha++; // simulate the workflow committing in between
        return reply({ message: "sha mismatch" }, 409);
      }
      if (body.sha !== String(state.sha)) return reply({ message: "sha mismatch" }, 409);
      state.bookings = JSON.parse(Buffer.from(body.content, "base64").toString());
      state.sha++;
      return reply({}, 200);
    }
    if (route === `POST api.github.com/repos/${REPO}/actions/workflows/book.yml/dispatches`) {
      state.workflowDispatches.push(body);
      return reply(null, 204);
    }
    if (route === `GET api.github.com/repos/${REPO}/actions/workflows/book.yml/runs`) {
      return reply({ workflow_runs: [{ id: 1, event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "x", html_url: "y" }] });
    }
    // App (installation) endpoints used by the nightly dispatcher.
    if (route === "GET api.github.com/app/installations") return reply([{ id: 42, account: { login: "student1" } }]);
    if (route === "POST api.github.com/app/installations/42/access_tokens") return reply({ token: "ghs_inst" });
    if (route === "GET api.github.com/installation/repositories") {
      return reply({ repositories: [{ full_name: REPO }] });
    }
    if (route === `POST api.github.com/repos/${REPO}/dispatches`) {
      assert.equal(init.headers.Authorization, "Bearer ghs_inst");
      state.repoDispatches.push(body);
      return reply(null, 204);
    }
    throw new Error(`Unhandled fake GitHub route: ${route}`);
  };
  return state;
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  TEMPLATE_OWNER: "rohanasrani3",
  TEMPLATE_REPO: "hku-room-booker",
  GITHUB_APP_SLUG: "hku-room-booker",
  GITHUB_APP_ID: "1",
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }),
  SESSION_SECRET: "s".repeat(48),
  ADMIN_TOKEN: "admin",
  ASSETS: { fetch: async () => new Response("asset") },
};

function cookiesFrom(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]);
}

test("full student flow", async (t) => {
  const gh = fakeGitHub();
  t.mock.method(globalThis, "fetch", gh.fetch);

  let jar = [];
  const call = async (method, path, body, extra = {}) => {
    const headers = { Cookie: jar.join("; "), ...extra };
    if (method === "POST") headers.Origin = ORIGIN;
    if (body) headers["Content-Type"] = "application/json";
    const res = await worker.fetch(
      new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" }),
      env,
    );
    for (const c of cookiesFrom(res)) {
      jar = jar.filter((j) => j.split("=")[0] !== c.split("=")[0]);
      if (!c.endsWith("=")) jar.push(c);
    }
    return res;
  };

  // Signed out
  assert.deepEqual(await (await call("GET", "/api/me")).json(), { signedIn: false });
  assert.equal((await call("GET", "/api/bookings")).status, 401);

  // Sign in: state must match
  const login = await call("GET", "/auth/login");
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  assert.equal((await call("GET", "/auth/callback?code=c&state=wrong")).headers.get("Location"), "/?error=signin");
  const loginAgain = await call("GET", "/auth/login");
  const state2 = new URL(loginAgain.headers.get("Location")).searchParams.get("state");
  assert.notEqual(state, state2);
  const cb = await call("GET", `/auth/callback?code=c&state=${state2}`);
  assert.equal(cb.headers.get("Location"), "/");

  // Setup status: installed, repo found, no credentials yet
  let me = await (await call("GET", "/api/me")).json();
  assert.equal(me.login, "student1");
  assert.equal(me.repo.full_name, REPO);
  assert.equal(me.repoIsBooker, true);
  assert.equal(me.credentialsSet, false);
  assert.match(me.links.template, /template_name=hku-room-booker/);

  // Save credentials (ciphertext only)
  const key = await (await call("GET", "/api/public-key")).json();
  assert.equal(key.key_id, "k1");
  assert.equal((await call("POST", "/api/credentials", { key_id: "k1", uid: "not base64!", pin: "QUJD" })).status, 400);
  assert.equal((await call("POST", "/api/credentials", { key_id: "k1", uid: "QUJD", pin: "REVG" })).status, 200);
  me = await (await call("GET", "/api/me")).json();
  assert.equal(me.credentialsSet, true);

  // CSRF: POST from another origin is refused
  const evil = await worker.fetch(
    new Request(ORIGIN + "/api/bookings", { method: "POST", headers: { Cookie: jar.join("; "), Origin: "https://evil.example" }, body: "{}" }),
    env,
  );
  assert.equal(evil.status, 403);

  // Queue a future booking (date far enough ahead in HKT)
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const booking = { date: future, time: "14:00", duration: 2, room_target: "chi_wah_study_rooms" };
  let res = await call("POST", "/api/bookings", booking);
  let data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.mode, "queue");
  assert.equal(gh.bookings.length, 1);
  assert.equal(gh.bookings[0].status, "pending");

  // Duplicate is refused
  assert.equal((await call("POST", "/api/bookings", booking)).status, 409);

  // A concurrent commit (sha mismatch) is retried transparently
  gh.failNextPut = true;
  res = await call("POST", "/api/bookings", { ...booking, time: "16:00" });
  assert.equal(res.status, 200);
  assert.equal(gh.bookings.length, 2);

  // Immediate booking (tomorrow) dispatches the workflow
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(new Date(Date.now() + 864e5));
  data = await (await call("POST", "/api/bookings", { ...booking, date: tomorrow })).json();
  assert.equal(data.mode, "now");
  assert.deepEqual(gh.workflowDispatches[0], {
    ref: "main",
    inputs: { date: tomorrow, time: "14:00", duration: "2", room_target: "chi_wah_study_rooms" },
  });

  // Validation errors surface as 400s
  assert.equal((await call("POST", "/api/bookings", { ...booking, time: "14:30" })).status, 400);

  // List + cancel
  data = await (await call("GET", "/api/bookings")).json();
  assert.equal(data.bookings.length, 2);
  assert.equal(data.runs.length, 1);
  assert.equal((await call("POST", "/api/bookings/cancel", { id: gh.bookings[0].id })).status, 200);
  assert.equal(gh.bookings[0].status, "cancelled");
  assert.equal((await call("POST", "/api/bookings/cancel", { id: gh.bookings[0].id })).status, 409);

  // Static assets fall through
  assert.equal(await (await call("GET", "/")).text(), "asset");

  // Logout clears the session
  await call("POST", "/auth/logout");
  assert.deepEqual(await (await call("GET", "/api/me")).json(), { signedIn: false });
});

test("nightly dispatcher triggers every installed repo", async (t) => {
  const gh = fakeGitHub();
  t.mock.method(globalThis, "fetch", gh.fetch);
  const waits = [];
  await worker.scheduled({ cron: "50 15 * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(gh.repoDispatches, [{ event_type: "scheduled-booking" }]);

  // Admin endpoint requires the token
  const denied = await worker.fetch(new Request(ORIGIN + "/admin/dispatch", { method: "POST", headers: { Origin: ORIGIN } }), env);
  assert.equal(denied.status, 403);
  const ok = await worker.fetch(
    new Request(ORIGIN + "/admin/dispatch", { method: "POST", headers: { Authorization: "Bearer admin" } }),
    env,
  );
  assert.deepEqual((await ok.json()).dispatched, [REPO]);
});

test("expired session without refresh token signs out cleanly", async (t) => {
  const gh = fakeGitHub();
  t.mock.method(globalThis, "fetch", gh.fetch);
  const { seal } = await import("../src/session.js");
  const stale = await seal({ t: "ghu_old", r: null, e: Date.now() - 1000, login: "student1" }, env.SESSION_SECRET);
  const res = await worker.fetch(new Request(ORIGIN + "/api/me", { headers: { Cookie: `booker_session=${stale}` } }), env);
  assert.deepEqual(await res.json(), { signedIn: false });
  assert.match(res.headers.get("Set-Cookie"), /booker_session=;.*Max-Age=0/);
});
