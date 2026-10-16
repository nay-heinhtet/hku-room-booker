// libsodium crypto_box_seal, which GitHub requires for Actions secrets,
// built from tweetnacl + blake2b so it runs in the browser without WASM.
// The plaintext never leaves the student's browser.

import nacl from "tweetnacl";
import { blake2b } from "blakejs";

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function sealBytes(message, recipientPublicKey) {
  const ephemeral = nacl.box.keyPair();
  const nonce = blake2b(concat(ephemeral.publicKey, recipientPublicKey), undefined, nacl.box.nonceLength);
  const boxed = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  return concat(ephemeral.publicKey, boxed);
}

export function sealSecret(value, publicKeyB64) {
  return toBase64(sealBytes(new TextEncoder().encode(value), fromBase64(publicKeyB64)));
}
