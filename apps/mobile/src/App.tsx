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

function readHashParams(): { relayUrl: string; sessionId: string; pairingSecret: string } {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return {
    relayUrl: params.get("relayUrl") ?? "ws://127.0.0.1:8787",
    sessionId: params.get("sessionId") ?? "",
    pairingSecret: params.get("pairingSecret") ?? ""
  };
}

export function App() {
  const initialHash = useMemo(() => readHashParams(), []);
  const [relayUrl, setRelayUrl] = useState(initialHash.relayUrl);
  const [sessionId, setSessionId] = useState(initialHash.sessionId);
  const [pairingSecret, setPairingSecret] = useState(initialHash.pairingSecret);
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

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Remote Codex</p>
          <h1>Relay your desktop coding context to your phone without handing over the keys.</h1>
          <p className="lede">
            The relay only forwards encrypted payloads. Workspace reads can be allowed, asked, or denied. Patch application
            still requires a local VS Code click.
          </p>
        </div>
        <div className={`status-card status-${phase}`}>
          <span className="status-label">{phase}</span>
          <p>{statusMessage}</p>
        </div>
      </section>

      <section className="card">
        <h2>Pairing</h2>
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
            Refresh Snapshot
          </button>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <div className="card-header">
            <h2>Workspace</h2>
            <button className="ghost" onClick={() => requestGitDiff()}>
              Repo Diff
            </button>
          </div>
          {snapshot ? (
            <>
              <p className="meta">
                Active file: <strong>{snapshot.activeFile ?? "None"}</strong>
              </p>
              <pre>{snapshot.gitStatus || "No git status output."}</pre>
              <div className="pill-row">
                {snapshot.visibleFiles.map((file) => (
                  <button key={file.path} className="pill" onClick={() => requestFile(file.path)}>
                    {file.path}
                  </button>
                ))}
              </div>
              <div className="diagnostics">
                {snapshot.diagnostics.map((entry) => (
                  <div key={entry.path} className="diagnostic">
                    <strong>{entry.path}</strong>
                    <span>
                      {entry.errors} errors / {entry.warnings} warnings
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p>No snapshot yet.</p>
          )}
        </article>

        <article className="card">
          <div className="card-header">
            <h2>File Preview</h2>
            {selectedFile ? (
              <button className="ghost" onClick={() => requestGitDiff(selectedFile.path)}>
                Diff This File
              </button>
            ) : null}
          </div>
          <p className="meta">{selectedFile?.path ?? "Pick a visible file from the workspace card."}</p>
          <pre>{selectedFile?.content ?? "No file selected."}</pre>
        </article>
      </section>

      <section className="grid">
        <article className="card">
          <div className="card-header">
            <h2>Inspection Commands</h2>
          </div>
          {commands.length > 0 ? (
            <div className="pill-row">
              {commands.map((command) => (
                <button key={command} className="pill" onClick={() => runCommand(command)}>
                  {command}
                </button>
              ))}
            </div>
          ) : (
            <p>No commands advertised by the desktop yet.</p>
          )}
          <pre>{gitDiff || "Request a repo or file diff to inspect changes."}</pre>
        </article>

        <article className="card">
          <div className="card-header">
            <h2>Official Codex</h2>
          </div>
          <p className="meta">Trigger the installed Codex extension on the desktop without exposing arbitrary VS Code commands.</p>
          <div className="pill-row">
            <button className="pill" onClick={() => requestCodexUi("openSidebar")}>
              Open Sidebar
            </button>
            <button className="pill" onClick={() => requestCodexUi("newThread")}>
              New Thread
            </button>
            <button className="pill" onClick={() => requestCodexUi("addSelection")}>
              Add Selection
            </button>
            <button className="pill" onClick={() => requestCodexUi("addFile")}>
              Add File
            </button>
          </div>
          <p className="meta">The selection and file actions use the active editor on the desktop and still respect local permission prompts.</p>
        </article>

        <article className="card">
          <div className="card-header">
            <h2>Run Codex</h2>
            {proposal ? <button onClick={requestPatchApply}>Request Apply</button> : null}
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the change you want the desktop Codex instance to propose."
          />
          <div className="actions">
            <button onClick={submitPrompt}>Send Prompt</button>
          </div>
          {proposal ? (
            <>
              <p className="meta">{proposal.summary}</p>
              <pre>{proposal.patch || "Codex did not propose a patch."}</pre>
            </>
          ) : (
            <p>No proposal yet.</p>
          )}
        </article>
      </section>

      <section className="card">
        <h2>Event Feed</h2>
        <div className="event-list">
          {events.map((event) => (
            <div key={event.id} className="event">
              <strong>{event.label}</strong>
              <span>{event.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
