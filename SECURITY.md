# Security Policy

## Threat model

Remote Codex assumes:

- the phone can be lost, compromised, or used on an untrusted network
- the relay can be internet-facing and should not be trusted with plaintext project data
- the desktop machine is the trust anchor

## Current protections

- Pairing requires both a session ID and a high-entropy secret.
- Sessions expire automatically.
- All post-pairing payloads are encrypted end-to-end between desktop and phone.
- The relay only sees session metadata and encrypted envelope blobs.
- Remote file access is limited to the current VS Code workspace.
- Remote commands are exact strings from a local allowlist.
- Remote Codex execution uses `codex exec -s read-only`.
- Patch application requires a local desktop click in the VS Code extension.
- Git patch application is checked before apply.

## Operational guidance

- Keep the relay on `HOST=127.0.0.1` unless you explicitly need LAN or internet access.
- Serve the relay over `wss://`.
- Do not expose the development mobile server directly on the public internet.
- Keep the command allowlist read-only.
- Do not set all permissions to `allow` unless the desktop is otherwise isolated.
- Rotate relay deployments normally; there is no persistent relay-side session storage in this version.

## Known limitations

- The relay is currently single-instance and in-memory.
- The extension currently models terminal access as allowlisted inspection commands, not arbitrary live terminal mirroring.
- A local user with direct access to the desktop can still approve and apply unsafe patches; this project protects against remote misuse, not malicious local operators.

## Reporting

Open a private security report through GitHub security advisories if you find a vulnerability that could expose local workspace data or permit unintended command execution.
