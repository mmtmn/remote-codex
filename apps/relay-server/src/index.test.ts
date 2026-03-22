import { describe, expect, it } from "vitest";

import { createKeyPair, decryptPayload, deriveSharedKey, encryptPayload } from "@remote-codex/protocol";

describe("relay assumptions", () => {
  it("supports end-to-end encrypted envelopes without relay access to plaintext", () => {
    const desktop = createKeyPair();
    const mobile = createKeyPair();
    const relayVisibleEnvelope = encryptPayload(deriveSharedKey(mobile.publicKey, desktop.secretKey), {
      type: "requestSnapshot"
    });

    expect(relayVisibleEnvelope.ciphertext).not.toContain("requestSnapshot");
    expect(
      decryptPayload(deriveSharedKey(desktop.publicKey, mobile.secretKey), relayVisibleEnvelope.nonce, relayVisibleEnvelope.ciphertext)
    ).toEqual({ type: "requestSnapshot" });
  });
});
