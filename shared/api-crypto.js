// Decrypt API responses (AES-256-GCM, matches keka-hours-tracker-api/lib/crypto.js)

async function decryptApiPayload(base64Payload, hexKey) {
  if (!hexKey || hexKey.length < 64) {
    throw new Error("API_RESPONSE_KEY not configured in config.js");
  }

  const raw = Uint8Array.from(atob(base64Payload), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const ciphertext = raw.slice(28);
  const cipherWithTag = new Uint8Array(ciphertext.length + tag.length);
  cipherWithTag.set(ciphertext);
  cipherWithTag.set(tag, ciphertext.length);

  const keyBytes = new Uint8Array(
    hexKey.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipherWithTag,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function unwrapApiResponse(raw) {
  if (raw?.encrypted && raw.payload) {
    if (typeof API_ENCRYPTED_RESPONSES !== "undefined" && !API_ENCRYPTED_RESPONSES) {
      return raw;
    }
    const inner = await decryptApiPayload(raw.payload, API_RESPONSE_KEY);
    return { success: raw.success !== false, ...inner };
  }
  return raw;
}
