import test from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers";
import { sealSecret } from "../client/seal.js";

test("sealed box opens with libsodium (GitHub's format)", async () => {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pkB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  for (const secret of ["u3123456", "pässwörd with spaces & symbols!"]) {
    const sealed = sodium.from_base64(sealSecret(secret, pkB64), sodium.base64_variants.ORIGINAL);
    const opened = sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey);
    assert.equal(sodium.to_string(opened), secret);
  }
});
