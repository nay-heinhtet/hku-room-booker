import { sealSecret } from "./seal.js";

const app = document.getElementById("app");
const band = document.getElementById("band");
const account = document.getElementById("account");
let config = null;
let refreshTimer = null;
let clockTimer = null;

// ---- tiny DOM helpers (textContent only, so repo data can't inject HTML) ----

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(viewBox, ...paths) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    el.append(p);
  }
  return el;
}

const githubIcon = () => svg("0 0 16 16",
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z");
const checkIcon = () => svg("0 0 24 24", "M20 6 9 17l-5-5");
const lockIcon = () => svg("0 0 24 24", "M7 11V7a5 5 0 0 1 10 0v4", "M5 11h14v10H5z");
const keyIcon = () => svg("0 0 24 24", "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z");

// Main content and the night band above it are rendered together.
function render(bandContent, ...nodes) {
  clearInterval(clockTimer);
  band.replaceChildren(...(bandContent ? [h("div", { class: "wrap" }, bandContent)] : []));
  app.replaceChildren(...nodes.flat().filter(Boolean));
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
    out.replaceChildren(h("div", { class: "notice bad", role: "alert" }, err.message));
  } finally {
    button.disabled = false;
  }
}

// ---- HKT time helpers ----

const HKT = "Asia/Hong_Kong";
const hktDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: HKT });
const hktClockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: HKT, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const hktToday = () => hktDateFormat.format(new Date());

function hktSecondsIntoDay() {
  const p = Object.fromEntries(hktClockFormat.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmt(iso, options) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...options });
}
const prettyDate = (iso) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });

function endTime(time, duration) {
  const hour = Number(time.slice(0, 2));
  if (hour + duration === 24) return "23:45"; // the last library session ends at 23:45
  return `${String(hour + duration).padStart(2, "0")}:00`;
}

// The run at 00:00 on day D books date D+1. So a date is booked "now" if its
// window is already open, otherwise at 00:00 the day before.
const opensNow = (date) => date <= addDays(hktToday(), 1);
// The date the next midnight run will book.
const tonightTarget = () => addDays(hktToday(), 2);

// ---- Rooms ----

const ROOM_NAMES = {
  chi_wah_study_rooms: "Chi Wah study room",
  chi_wah_study_booths: "Chi Wah study booth",
  all_study_rooms: "Any study space",
  discussion_rooms: "Any discussion room",
  single_study_rooms: "Any single study room",
  study_tables: "Study table",
  main_library_discussion_rooms: "Main Library · discussion room",
  main_library_single_study_rooms: "Main Library · single room",
  law_discussion_rooms: "Law Library · discussion room",
  medical_discussion_rooms: "Medical Library · discussion room",
  medical_single_study_rooms: "Medical Library · single room",
  dental_discussion_rooms: "Dental Library · discussion room",
  music_discussion_rooms: "Music Library · discussion room",
};
const QUICK_ROOMS = ["chi_wah_study_rooms", "chi_wah_study_booths", "all_study_rooms"];
const ROOM_GROUPS = [
  ["Chi Wah Learning Commons", ["chi_wah_study_rooms", "chi_wah_study_booths"]],
  ["Any library (most chances)", ["all_study_rooms", "discussion_rooms", "single_study_rooms", "study_tables"]],
  ["A specific library", [
    "main_library_discussion_rooms", "main_library_single_study_rooms", "law_discussion_rooms",
    "medical_discussion_rooms", "medical_single_study_rooms", "dental_discussion_rooms", "music_discussion_rooms",
  ]],
];

const roomName = (id) => ROOM_NAMES[id] || config.rooms.find((r) => r.id === id)?.description || id;
const roomDesc = (id) => config.rooms.find((r) => r.id === id)?.description || "";

// ---- Shared bits ----

function choice(name, value, checked, ...content) {
  return h("label", { class: "choice" },
    h("input", { type: "radio", name, value, checked }),
    h("span", { class: "choice-body" }, ...content),
  );
}

const external = (href, text, cls) => h("a", { href, target: "_blank", rel: "noopener", class: cls }, text);

// ---- Signed out: landing ----

function signedOut() {
  account.replaceChildren();
  const error = new URLSearchParams(location.search).get("error");
  render(
    h("div", { class: "hero" },
      h("div", {},
        h("p", { class: "eyebrow" }, "HKU library study rooms"),
        h("h1", {}, "Your study room, booked at midnight while you sleep."),
        h("p", { class: "lede" },
          "Tomorrow's rooms open at 00:00 and the good ones go within minutes. Queue the room you want, and the booker grabs it the second booking opens."),
        h("div", { class: "row" },
          h("a", { class: "btn", href: "/auth/login" }, githubIcon(), "Sign in with GitHub"),
          external("https://github.com/signup", "New to GitHub? Sign up free", "btn ghost-night"),
        ),
      ),
      h("div", { class: "hero-clock", "aria-hidden": "true" }, "00:00"),
    ),
    error && h("div", { class: "notice bad" }, "Sign-in didn't finish. Please try again."),
    h("section", { class: "how", "aria-label": "How it works" },
      h("div", { class: "card" }, h("span", { class: "n" }, "01"), h("b", {}, "Set up once"),
        h("p", {}, "About five minutes with a free GitHub account. No coding.")),
      h("div", { class: "card" }, h("span", { class: "n" }, "02"), h("b", {}, "Queue a room"),
        h("p", {}, "Pick a day, a time and a library, up to two months ahead.")),
      h("div", { class: "card" }, h("span", { class: "n" }, "03"), h("b", {}, "Go to sleep"),
        h("p", {}, "It books at 00:00 on the dot. Check the result here in the morning.")),
    ),
    h("section", { class: "card trust" },
      h("h2", {}, "Your HKU password stays yours"),
      h("ul", {},
        h("li", {}, lockIcon(), h("span", {}, "It's encrypted on your device before it leaves your browser. This site can't read it and doesn't store it.")),
        h("li", {}, keyIcon(), h("span", {}, "It's kept only as a secret in your own private GitHub copy, and bookings run from your account, not a shared server.")),
        h("li", {}, checkIcon(), h("span", {}, "Stop any time: uninstall the app or delete your copy, and everything is gone.")),
      ),
    ),
  );
}

// ---- Setup ----

function step(n, state, title, ...body) {
  return h("div", { class: `step ${state}` },
    h("div", { class: "step-num" }, state === "done" ? "✓" : String(n)),
    h("div", {}, h("h3", {}, title), state === "current" ? body : null),
  );
}

function setup(me) {
  const hasRepo = Boolean(me.repo && me.repoIsBooker);
  const doneCount = hasRepo ? 3 : 1;

  let problem = null;
  if (me.ambiguous) {
    problem = h("div", { class: "notice warn" },
      "The app is connected to several repositories, and none of them is named hku-room-booker. ",
      external(me.links.manageInstall, "Open the app settings"),
      ", choose “Only select repositories”, and pick your booker copy.");
  } else if (me.repo && !me.repoIsBooker) {
    problem = h("div", { class: "notice warn" },
      `The app is connected to ${me.repo.full_name}, but that isn't a booker copy. Do step 2 first, then add the new copy in `,
      external(me.links.manageInstall, "the app settings"), ".");
  }

  const progress = h("span");
  progress.style.width = `${(doneCount / 4) * 100}%`;

  render(
    h("div", {},
      h("p", { class: "eyebrow" }, "One-time setup"),
      h("h1", {}, hasRepo ? "Last step: your HKU login" : "Let's set up your booker"),
      h("p", { class: "lede" }, "About five minutes. You'll go back and forth to GitHub twice."),
      h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 4, "aria-valuenow": doneCount }, progress),
      h("p", { class: "progress-label" }, `${doneCount} of 4 done`),
    ),
    problem,
    h("div", { class: "card" }, step(1, "done", `Signed in as ${me.login}`)),
    h("div", { class: "card" },
      step(2, hasRepo ? "done" : "current", "Make your own private copy",
        h("ol", {},
          h("li", {}, "Press the button. GitHub opens in a new tab."),
          h("li", {}, "Keep the name ", h("b", {}, "hku-room-booker"), " and keep it ", h("b", {}, "Private"), "."),
          h("li", {}, "Press the green ", h("b", {}, "Create repository"), " button, then come back to this tab."),
        ),
        external(me.links.template, "Create my copy on GitHub", "btn"),
      ),
    ),
    h("div", { class: "card" },
      step(3, hasRepo ? "done" : "current", "Connect the booker app to it",
        h("ol", {},
          h("li", {}, "Press the button."),
          h("li", {}, "Choose ", h("b", {}, "Only select repositories"), " and pick ", h("b", {}, "hku-room-booker"), "."),
          h("li", {}, "Press ", h("b", {}, "Install"), ". GitHub brings you straight back here."),
        ),
        h("div", { class: "row" },
          h("a", { class: "btn", href: me.links.install }, "Connect the app"),
          h("button", { class: "btn ghost", onclick: () => start() }, "Done it? Check again"),
        ),
      ),
    ),
    h("div", { class: "card" },
      step(4, hasRepo ? "current" : "todo", "Save your HKU login", credentialsForm(me, () => start())),
    ),
  );
}

function credentialsForm(me, onSaved) {
  const uid = h("input", { id: "uid", type: "text", autocomplete: "username", placeholder: "u3123456", required: true, spellcheck: "false", autocapitalize: "off" });
  const pin = h("input", { id: "pin", type: "password", autocomplete: "current-password", required: true });
  const out = h("div");
  const submit = h("button", { class: "btn", type: "submit" }, lockIcon(), "Encrypt and save");
  return h("form", {
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
      "Encrypted on this device, then saved as a secret in ", me.repo?.full_name || "your copy", ". Nobody, including this site, can read it back."),
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", { class: "field-label", for: "uid" }, "HKU UID"), uid,
        h("div", { class: "hint" }, "The part before @connect.hku.hk")),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "pin" }, "HKU PIN"), pin,
        h("div", { class: "hint" }, "The password you use for HKU Portal")),
    ),
    submit,
    out,
  );
}

// ---- Booking form ----

function bookingForm(onBooked) {
  const today = hktToday();
  const state = { date: tonightTarget(), time: "10:00", duration: config.maxDuration, room: "chi_wah_study_rooms" };

  // Dates: the next 14 days as chips, plus a picker for later dates.
  const strip = h("div", { class: "date-strip", role: "radiogroup", "aria-label": "Date" });
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const top = i === 0 ? "Today" : i === 1 ? "Tmrw" : fmt(d, { weekday: "short" });
    strip.append(choice("date", d, d === state.date,
      h("span", { class: "chip-top" }, top),
      h("span", { class: "chip-day" }, fmt(d, { day: "numeric" })),
      h("span", { class: `chip-tag ${i <= 1 ? "now" : "later"}` }, i <= 1 ? "Now" : "00:00"),
    ));
  }
  const laterInput = h("input", { type: "date", id: "later-date", min: addDays(today, 14), max: addDays(today, 60) });
  strip.append(h("div", { class: "later-date" }, h("label", { for: "later-date" }, "Later date"), laterInput));

  // Times
  const timeGrid = h("div", { class: "time-grid", role: "radiogroup", "aria-label": "Start time" });
  for (let hr = config.firstHour; hr <= config.lastHour; hr++) {
    const v = `${String(hr).padStart(2, "0")}:00`;
    timeGrid.append(choice("time", v, v === state.time, v));
  }

  // Duration
  const durations = h("div", { class: "segmented", role: "radiogroup", "aria-label": "How long" });
  for (let d = 1; d <= config.maxDuration; d++) {
    durations.append(choice("duration", String(d), d === state.duration, d === 1 ? "1 hour" : `${d} hours`));
  }

  // Rooms: quick picks plus the full list.
  const quick = h("div", { class: "room-chips", role: "radiogroup", "aria-label": "Room" },
    QUICK_ROOMS.filter((id) => config.rooms.some((r) => r.id === id)).map((id) =>
      choice("room", id, id === state.room,
        h("span", { class: "room-name" }, roomName(id)),
        h("span", { class: "room-desc" }, id === "all_study_rooms" ? "Whatever's free, anywhere" : "Chi Wah Learning Commons"))),
  );
  const listed = new Set(ROOM_GROUPS.flatMap(([, ids]) => ids));
  const groups = [...ROOM_GROUPS, ["Other", config.rooms.map((r) => r.id).filter((id) => !listed.has(id))]];
  const roomSelect = h("select", { id: "room-select", "aria-label": "All rooms" },
    groups.filter(([, ids]) => ids.length).map(([label, ids]) =>
      h("optgroup", { label }, ids.filter((id) => config.rooms.some((r) => r.id === id)).map((id) =>
        h("option", { value: id, selected: id === state.room }, roomName(id))))),
  );

  // Preview + submit
  const preview = h("div", { class: "preview", "aria-live": "polite" });
  const submit = h("button", { class: "btn wide", type: "submit" });
  const out = h("div");

  function sync() {
    const isToday = state.date === today;
    const nowHour = Math.floor(hktSecondsIntoDay() / 3600);
    for (const input of timeGrid.querySelectorAll("input")) {
      input.disabled = isToday && Number(input.value.slice(0, 2)) <= nowHour;
    }
    for (const input of durations.querySelectorAll("input")) {
      input.disabled = state.time === "23:00" && input.value !== "1";
    }
    if (state.time === "23:00" && state.duration > 1) {
      state.duration = 1;
      durations.querySelector('input[value="1"]').checked = true;
    }
    for (const input of quick.querySelectorAll("input")) input.checked = input.value === state.room;
    roomSelect.value = state.room;
    for (const input of strip.querySelectorAll("input")) input.checked = input.value === state.date;
    if (laterInput.value !== state.date) laterInput.value = state.date > addDays(today, 13) ? state.date : "";

    const now = opensNow(state.date);
    preview.replaceChildren(h("dl", {},
      h("dt", {}, "Room"), h("dd", {}, roomName(state.room)),
      h("dt", {}, "When"), h("dd", {}, `${prettyDate(state.date)} · ${state.time}–${endTime(state.time, state.duration)}`),
      h("dt", {}, "Goes out"),
      h("dd", { class: now ? "goes-now" : "goes-later" },
        now ? "Right now (booking is already open)" : `00:00 on ${prettyDate(addDays(state.date, -1))}, automatically`),
    ));
    submit.replaceChildren(now ? "Book it now" : "Queue for midnight");
  }

  const form = h("form", {
    onchange: (e) => {
      const t = e.target;
      if (t.name === "date" || t === laterInput) { if (t.value) state.date = t.value; }
      else if (t.name === "time") state.time = t.value;
      else if (t.name === "duration") state.duration = Number(t.value);
      else if (t.name === "room" || t === roomSelect) state.room = t.value;
      sync();
    },
    onsubmit: (e) => {
      e.preventDefault();
      busy(submit, out, async () => {
        const res = await api("/api/bookings", {
          date: state.date, time: state.time, duration: state.duration, room_target: state.room,
        });
        out.replaceChildren(h("div", { class: "notice ok", role: "status" }, res.message));
        onBooked();
      });
    },
  },
    h("div", { class: "section-label" }, "Day"), strip,
    h("div", { class: "section-label" }, "Start time"), timeGrid,
    h("div", { class: "section-label" }, "How long"), durations,
    h("div", { class: "section-label" }, "Where"), quick,
    h("label", { class: "field-label", for: "room-select" }, "Or pick from every room type"), roomSelect,
    preview,
    submit,
    out,
  );
  sync();
  return form;
}

// ---- Bookings ----

const STAMPS = {
  pending: ["Queued", "queued"],
  booked: ["Booked", "booked"],
  failed: ["Failed", "bad"],
  unavailable: ["No room", "bad"],
  invalid: ["Invalid", "bad"],
  login_failed: ["Login failed", "bad"],
  expired: ["Missed", "muted"],
  cancelled: ["Cancelled", "muted"],
};

function slip(b, reload) {
  const [label, cls] = STAMPS[b.status] || [b.status, "muted"];
  const out = h("div");
  const cancel = b.status === "pending" && b.date >= hktToday()
    ? h("button", {
      class: "btn danger small",
      "aria-label": `Cancel booking on ${prettyDate(b.date)} at ${b.time}`,
      onclick: (e) => busy(e.currentTarget, out, async () => {
        await api("/api/bookings/cancel", { id: b.id });
        reload();
      }),
    }, "Cancel")
    : null;
  return h("article", { class: "slip" },
    h("div", { class: "slip-date" },
      h("span", { class: "wd" }, fmt(b.date, { weekday: "short" })),
      h("span", { class: "d" }, fmt(b.date, { day: "numeric" })),
      h("span", { class: "m" }, fmt(b.date, { month: "short" })),
    ),
    h("div", { class: "slip-main" },
      h("div", { class: "slip-time" }, `${b.time}–${endTime(b.time, Number(b.duration) || 1)}`),
      h("div", { class: "slip-room" }, roomName(b.room_target || b.room_type)),
      b.status === "pending" && !opensNow(b.date)
        ? h("div", { class: "slip-note" }, `Goes out 00:00 ${prettyDate(addDays(b.date, -1))}`)
        : null,
      b.last_error && b.status !== "booked" ? h("div", { class: "slip-note" }, b.last_error) : null,
      out,
    ),
    h("div", { class: "slip-side" }, h("span", { class: `stamp ${cls}` }, label), cancel),
  );
}

function bookingsView(data, reload) {
  const target = tonightTarget();
  const pending = data.bookings.filter((b) => b.status === "pending").sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const tonight = pending.filter((b) => b.date <= target);
  const upcoming = pending.filter((b) => b.date > target);
  const history = data.bookings.filter((b) => b.status !== "pending")
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 8);

  if (data.bookings.length === 0) {
    return h("div", { class: "empty" }, h("b", {}, "Nothing queued yet"), "Pick a day above and it shows up here.");
  }
  const section = (label, items) => items.length
    ? [h("div", { class: "section-label" }, label), items.map((b) => slip(b, reload))]
    : [];
  return h("div", {},
    section("Going out tonight", tonight),
    section("Upcoming", upcoming),
    section("History", history),
  );
}

function activityView(data) {
  if (data.runs.length === 0) return h("p", { class: "muted small" }, "No runs yet.");
  const what = { workflow_dispatch: "Book now", schedule: "Nightly run (backup)", repository_dispatch: "Nightly run" };
  return h("ul", { class: "log" }, data.runs.map((r) => {
    const state = r.status === "completed" ? r.conclusion : "running";
    const label = { success: "Done", failure: "Failed", running: "Running", cancelled: "Cancelled", skipped: "Skipped" }[state] || state;
    return h("li", {},
      h("span", { class: `dot ${state}`, "aria-hidden": "true" }),
      h("div", {},
        h("div", {}, `${what[r.event] || r.event} · ${label}`),
        h("time", { datetime: r.created_at },
          new Date(r.created_at).toLocaleString("en-GB", { timeZone: HKT, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
      ),
      external(r.html_url, "Log", "small"),
    );
  }));
}

// ---- Dashboard ----

function countdownBand() {
  const clock = h("div", { class: "clock", role: "timer", "aria-label": "Time until booking opens" });
  const sub = h("p", { class: "band-sub" });
  const pill = h("div", { class: "tonight-pill" }, h("span", { class: "dot" }), h("span", {}, "Checking tonight's queue…"));

  function tick() {
    const left = 86400 - hktSecondsIntoDay();
    const hh = String(Math.floor(left / 3600)).padStart(2, "0");
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
    const ss = String(left % 60).padStart(2, "0");
    clock.textContent = `${hh}:${mm}:${ss}`;
    sub.replaceChildren("At 00:00 HKT, booking opens for ", h("b", {}, prettyDate(tonightTarget())), ".");
  }
  function setTonight(count) {
    pill.classList.toggle("on", count > 0);
    pill.lastChild.textContent = count === 0
      ? "Nothing queued for tonight"
      : `${count} booking${count > 1 ? "s" : ""} going out tonight`;
  }

  const node = h("div", { class: "countdown" },
    h("div", {}, h("p", { class: "eyebrow" }, "Next booking window opens in"), clock, sub),
    pill,
  );
  return { node, tick, setTonight };
}

function dashboard(me) {
  const bookingsBox = h("div", {}, h("p", { class: "muted small" }, "Loading…"));
  const activityBox = h("div", {}, h("p", { class: "muted small" }, "Loading…"));
  const countdown = countdownBand();

  async function reload() {
    try {
      const data = await api("/api/bookings");
      bookingsBox.replaceChildren(bookingsView(data, reload));
      activityBox.replaceChildren(activityView(data));
      const target = tonightTarget();
      countdown.setTonight(data.bookings.filter((b) => b.status === "pending" && b.date <= target).length);
    } catch (err) {
      bookingsBox.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  }

  const credsBox = h("div");
  render(
    countdown.node,
    h("section", { class: "card", "aria-labelledby": "new-booking" },
      h("h2", { id: "new-booking" }, "New booking"),
      bookingForm(reload),
    ),
    h("section", { class: "card", "aria-labelledby": "my-bookings" },
      h("h2", { id: "my-bookings" }, "My bookings"),
      bookingsBox,
    ),
    h("section", { class: "card", "aria-labelledby": "activity" },
      h("h2", { id: "activity" }, "Activity"),
      h("p", { class: "small muted" }, "Every attempt runs in your own GitHub copy. Open a log to see exactly what happened."),
      activityBox,
    ),
    h("details", { class: "card settings" },
      h("summary", {}, "Account and HKU login"),
      h("p", {}, h("button", {
        class: "btn ghost small",
        onclick: () => credsBox.replaceChildren(credentialsForm(me, () => {
          credsBox.replaceChildren(h("div", { class: "notice ok" }, "HKU login updated."));
        })),
      }, "Change my saved HKU login")),
      credsBox,
      h("p", { class: "small muted" },
        "Your copy: ", external(me.repo.html_url, me.repo.full_name), ". To stop using the booker, ",
        external(me.links.manageInstall, "uninstall the app"), " and delete your copy."),
    ),
  );

  countdown.tick();
  clockTimer = setInterval(countdown.tick, 1000);
  reload();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 30_000);
}

function showAccount(me) {
  account.replaceChildren(
    ...(me.avatar ? [h("img", { src: me.avatar, alt: "" })] : []),
    h("span", {}, me.login),
    h("button", {
      class: "btn text small",
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
    render(null, h("div", { class: "notice bad" }, err.message),
      h("button", { class: "btn ghost", onclick: () => start() }, "Try again"));
  }
}

if (location.search) history.replaceState(null, "", location.pathname + (location.search.includes("error=") ? location.search : ""));
start();
