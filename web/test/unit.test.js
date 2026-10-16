import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { appJwt } from "../src/github.js";
import { seal, unseal } from "../src/session.js";
import { validateBooking, newQueueEntry } from "../src/bookings.js";

test("app JWT signs with a GitHub-style PKCS#1 key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  assert.match(pem, /BEGIN RSA PRIVATE KEY/);
  const jwt = await appJwt({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem });
  const [h, p, s] = jwt.split(".");
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  assert.ok(ok);
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "123");
});

test("app JWT accepts PKCS#8 keys and escaped newlines", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\n");
  assert.equal((await appJwt({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem })).split(".").length, 3);
});

test("session cookie round-trips and rejects tampering", async () => {
  const secret = "x".repeat(40);
  const token = await seal({ t: "ghu_abc", login: "student" }, secret);
  assert.deepEqual(await unseal(token, secret), { t: "ghu_abc", login: "student" });
  assert.equal(await unseal(token.slice(0, -2) + "AA", secret), null);
  assert.equal(await unseal(token, "y".repeat(40)), null);
});

test("booking validation mirrors queue_booking.py", () => {
  const now = new Date("2026-10-16T15:30:00Z"); // 23:30 HKT on Oct 16
  const ok = { date: "2026-10-20", time: "10:00", duration: 2, room_target: "chi_wah_study_rooms" };
  assert.equal(validateBooking(ok, now).request.mode, "queue");
  assert.equal(validateBooking({ ...ok, date: "2026-10-17" }, now).request.mode, "now");
  assert.equal(validateBooking({ ...ok, date: "2026-10-16" }, now).request.mode, "now");
  assert.match(validateBooking({ ...ok, date: "2026-10-15" }, now).error, /passed/);
  assert.match(validateBooking({ ...ok, time: "10:30" }, now).error, /on the hour/);
  assert.match(validateBooking({ ...ok, time: "07:00" }, now).error, /on the hour/);
  assert.match(validateBooking({ ...ok, duration: 3 }, now).error, /Duration/);
  assert.match(validateBooking({ ...ok, time: "23:00" }, now).error, /midnight/);
  assert.match(validateBooking({ ...ok, room_target: "nope" }, now).error, /room type/);
  const entry = newQueueEntry(validateBooking(ok, now).request, now);
  assert.equal(entry.id, "2026-10-20-10:00-chi_wah_study_rooms-20261016233000");
  assert.equal(entry.created_at, "2026-10-16T23:30:00+08:00");
  assert.equal(entry.status, "pending");
});
