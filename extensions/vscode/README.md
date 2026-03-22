# Remote Codex Relay

Remote Codex Relay is a VS Code companion extension that lets your phone pair with the current VS Code session through a secure relay.

It depends on the official OpenAI VS Code extension (`openai.chatgpt`) and adds:

- encrypted pairing for the phone client
- workspace snapshot and diff streaming
- explicit local patch review and apply
- narrow relay hooks into the real Codex UI:
  - open Codex sidebar
  - start a new Codex thread
  - add the active selection to the current Codex thread
  - add the active file to the current Codex thread

Install the relay server and mobile client from the repository root, then package this extension with:

```bash
pnpm package:extension
code --install-extension dist/remote-codex-relay.vsix --force
```

Run `Remote Codex: Start Session` from regular VS Code after the relay and mobile client are running.
