# Remote Codex

Use Codex from your phone, either by streaming the real VS Code window to the browser or by using the relay controls, without turning your desktop into an unaudited remote shell.

This repository ships three pieces:

- `extensions/vscode`: the trusted desktop companion extension inside regular VS Code
- `apps/relay-server`: a self-hostable websocket relay that only brokers session setup and encrypted envelopes
- `apps/mobile`: an Android-friendly browser client that can either render a real desktop stream or fall back to the relay control surface

The stream path is the closest match to the actual Codex extension UI because it renders the real desktop session. The relay path is still available when you want explicit workspace controls instead of a raw remote display.

## Why this shape

The safest usable flow is read-first:

1. The VS Code extension creates a short-lived pairing session and shows a QR code.
2. The phone joins through the relay with the session ID and secret.
3. The desktop and phone derive a shared key and encrypt all workspace/prompt traffic end-to-end.
4. The phone can inspect workspace state, visible files, diagnostics, git diffs, and allowlisted inspection commands.
5. The phone can trigger a narrow set of official Codex UI actions on the desktop: open Codex, start a new Codex thread, add the active selection, or add the active file.
6. The phone can ask the desktop to run local `codex exec` in read-only mode.
7. Codex returns a patch proposal.
8. The desktop user still has to click `Apply Patch` locally in VS Code before anything touches the repository.

The relay never decrypts file contents, diffs, prompts, or patch proposals.

## Security defaults

- Pairing sessions expire after 15 minutes by default.
- Relay joins require a session ID plus pairing secret.
- Desktop-to-phone payloads are NaCl-encrypted end-to-end after pairing.
- Workspace reads, Codex execution, inspection commands, and patch review requests each have independent `allow | ask | deny` controls.
- Official Codex UI actions are also behind their own `allow | ask | deny` permission.
- Remote commands are exact-match allowlist entries only.
- Codex runs in `read-only` sandbox mode and returns a patch proposal instead of editing the workspace directly.
- Patch application is always a local action in VS Code.

Read [SECURITY.md](./SECURITY.md) before exposing the relay to the internet.

## Quickstart

### 1. Install dependencies

```bash
pnpm install
```

### 2. Stream the real desktop Codex UI

If you want the actual VS Code and Codex window on your phone, use the stream mode:

```bash
pnpm stream
```

That command starts the relay and browser viewer, enables the built-in VNC proxy, and prints the phone URL to open.

If the machine has more than one active network interface, the CLI will print multiple candidate phone URLs. Use the one that matches the network your phone is actually on. If you want to force one, pass `--mobile-host`, for example:

```bash
pnpm stream -- --mobile-host <phone-reachable-host>
```

On Linux/X11, it will also auto-start `x11vnc` when that helper is installed. If you do not already have it:

```bash
sudo apt install x11vnc
```

Open VS Code locally, open the Codex sidebar, then open the printed phone URL in the browser on your phone.

Do not open that stream URL in a browser on the same desktop session you are capturing. That creates a recursive screen-within-screen feedback loop and can overwhelm the local desktop. If you need a quick local test, use a second device, a second monitor that is not being mirrored back into the captured area, or a different remote viewer setup.

If you already have your own VNC server, point the stream mode at it instead:

```bash
pnpm stream -- --vnc-host 127.0.0.1 --vnc-port 5900 --no-x11vnc
```

### 3. Start the relay console instead

Use one terminal if you want the repo to launch both long-running services for you:

```bash
pnpm start
```

That command starts:

- the relay on `ws://0.0.0.0:8787`
- the mobile web client on `http://0.0.0.0:4173`

If you want a plain shell command in your `PATH`, link the repo once and then run the CLI directly:

```bash
npm link
remote-codex start
```

If you prefer separate terminals, the individual commands are still:

```bash
HOST=0.0.0.0 PORT=8787 pnpm --filter @remote-codex/relay-server dev
pnpm --filter @remote-codex/mobile dev
```

Inside the repo, the simplest command is `pnpm start`. The VS Code command palette command is `Remote Codex: Start Session`.

### 4. Relay details

```bash
HOST=0.0.0.0 PORT=8787 pnpm --filter @remote-codex/relay-server dev
```

This now runs the relay without file watching, which avoids the common Linux `ENOSPC` inotify limit crash during first-run setup.

For the phone-on-LAN setup, the relay must be reachable from the phone, so the quickstart uses `HOST=0.0.0.0`.

If you want automatic reloads while developing the relay itself, use:

```bash
pnpm --filter @remote-codex/relay-server dev:watch
```

If `dev:watch` fails with `ENOSPC`, either keep using `dev` or raise your inotify watcher limit:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/99-remote-codex.conf
echo fs.inotify.max_user_instances=1024 | sudo tee -a /etc/sysctl.d/99-remote-codex.conf
sudo sysctl --system
```

### 5. Mobile client details

```bash
pnpm --filter @remote-codex/mobile dev
```

This now builds once and serves a static preview on `0.0.0.0:4173`, so it works on Linux systems that cannot spare more file watchers.

If you want Vite hot reload while developing the mobile app itself, use:

```bash
pnpm --filter @remote-codex/mobile dev:watch
```

If `dev:watch` fails with `ENOSPC`, either keep using `dev` or raise your inotify watcher limit with the same sysctl values shown above.

Open the served mobile URL on your phone, or deploy the built `apps/mobile/dist` bundle to any static host.

### 6. Package and install the VS Code companion extension

```bash
pnpm package:extension
code --install-extension dist/remote-codex-relay.vsix --force
```

The packaged extension depends on the official OpenAI VS Code extension (`openai.chatgpt`). Install that first if you do not already have it.

### 7. Start a session from regular VS Code

1. Open the repository you actually want to work on in regular VS Code.
2. Set these settings if the auto-detected hotspot/LAN address is wrong:
   - `remoteCodex.relayUrl`
   - `remoteCodex.mobileUrl`
   - `remoteCodex.mobileRelayUrl`
3. Open the Command Palette in VS Code and run `Remote Codex: Start Session`.
4. Scan the QR code from the phone client.

Do not type `Remote Codex: Start Session` into a shell. That is a VS Code command, not a terminal command.

The extension will auto-derive LAN-friendly pairing URLs when possible. If it guesses the wrong interface because of VPNs or multiple NICs, set `remoteCodex.mobileUrl` and `remoteCodex.mobileRelayUrl` manually.

### 8. Remote workflow

From the phone you can:

- refresh the workspace snapshot
- open visible files
- inspect repo or file diffs
- run allowlisted inspection commands
- trigger the official Codex sidebar, a new Codex thread, or add the active selection/file to the current Codex thread
- submit a remote Codex prompt
- request local review/apply for the proposed patch

From the desktop you control:

- relay URL
- mobile client URL
- per-action permission modes
- exact command allowlist
- optional Codex model override / extra CLI args

All extension settings live under `remoteCodex.*`.

## Network and firewall setup

By default the relay is local-only:

```bash
HOST=127.0.0.1 PORT=8787 pnpm --filter @remote-codex/relay-server dev
```

That mode does not need `ufw` or `iptables` changes.

If you intentionally want LAN or public access, bind the relay to `0.0.0.0` or a specific interface IP:

```bash
HOST=0.0.0.0 PORT=8787 pnpm --filter @remote-codex/relay-server dev
```

Then verify the firewall path on Linux:

```bash
pnpm doctor:linux-firewall
```

If you also serve the mobile preview from your desktop, you may need to check port `4173` too:

```bash
HOST=0.0.0.0 PORT=4173 pnpm doctor:linux-firewall
```

Typical commands if you mean to expose TCP `8787`:

```bash
sudo ufw allow 8787/tcp
sudo iptables -I INPUT -p tcp --dport 8787 -j ACCEPT
```

Only do that for a relay you actually intend to expose. For internet-facing use, put it behind TLS and a reverse proxy and prefer a specific allowlist of source networks where possible.

## Production notes

- Put the relay behind TLS before using it outside a trusted network.
- Keep the default `HOST=127.0.0.1` unless you explicitly need remote access.
- The default mobile `dev` script is intentionally no-watch; use `dev:watch` only when you actually need HMR.
- Treat the mobile client as untrusted for writes. Keep `remoteCodex.permissions.applyPatch` on `ask`.
- Do not add shell pipelines, redirects, or mutation commands to `remoteCodex.commandAllowlist`.
- Keep the relay ephemeral. This implementation stores sessions in memory and is meant for a single instance.
- If you need horizontal scaling, replace the in-memory session registry with a shared store/pubsub layer before running multiple relay instances.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

If you are developing the companion extension itself, the old extension-host loop is still available:

```bash
code extensions/vscode
```

Then press `F5` inside that extension workspace to launch an Extension Development Host.

## Current scope

This is a secure companion for the real Codex VS Code extension, not an unsupported deep fork of its private internals. The relay now drives the public OpenAI/Codex VS Code commands where available, but patch proposal generation still uses the local `codex` CLI in read-only mode because the official extension does not expose a stable prompt-and-patch API for third parties.
