// HKU Room Booker web app (Cloudflare Worker).
//
// Students sign in with GitHub, copy the booker template into their own
// private repo, install the GitHub App on it, and save their HKU login as
// encrypted Actions secrets (encrypted in the browser — this Worker only ever
// sees ciphertext). Bookings run inside each student's own repo; this Worker
// only edits bookings.json, starts workflows, and sends the nightly trigger.

import {
  ROOM_TARGETS,
  FIRST_HOUR,
  LAST_HOUR,
  MAX_DURATION,
  hktIsoNow,
  isDuplicate,
  newQueueEntry,
  validateBooking,
} from "./bookings.js";
import { dispatchAll } from "./dispatch.js";
import { GitHubError, decodeContent, encodeContent, exchangeCode, gh, refreshUserToken } from "./github.js";
import {
  clearSessionCookie,
  clearStateCookie,
  loadSession,
  readState,
  sessionCookie,
  stateCookie,
} from "./session.js";

const BOOKINGS_PATH = "bookings.json";
const WORKFLOW_FILE = "book.yml";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function links(env) {
  const template = new URL("https://github.com/new");
  template.searchParams.set("template_owner", env.TEMPLATE_OWNER);
  template.searchParams.set("template_name", env.TEMPLATE_REPO);
  template.searchParams.set("name", env.TEMPLATE_REPO);
  template.searchParams.set("visibility", "private");
  template.searchParams.set("description", "My HKU room booker");
  return {
    template: template.toString(),
    install: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    manageInstall: "https://github.com/settings/installations",
  };
}

// ---- Session-aware context ----

class Ctx {
  constructor(request, env, session) {
    this.request = request;
    this.env = env;
    this.session = session;
    this.dirty = false;
  }

  async token() {
    const s = this.session;
    if (!s) throw new HttpError(401, "Please sign in again.");
    if (s.e && Date.now() > s.e - 60_000) {
      let fresh = null;
      if (s.r) fresh = await refreshUserToken(this.env, s.r).catch(() => null);
      if (!fresh) this.signOut("Your sign-in expired. Please sign in again.");
      Object.assign(s, fresh);
      this.dirty = true;
    }
    return s.t;
  }

  signOut(message) {
    this.session = null;
    this.dirty = true;
    throw new HttpError(401, message);
  }

  async gh(path, opts) {
    try {
      return await gh(await this.token(), path, opts);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 401) this.signOut("Your GitHub sign-in expired. Please sign in again.");
      throw err;
    }
  }

  // Finds the student's booker repo among the repos the app is installed on.
  async discoverRepo() {
    const { installations } = await this.gh("/user/installations?per_page=100");
    const mine = installations.filter((i) => i.account?.login?.toLowerCase() === this.session.login.toLowerCase());
    const template = `${this.env.TEMPLATE_OWNER}/${this.env.TEMPLATE_REPO}`.toLowerCase();
    let repos = [];
    for (const inst of mine) {
      const data = await this.gh(`/user/installations/${inst.id}/repositories?per_page=100`);
      repos.push(...data.repositories.filter((r) => r.full_name.toLowerCase() !== template));
    }
    if (repos.length === 0) return { repo: null, installed: mine.length > 0 };

    const preferred =
      repos.find((r) => r.name.toLowerCase() === this.env.TEMPLATE_REPO.toLowerCase()) ||
      repos.find((r) => r.name.toLowerCase().includes("booker")) ||
      (repos.length === 1 ? repos[0] : null);
    if (!preferred) return { repo: null, installed: true, ambiguous: repos.map((r) => r.full_name) };

    let hasWorkflow = true;
    try {
      await this.gh(`/repos/${preferred.full_name}/contents/.github/workflows/${WORKFLOW_FILE}`);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) hasWorkflow = false;
      else throw err;
    }
    const repo = {
      full_name: preferred.full_name,
      html_url: preferred.html_url,
      private: preferred.private,
      branch: preferred.default_branch,
    };
    if (hasWorkflow) {
      this.session.repo = repo;
      this.dirty = true;
    }
    return { repo, installed: true, hasWorkflow };
  }

  async repo() {
    if (this.session?.repo) return this.session.repo;
    const found = await this.discoverRepo();
    if (!found.repo || found.hasWorkflow === false) throw new HttpError(409, "Finish setup first.");
    return found.repo;
  }

  async finish(response) {
    if (!this.dirty) return response;
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", this.session ? await sessionCookie(this.session, this.env) : clearSessionCookie());
    return new Response(response.body, { status: response.status, headers });
  }
}

// ---- bookings.json helpers ----

async function readBookings(ctx, repo) {
  try {
    const file = await ctx.gh(`/repos/${repo.full_name}/contents/${BOOKINGS_PATH}?ref=${repo.branch}`);
    const data = JSON.parse(decodeContent(file.content));
    return { bookings: Array.isArray(data) ? data : [], sha: file.sha };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return { bookings: [], sha: null };
    throw err;
  }
}

// Read-modify-write with GitHub's sha check; retries once if the booker
// workflow committed in between.
async function updateBookings(ctx, repo, message, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { bookings, sha } = await readBookings(ctx, repo);
    const result = mutate(bookings);
    try {
      await ctx.gh(`/repos/${repo.full_name}/contents/${BOOKINGS_PATH}`, {
        method: "PUT",
        body: {
          message,
          content: encodeContent(JSON.stringify(bookings, null, 2) + "\n"),
          branch: repo.branch,
          ...(sha ? { sha } : {}),
        },
      });
      return result;
    } catch (err) {
      if (attempt === 0 && err instanceof GitHubError && (err.status === 409 || err.status === 422)) continue;
      throw err;
    }
  }
}

// ---- API handlers ----

async function apiMe(ctx) {
  try {
    return await setupStatus(ctx);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return json({ signedIn: false });
    throw err;
  }
}

async function setupStatus(ctx) {
  const env = ctx.env;
  if (!ctx.session) return json({ signedIn: false });
  const found = await ctx.discoverRepo();
  let credentialsSet = false;
  if (found.repo && found.hasWorkflow) {
    const { secrets } = await ctx.gh(`/repos/${found.repo.full_name}/actions/secrets?per_page=100`);
    const names = new Set(secrets.map((s) => s.name));
    credentialsSet = names.has("HKU_UID") && names.has("HKU_PIN");
  }
  return json({
    signedIn: true,
    login: ctx.session.login,
    avatar: ctx.session.avatar,
    installed: found.installed,
    ambiguous: found.ambiguous || null,
    repo: found.repo,
    repoIsBooker: found.hasWorkflow ?? null,
    credentialsSet,
    links: links(env),
  });
}

async function apiPublicKey(ctx) {
  const repo = await ctx.repo();
  const key = await ctx.gh(`/repos/${repo.full_name}/actions/secrets/public-key`);
  return json({ key_id: key.key_id, key: key.key });
}

const CIPHERTEXT = /^[A-Za-z0-9+/]+={0,2}$/;

async function apiCredentials(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  const { key_id: keyId, uid, pin } = body;
  if (typeof keyId !== "string" || !keyId) throw new HttpError(400, "Missing key id.");
  for (const v of [uid, pin]) {
    if (typeof v !== "string" || !CIPHERTEXT.test(v) || v.length > 1024) throw new HttpError(400, "Invalid encrypted value.");
  }
  const repo = await ctx.repo();
  for (const [name, value] of [["HKU_UID", uid], ["HKU_PIN", pin]]) {
    await ctx.gh(`/repos/${repo.full_name}/actions/secrets/${name}`, {
      method: "PUT",
      body: { encrypted_value: value, key_id: keyId },
    });
  }
  return json({ ok: true });
}

async function apiBookings(ctx) {
  const repo = await ctx.repo();
  const [{ bookings }, runs] = await Promise.all([
    readBookings(ctx, repo),
    ctx.gh(`/repos/${repo.full_name}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=8`),
  ]);
  return json({
    bookings: bookings.filter((b) => b && b.id),
    runs: runs.workflow_runs.map((r) => ({
      id: r.id,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      created_at: r.created_at,
      html_url: r.html_url,
    })),
    actionsUrl: `${repo.html_url}/actions`,
  });
}

async function apiCreateBooking(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  const { request: req, error } = validateBooking(body);
  if (error) throw new HttpError(400, error);
  const repo = await ctx.repo();

  if (req.mode === "now") {
    await ctx.gh(`/repos/${repo.full_name}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      body: {
        ref: repo.branch,
        inputs: { date: req.date, time: req.time, duration: String(req.duration), room_target: req.room_target },
      },
    });
    return json({ mode: "now", message: "Booking started. It usually finishes within 2–3 minutes." });
  }

  const entry = await updateBookings(ctx, repo, "chore: queue room booking [skip ci]", (bookings) => {
    if (isDuplicate(bookings, req)) throw new HttpError(409, "You already have this booking queued.");
    const e = newQueueEntry(req);
    bookings.push(e);
    return e;
  });
  return json({ mode: "queue", entry, message: "Queued. It will be booked at midnight when the booking window opens." });
}

async function apiCancelBooking(ctx) {
  const { id } = await ctx.request.json().catch(() => ({}));
  if (typeof id !== "string" || !id) throw new HttpError(400, "Missing booking id.");
  const repo = await ctx.repo();
  await updateBookings(ctx, repo, "chore: cancel room booking [skip ci]", (bookings) => {
    const entry = bookings.find((b) => b.id === id);
    if (!entry) throw new HttpError(404, "Booking not found.");
    if (entry.status !== "pending") throw new HttpError(409, "Only queued bookings can be cancelled.");
    entry.status = "cancelled";
    entry.updated_at = hktIsoNow();
  });
  return json({ ok: true });
}

function apiConfig(env) {
  return json({
    links: links(env),
    rooms: ROOM_TARGETS,
    firstHour: FIRST_HOUR,
    lastHour: LAST_HOUR,
    maxDuration: MAX_DURATION,
  });
}

// ---- Auth ----

function login(request, env) {
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("state", state);
  return redirect(authorize.toString(), [stateCookie(state)]);
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== readState(request)) {
    return redirect("/?error=signin", [clearStateCookie()]);
  }
  const tokens = await exchangeCode(env, code, `${url.origin}/auth/callback`);
  const user = await gh(tokens.t, "/user");
  const session = { ...tokens, login: user.login, avatar: user.avatar_url };
  return redirect("/", [clearStateCookie(), await sessionCookie(session, env)]);
}

// ---- Router ----

const API_ROUTES = {
  "GET /api/me": apiMe,
  "GET /api/public-key": apiPublicKey,
  "POST /api/credentials": apiCredentials,
  "GET /api/bookings": apiBookings,
  "POST /api/bookings": apiCreateBooking,
  "POST /api/bookings/cancel": apiCancelBooking,
};

async function handle(request, env) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /auth/login") return login(request, env);
  if (route === "GET /auth/callback") return callback(request, env);
  if (route === "GET /api/config") return apiConfig(env);

  // Token-authenticated, so no Origin check: lets you test with curl.
  if (route === "POST /admin/dispatch") {
    if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: "Forbidden." }, 403);
    }
    return json(await dispatchAll(env));
  }

  // Cookie-authenticated POSTs must come from this site (CSRF protection).
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return json({ error: "Bad origin." }, 403);
  }
  if (route === "POST /auth/logout") return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });

  const handler = API_ROUTES[route];
  if (!handler) return env.ASSETS.fetch(request);

  const ctx = new Ctx(request, env, await loadSession(request, env));
  let response;
  try {
    response = await handler(ctx);
  } catch (err) {
    if (err instanceof HttpError) response = json({ error: err.message }, err.status);
    else if (err instanceof GitHubError) {
      console.error("GitHub API error", err.status, err.message);
      response = json({ error: `GitHub said: ${err.message}` }, 502);
    } else throw err;
  }
  return ctx.finish(response);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchAll(env));
  },
};
