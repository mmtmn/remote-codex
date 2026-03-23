import { useEffect, useMemo, useRef, useState } from "react";

import {
  type CodexPatchProposal,
  type CodexUiAction,
  createKeyPair,
  decryptPayload,
  deriveSharedKey,
  encryptPayload,
  RelayOutgoingSchema,
  type WorkspaceSnapshot
} from "@remote-codex/protocol";
import { StreamViewer } from "./StreamViewer";

type ConnectionPhase = "idle" | "connecting" | "connected" | "error";

interface AppEvent {
  id: string;
  label: string;
  detail: string;
}

interface SessionState {
  socket: WebSocket;
  sessionId: string;
  sharedKey: Uint8Array;
}

function readLocationParams(): {
  mode: string;
  relayUrl: string;
  sessionId: string;
  pairingSecret: string;
  title: string;
  vncUrl: string;
} {
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const pick = (key: string, fallback = "") => searchParams.get(key) ?? hashParams.get(key) ?? fallback;

  return {
    mode: pick("mode"),
    relayUrl: pick("relayUrl", "ws://127.0.0.1:8787"),
    sessionId: pick("sessionId"),
    pairingSecret: pick("pairingSecret"),
    title: pick("title", "VS Code / Codex"),
    vncUrl: pick("vncUrl")
  };
}

export function App() {
  const initialParams = useMemo(() => readLocationParams(), []);
  const [relayUrl, setRelayUrl] = useState(initialParams.relayUrl);
  const [sessionId, setSessionId] = useState(initialParams.sessionId);
  const [pairingSecret, setPairingSecret] = useState(initialParams.pairingSecret);
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [statusMessage, setStatusMessage] = useState("Waiting to pair.");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const [gitDiff, setGitDiff] = useState<string>("");
  const [commands, setCommands] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [proposal, setProposal] = useState<CodexPatchProposal | null>(null);
  const sessionRef = useRef<SessionState | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.socket.close();
    };
  }, []);

  async function connect(): Promise<void> {
    if (!relayUrl || !sessionId || !pairingSecret) {
      setPhase("error");
      setStatusMessage("Relay URL, session ID, and pairing secret are required.");
      return;
    }

    sessionRef.current?.socket.close();
    setPhase("connecting");
    setStatusMessage("Opening secure relay session...");
    setSelectedFile(null);
    setGitDiff("");
    setProposal(null);

    const mobileKeys = createKeyPair();
    const socket = new WebSocket(relayUrl);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "joinMobile",
          sessionId,
          pairingSecret,
          mobilePublicKey: mobileKeys.publicKey
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const parsed = RelayOutgoingSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) {
        pushEvent("Relay", "Received an invalid message from the relay.");
        return;
      }

      switch (parsed.data.type) {
        case "joined": {
          const sharedKey = deriveSharedKey(parsed.data.desktopPublicKey, mobileKeys.secretKey);
          sessionRef.current = {
            socket,
            sessionId,
            sharedKey
          };
          setPhase("connected");
          setStatusMessage("Phone connected. Requesting workspace snapshot...");
          sendEncrypted({ type: "requestSnapshot" });
          break;
        }
        case "peerOffline":
          setStatusMessage("Desktop disconnected.");
          setPhase("error");
          break;
        case "error":
          setStatusMessage(parsed.data.message);
          setPhase("error");
          pushEvent("Relay", parsed.data.message);
          break;
        case "envelope": {
          if (!sessionRef.current?.sharedKey) {
            return;
          }

          try {
            const payload = decryptPayload(sessionRef.current.sharedKey, parsed.data.nonce, parsed.data.ciphertext);
            handleEncryptedPayload(payload);
          } catch (error) {
            pushEvent("Decrypt", error instanceof Error ? error.message : "Unable to decrypt the desktop payload.");
          }
          break;
        }
        case "registered":
        case "peerOnline":
          break;
      }
    });

    socket.addEventListener("close", () => {
      if (phase !== "idle") {
        setPhase("error");
        setStatusMessage("Relay connection closed.");
      }
    });

    socket.addEventListener("error", () => {
      setPhase("error");
      setStatusMessage("Unable to reach the relay server.");
    });
  }

  function handleEncryptedPayload(payload: ReturnType<typeof decryptPayload>): void {
    switch (payload.type) {
      case "snapshot":
        setSnapshot(payload.snapshot);
        pushEvent("Snapshot", `Captured ${payload.snapshot.visibleFiles.length} visible files.`);
        return;
      case "fileContent":
        setSelectedFile({ path: payload.path, content: payload.content });
        return;
      case "gitDiff":
        setGitDiff(payload.diff);
        return;
      case "commandList":
        setCommands(payload.commands);
        return;
      case "commandEvent":
        pushEvent(payload.command, payload.content || payload.status);
        return;
      case "codexUiEvent":
        pushEvent(`Codex UI ${payload.status}`, `${payload.action}: ${payload.content}`);
        return;
      case "codexRunEvent":
        pushEvent(`Codex ${payload.status}`, payload.content);
        return;
      case "patchProposal":
        setProposal(payload.proposal);
        pushEvent("Patch", payload.proposal.summary);
        return;
      case "applyPatchDecision":
        pushEvent(`Patch ${payload.status}`, payload.message);
        return;
      case "notification":
        pushEvent(payload.level.toUpperCase(), payload.message);
        return;
      case "requestSnapshot":
      case "requestFile":
      case "requestGitDiff":
      case "runCommand":
      case "codexUiRequest":
      case "codexRunRequest":
      case "applyPatchRequest":
        return;
    }
  }

  function pushEvent(label: string, detail: string): void {
    setEvents((current) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        label,
        detail
      },
      ...current
    ].slice(0, 40));
  }

  function sendEncrypted(payload: Parameters<typeof encryptPayload>[1]): void {
    const session = sessionRef.current;
    if (!session) {
      pushEvent("Relay", "Connect to a session first.");
      return;
    }

    const envelope = encryptPayload(session.sharedKey, payload);
    session.socket.send(
      JSON.stringify({
        type: "envelope",
        sessionId: session.sessionId,
        ...envelope
      })
    );
  }

  function requestFile(path: string): void {
    sendEncrypted({
      type: "requestFile",
      path
    });
  }

  function requestGitDiff(path?: string): void {
    sendEncrypted({
      type: "requestGitDiff",
      path
    });
  }

  function runCommand(command: string): void {
    sendEncrypted({
      type: "runCommand",
      command
    });
  }

  function requestCodexUi(action: CodexUiAction): void {
    sendEncrypted({
      type: "codexUiRequest",
      action
    });
  }

  function submitPrompt(): void {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    const requestId = window.crypto.randomUUID();
    sendEncrypted({
      type: "codexRunRequest",
      requestId,
      prompt: trimmed
    });
    setPrompt("");
  }

  function requestPatchApply(): void {
    if (!proposal) {
      return;
    }

    sendEncrypted({
      type: "applyPatchRequest",
      requestId: proposal.requestId
    });
  }

  const visibleFiles = snapshot?.visibleFiles ?? [];
  const diagnostics = snapshot?.diagnostics ?? [];
  const timeline = [...events].reverse();
  const relayMode =
    initialParams.mode === "relay" ||
    initialParams.mode === "pair" ||
    !!initialParams.sessionId ||
    !!initialParams.pairingSecret;
  const streamMode = !relayMode;

  if (streamMode) {
    return <StreamViewer initialTitle={initialParams.title} initialVncUrl={initialParams.vncUrl} />;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <p className="app-kicker">Remote Codex</p>
          <h1>Codex Relay Console</h1>
          <p className="app-summary">
            A phone-side control surface for the desktop Codex extension. Pair once, then drive the real desktop thread,
            inspect context, and review proposed patches without exposing arbitrary shell access.
          </p>
        </div>
        <div className={`status-strip status-${phase}`}>
          <span className="status-label">{phase}</span>
          <p>{statusMessage}</p>
        </div>
      </header>

      <section className="workspace-frame">
        <aside className="rail rail-left">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Session</p>
                <h2>Pair Desktop</h2>
              </div>
            </div>
            <label>
              Relay URL
              <input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="ws://127.0.0.1:8787" />
            </label>
            <label>
              Session ID
              <input value={sessionId} onChange={(event) => setSessionId(event.target.value.toUpperCase())} />
            </label>
            <label>
              Pairing Secret
              <input value={pairingSecret} onChange={(event) => setPairingSecret(event.target.value.toUpperCase())} />
            </label>
            <div className="actions">
              <button onClick={connect}>Connect</button>
              <button className="ghost" onClick={() => sendEncrypted({ type: "requestSnapshot" })}>
                Refresh
              </button>
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Desktop Context</p>
                <h2>Workspace Mirror</h2>
              </div>
              <button className="ghost" onClick={() => requestGitDiff()}>
                Repo Diff
              </button>
            </div>
            {snapshot ? (
              <>
                <p className="panel-meta">
                  Active file: <strong>{snapshot.activeFile ?? "None"}</strong>
                </p>
                <pre className="compact-pre">{snapshot.gitStatus || "No git status output."}</pre>

                <div className="section-block">
                  <div className="section-header">
                    <h3>Visible Files</h3>
                    <span>{visibleFiles.length}</span>
                  </div>
                  <div className="token-grid">
                    {visibleFiles.map((file) => (
                      <button key={file.path} className="token" onClick={() => requestFile(file.path)}>
                        {file.path}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="section-block">
                  <div className="section-header">
                    <h3>Diagnostics</h3>
                    <span>{diagnostics.length}</span>
                  </div>
                  {diagnostics.length > 0 ? (
                    <div className="stack-list">
                      {diagnostics.map((entry) => (
                        <div key={entry.path} className="stack-item">
                          <strong>{entry.path}</strong>
                          <span>
                            {entry.errors} errors / {entry.warnings} warnings
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="panel-meta">No diagnostics pushed yet.</p>
                  )}
                </div>

                <div className="section-block">
                  <div className="section-header">
                    <h3>Allowed Commands</h3>
                    <span>{commands.length}</span>
                  </div>
                  {commands.length > 0 ? (
                    <div className="token-grid">
                      {commands.map((command) => (
                        <button key={command} className="token" onClick={() => runCommand(command)}>
                          {command}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="panel-meta">No commands advertised by the desktop yet.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="panel-meta">Connect first to mirror the current desktop workspace.</p>
            )}
          </article>
        </aside>

        <section className="center-column">
          <article className="panel thread-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Thread</p>
                <h2>Codex Relay Activity</h2>
              </div>
              <span className="panel-chip">{timeline.length} events</span>
            </div>
            <div className="message-list">
              {timeline.length > 0 ? (
                timeline.map((event) => (
                  <div key={event.id} className="message">
                    <span className="message-tag">{event.label}</span>
                    <p>{event.detail}</p>
                  </div>
                ))
              ) : (
                <div className="message empty-message">
                  <span className="message-tag">Ready</span>
                  <p>Connect to a session, open the desktop Codex sidebar, and this feed becomes your remote thread log.</p>
                </div>
              )}
            </div>
          </article>

          <article className="panel composer-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Desktop Actions</p>
                <h2>Codex Controls</h2>
              </div>
            </div>
            <div className="action-cluster">
              <button className="token" onClick={() => requestCodexUi("openSidebar")}>
                Open Sidebar
              </button>
              <button className="token" onClick={() => requestCodexUi("newThread")}>
                New Thread
              </button>
              <button className="token" onClick={() => requestCodexUi("addSelection")}>
                Add Selection
              </button>
              <button className="token" onClick={() => requestCodexUi("addFile")}>
                Add File
              </button>
            </div>
            <p className="panel-meta">
              These controls target the real desktop Codex extension. File and selection actions use the active editor on the
              desktop and still respect local approval settings.
            </p>
            <label className="composer-label">
              Prompt
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the change you want desktop Codex to propose."
              />
            </label>
            <div className="actions">
              <button onClick={submitPrompt}>Send To Desktop Codex</button>
              {proposal ? (
                <button className="ghost" onClick={requestPatchApply}>
                  Request Apply
                </button>
              ) : null}
            </div>
          </article>
        </section>

        <aside className="rail rail-right">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Mirror</p>
                <h2>Active File</h2>
              </div>
              {selectedFile ? (
                <button className="ghost" onClick={() => requestGitDiff(selectedFile.path)}>
                  Diff File
                </button>
              ) : null}
            </div>
            <p className="panel-meta">{selectedFile?.path ?? snapshot?.activeFile ?? "No file selected yet."}</p>
            <pre>{selectedFile?.content ?? "Pick a visible file from the workspace mirror to inspect it here."}</pre>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Changes</p>
                <h2>Desktop Diff</h2>
              </div>
            </div>
            <pre>{gitDiff || "Request a repo or file diff to inspect desktop changes."}</pre>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Patch</p>
                <h2>Proposal Review</h2>
              </div>
            </div>
            <p className="panel-meta">{proposal?.summary ?? "No patch proposal yet."}</p>
            <pre>{proposal?.patch || "Ask Codex for a change and its proposed patch will appear here."}</pre>
          </article>
        </aside>
      </section>
    </main>
  );
}
