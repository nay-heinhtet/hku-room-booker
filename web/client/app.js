import { sealSecret } from "./seal.js";

const app = document.getElementById("app");
const account = document.getElementById("account");
let config = null;
let refreshTimer = null;

// ---- tiny DOM helpers (textContent only, so repo data can't inject HTML) ----

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function render(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/me") {
    start();
    throw new Error(data.error || "Please sign in again.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Runs an async action from a button, showing progress and errors in `out`.
async function busy(button, out, fn) {
  button.disabled = true;
  out.replaceChildren();
  try {
    await fn();
  } catch (err) {
    out.replaceChildren(h("div", { class: "notice bad" }, err.message));
  } finally {
    button.disabled = false;
  }
}

// ---- HKT date helpers ----

const hktFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" });
const hktToday = () => hktFormat.format(new Date());
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function prettyDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}
function roomName(id) {
  return config.rooms.find((r) => r.id === id)?.description || id;
}

// ---- Screens ----

function signedOut() {
  account.replaceChildren();
  const params = new URLSearchParams(location.search);
  render(
    params.get("error") && h("div", { class: "notice bad" }, "Sign-in didn't complete. Please try again."),
    h("h1", {}, "Get HKU library rooms without staying up until midnight"),
    h("p", { class: "muted" },
      "Rooms for tomorrow open at midnight and go fast. Pick a room here and the booker grabs it for you the moment booking opens."),
    h("div", { class: "how" },
      h("div", {}, h("b", {}, "1. Set up once"), "About 5 minutes, using a free GitHub account."),
      h("div", {}, h("b", {}, "2. Pick a room"), "Choose a date, time and library."),
      h("div", {}, h("b", {}, "3. Sleep"), "It books at 00:00 and shows you the result here."),
    ),
    h("div", { class: "card" },
      h("h2", {}, "Start"),
      h("p", {}, "The booker runs on GitHub (free). If you don't have an account yet, ",
        h("a", { href: "https://github.com/signup", target: "_blank", rel: "noopener" }, "create one first"),
        ", then come back."),
      h("a", { class: "btn", href: "/auth/login" }, "Sign in with GitHub"),
    ),
    h("div", { class: "card" },
      h("h2", {}, "Is my HKU password safe?"),
      h("p", { class: "small" },
        "Your password is encrypted in your browser and stored only as a secret in your own private GitHub copy. This site never stores it and cannot read it back. Bookings run from your own GitHub account, not from a shared server."),
      h("p", { class: "small muted" }, "You can remove access at any time by uninstalling the app or deleting your copy."),
    ),
  );
}

function stepItem(n, state, title, ...body) {
  return h("li", { class: `step ${state}` },
    h("div", { class: "dot" }, state === "done" ? "✓" : String(n)),
    h("div", {}, h("h3", {}, title), state === "current" ? body : null),
  );
}

function setup(me) {
  const out = h("div");
  const recheck = h("button", { class: "btn secondary", onclick: () => start() }, "I've done this — check again");
  const hasRepo = me.repo && me.repoIsBooker;

  let problem = null;
  if (me.ambiguous) {
    problem = h("div", { class: "notice warn" },
      "The app is connected to several repositories, and none is named hku-room-booker. ",
      h("a", { href: me.links.manageInstall, target: "_blank", rel: "noopener" }, "Open the app settings"),
      " and choose “Only select repositories” → your booker copy.");
  } else if (me.repo && !me.repoIsBooker) {
    problem = h("div", { class: "notice warn" },
      `The app is connected to ${me.repo.full_name}, but that isn't a booker copy. Do step 2 first, then add the new copy in `,
      h("a", { href: me.links.manageInstall, target: "_blank", rel: "noopener" }, "the app settings"), ".");
  }

  const copyStep = stepItem(2, hasRepo ? "done" : "current", "Make your own private copy of the booker",
    h("ol", {},
      h("li", {}, "Click the button below. GitHub opens in a new tab."),
      h("li", {}, "Leave everything as it is (name ", h("b", {}, "hku-room-booker"), ", ", h("b", {}, "Private"), ")."),
      h("li", {}, "Click the green ", h("b", {}, "Create repository"), " button, then come back here."),
    ),
    h("a", { class: "btn", href: me.links.template, target: "_blank", rel: "noopener" }, "Create my copy on GitHub"),
  );

  const installStep = stepItem(3, hasRepo ? "done" : "current", "Connect the booker app to your copy",
    h("ol", {},
      h("li", {}, "Click the button below."),
      h("li", {}, "Choose ", h("b", {}, "Only select repositories"), " and pick ", h("b", {}, "hku-room-booker"), "."),
      h("li", {}, "Click ", h("b", {}, "Install"), ". GitHub sends you back here."),
    ),
    h("div", { class: "row" },
      h("a", { class: "btn", href: me.links.install }, "Connect the app"),
      recheck,
    ),
  );

  render(
    h("h1", {}, "Set up your booker"),
    h("p", { class: "muted" }, "Do this once. It takes about 5 minutes."),
    h("div", { class: "card" },
      problem,
      h("ol", { class: "steps" },
        stepItem(1, "done", `Signed in as ${me.login}`),
        copyStep,
        installStep,
        stepItem(4, hasRepo ? "current" : "todo", "Save your HKU login", credentialsForm(me, () => start())),
      ),
      out,
    ),
  );
}

function credentialsForm(me, onSaved) {
  const uid = h("input", { id: "uid", autocomplete: "username", placeholder: "u3123456", required: true });
  const pin = h("input", { id: "pin", type: "password", autocomplete: "current-password", required: true });
  const out = h("div");
  const submit = h("button", { class: "btn", type: "submit" }, "Save securely");
  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      busy(submit, out, async () => {
        const cleanUid = uid.value.trim().toLowerCase().replace(/@connect\.hku\.hk$/, "");
        if (!cleanUid || !pin.value) throw new Error("Enter both your UID and PIN.");
        const key = await api("/api/public-key");
        await api("/api/credentials", {
          key_id: key.key_id,
          uid: sealSecret(cleanUid, key.key),
          pin: sealSecret(pin.value, key.key),
        });
        pin.value = "";
        onSaved();
      });
    },
  },
    h("p", { class: "small muted" },
      "Encrypted on this device before it's sent, then stored as a secret in ", me.repo?.full_name || "your copy", "."),
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", { for: "uid" }, "HKU UID"), uid,
        h("div", { class: "hint" }, "Without @connect.hku.hk")),
      h("div", { class: "field" }, h("label", { for: "pin" }, "HKU PIN (password)"), pin),
    ),
    submit,
    out,
  );
  return form;
}

function bookingForm(onBooked) {
  const today = hktToday();
  const date = h("input", { id: "date", type: "date", min: today, max: addDays(today, 60), value: addDays(today, 2), required: true });
  const time = h("select", { id: "time" });
  for (let hr = config.firstHour; hr <= config.lastHour; hr++) {
    const v = `${String(hr).padStart(2, "0")}:00`;
    time.append(h("option", { value: v, selected: hr === 10 }, v));
  }
  const duration = h("select", { id: "duration" });
  for (let d = 1; d <= config.maxDuration; d++) {
    duration.append(h("option", { value: d, selected: d === config.maxDuration }, d === 1 ? "1 hour" : `${d} hours`));
  }
  const room = h("select", { id: "room" },
    config.rooms.map((r) => h("option", { value: r.id, selected: r.id === "chi_wah_study_rooms" }, r.description)));
  const when = h("div", { class: "hint" });
  const out = h("div");
  const submit = h("button", { class: "btn", type: "submit" }, "Book");

  function refreshHint() {
    const d = date.value;
    if (!d) return when.replaceChildren();
    if (d <= addDays(hktToday(), 1)) {
      when.textContent = "Booking for this date is already open, so it will be booked right now.";
      submit.textContent = "Book now";
    } else {
      when.textContent = `Will be booked automatically at 00:00 on ${prettyDate(addDays(d, -1))} (when booking opens).`;
      submit.textContent = "Queue booking";
    }
  }
  function refreshDuration() {
    const lastHour = time.value === "23:00";
    for (const opt of duration.options) opt.disabled = lastHour && opt.value !== "1";
    if (lastHour) duration.value = "1";
  }
  date.addEventListener("input", refreshHint);
  time.addEventListener("change", refreshDuration);
  refreshHint();

  return h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      busy(submit, out, async () => {
        const res = await api("/api/bookings", {
          date: date.value, time: time.value, duration: Number(duration.value), room_target: room.value,
        });
        out.replaceChildren(h("div", { class: "notice ok" }, res.message));
        onBooked();
      });
    },
  },
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", { for: "date" }, "Date"), date, when),
      h("div", { class: "field" }, h("label", { for: "room" }, "Where"), room),
      h("div", { class: "field" }, h("label", { for: "time" }, "Start time"), time),
      h("div", { class: "field" }, h("label", { for: "duration" }, "How long"), duration),
    ),
    submit,
    out,
  );
}

const STATUS_LABEL = {
  pending: "Queued",
  booked: "Booked",
  failed: "Failed",
  unavailable: "No room free",
  expired: "Missed",
  cancelled: "Cancelled",
  invalid: "Invalid",
};

function bookingsList(data, reload) {
  const today = hktToday();
  const items = [...data.bookings]
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .slice(0, 15);
  if (items.length === 0) return h("p", { class: "muted" }, "No queued bookings yet.");
  return h("ul", { class: "list" }, items.map((b) => {
    const out = h("span");
    const cancel = b.status === "pending" && b.date >= today
      ? h("button", {
        class: "btn danger",
        onclick: (e) => busy(e.currentTarget, out, async () => {
          await api("/api/bookings/cancel", { id: b.id });
          reload();
        }),
      }, "Cancel")
      : null;
    return h("li", {},
      h("div", {},
        h("div", { class: "what" }, `${prettyDate(b.date)}, ${b.time} · ${b.duration}h`),
        h("div", { class: "small muted" }, roomName(b.room_target || b.room_type)),
        b.last_error && b.status !== "booked" ? h("div", { class: "small muted" }, b.last_error) : null,
        out,
      ),
      h("div", { class: "row" }, h("span", { class: `badge ${b.status}` }, STATUS_LABEL[b.status] || b.status), cancel),
    );
  }));
}

function runsList(data) {
  if (data.runs.length === 0) return h("p", { class: "muted" }, "No runs yet.");
  const what = { workflow_dispatch: "Book now", schedule: "Nightly (backup)", repository_dispatch: "Nightly" };
  return h("ul", { class: "list" }, data.runs.map((r) => {
    const state = r.status === "completed" ? r.conclusion : r.status;
    const label = { success: "Done", failure: "Failed", in_progress: "Running", queued: "Starting", cancelled: "Cancelled", skipped: "Skipped" }[state] || state;
    return h("li", {},
      h("div", {},
        h("div", { class: "what" }, what[r.event] || r.event),
        h("div", { class: "small muted" }, new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" })),
      ),
      h("div", { class: "row" },
        h("span", { class: `badge ${state}` }, label),
        h("a", { class: "small", href: r.html_url, target: "_blank", rel: "noopener" }, "Details"),
      ),
    );
  }));
}

function dashboard(me) {
  const bookingsBox = h("div", {}, h("p", { class: "muted" }, "Loading…"));
  const runsBox = h("div", {}, h("p", { class: "muted" }, "Loading…"));
  let actionsUrl = `${me.repo.html_url}/actions`;

  async function reload() {
    try {
      const data = await api("/api/bookings");
      actionsUrl = data.actionsUrl;
      bookingsBox.replaceChildren(bookingsList(data, reload));
      runsBox.replaceChildren(runsList(data));
    } catch (err) {
      bookingsBox.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  }

  const credsBox = h("div");
  const showCreds = h("button", {
    class: "btn link",
    onclick: () => credsBox.replaceChildren(credentialsForm(me, () => {
      credsBox.replaceChildren(h("div", { class: "notice ok" }, "HKU login updated."));
    })),
  }, "Change my saved HKU login");

  render(
    h("h1", {}, "Book a room"),
    h("div", { class: "card" }, bookingForm(reload)),
    h("div", { class: "card" }, h("h2", {}, "My bookings"), bookingsBox),
    h("div", { class: "card" },
      h("h2", {}, "Recent activity"),
      h("p", { class: "small muted" }, "Each booking attempt is a run in your GitHub copy. Open one to see the full log."),
      runsBox,
    ),
    h("div", { class: "card" },
      h("h2", {}, "Settings"),
      h("p", {}, showCreds),
      credsBox,
      h("p", { class: "small muted" },
        "Your copy: ", h("a", { href: me.repo.html_url, target: "_blank", rel: "noopener" }, me.repo.full_name),
        ". To stop using the booker, ",
        h("a", { href: me.links.manageInstall, target: "_blank", rel: "noopener" }, "uninstall the app"),
        " and delete your copy."),
    ),
  );
  reload();
  // Refresh while something might be running.
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 30_000);
}

function showAccount(me) {
  account.replaceChildren(
    ...(me.avatar ? [h("img", { src: me.avatar, alt: "" })] : []),
    h("span", {}, me.login),
    h("button", {
      class: "btn link small",
      onclick: async () => {
        await fetch("/auth/logout", { method: "POST" });
        location.href = "/";
      },
    }, "Sign out"),
  );
}

async function start() {
  try {
    config ??= await api("/api/config");
    const me = await api("/api/me");
    if (!me.signedIn) {
      clearInterval(refreshTimer);
      return signedOut();
    }
    showAccount(me);
    if (me.repo && me.repoIsBooker && me.credentialsSet) return dashboard(me);
    setup(me);
  } catch (err) {
    render(h("div", { class: "notice bad" }, err.message),
      h("button", { class: "btn secondary", onclick: () => start() }, "Try again"));
  }
}

if (location.search) history.replaceState(null, "", location.pathname + (location.search.includes("error=") ? location.search : ""));
start();
