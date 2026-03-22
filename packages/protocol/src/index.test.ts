import { describe, expect, it } from "vitest";

import {
  createKeyPair,
  decryptPayload,
  deriveSharedKey,
  encryptPayload,
  generatePairingSecret,
  generateSessionId
} from "./index.js";

describe("protocol helpers", () => {
  it("creates short human-friendly session tokens", () => {
    expect(generateSessionId()).toMatch(/^[A-Z2-9]{12}$/);
    expect(generatePairingSecret()).toMatch(/^[A-Z2-9]{24}$/);
  });

  it("round-trips encrypted payloads across peers", () => {
    const desktop = createKeyPair();
    const mobile = createKeyPair();

    const desktopShared = deriveSharedKey(mobile.publicKey, desktop.secretKey);
    const mobileShared = deriveSharedKey(desktop.publicKey, mobile.secretKey);

    const encrypted = encryptPayload(desktopShared, {
      type: "notification",
      level: "info",
      message: "hello"
    });

    expect(decryptPayload(mobileShared, encrypted.nonce, encrypted.ciphertext)).toEqual({
      type: "notification",
      level: "info",
      message: "hello"
    });
  });
});
