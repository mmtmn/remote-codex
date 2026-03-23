import { type CSSProperties, useEffect, useRef, useState } from "react";

import { VncScreen, type VncScreenHandle } from "react-vnc";

type ViewerPhase = "idle" | "connecting" | "connected" | "disconnected" | "error";
type FocusEdge = "left" | "right";
type RfbWithInternalPointer = NonNullable<VncScreenHandle["rfb"]> & {
  _handleMouseButton?: (x: number, y: number, mask: number) => void;
};

interface StreamViewerProps {
  initialTitle: string;
  initialVncUrl: string;
}

const KEYCODES = {
  enter: { keysym: 0xff0d, code: "Enter" },
  shiftLeft: { keysym: 0xffe1, code: "ShiftLeft" }
} as const;

export function StreamViewer({ initialTitle, initialVncUrl }: StreamViewerProps) {
  const viewerRef = useRef<VncScreenHandle | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const cropRef = useRef<HTMLDivElement | null>(null);
  const [vncUrl, setVncUrl] = useState(initialVncUrl);
  const [activeUrl, setActiveUrl] = useState("");
  const [password, setPassword] = useState("");
  const [viewerKey, setViewerKey] = useState(0);
  const [phase, setPhase] = useState<ViewerPhase>(initialVncUrl ? "connecting" : "idle");
  const [statusMessage, setStatusMessage] = useState(
    initialVncUrl ? "Connecting to the desktop stream..." : "Paste a stream URL from `remote-codex stream`."
  );
  const [codexFocus, setCodexFocus] = useState(true);
  const [focusEdge, setFocusEdge] = useState<FocusEdge>("left");
  const [focusWidth, setFocusWidth] = useState(46);
  const [focusYOffset, setFocusYOffset] = useState(18);
  const [composeText, setComposeText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (initialVncUrl.trim()) {
      connect(initialVncUrl.trim());
    }

    return () => {
      disconnect(false);
    };
  }, [initialVncUrl]);

  function disconnect(updateState = true): void {
    viewerRef.current?.disconnect();
    viewerRef.current = null;
    setActiveUrl("");

    if (updateState) {
      setPhase("disconnected");
      setStatusMessage("Stream disconnected.");
    }
  }

  function getViewerOrWarn(): VncScreenHandle | null {
    const viewer = viewerRef.current;
    if (!viewer) {
      setStatusMessage("Connect the stream and keep the Codex input focused on the desktop before sending phone text.");
      return null;
    }

    return viewer;
  }

  function sendChord(keys: Array<{ keysym: number; code: string }>): void {
    const viewer = getViewerOrWarn();
    if (!viewer) {
      return;
    }

    viewer.focus();
    for (const key of keys) {
      viewer.sendKey(key.keysym, key.code, true);
    }
    for (const key of [...keys].reverse()) {
      viewer.sendKey(key.keysym, key.code, false);
    }
  }

  function primeCodexPrompt(viewer: VncScreenHandle): boolean {
    const crop = cropRef.current;
    const rfb = viewer.rfb as RfbWithInternalPointer | null;
    if (!crop || !rfb || typeof rfb._handleMouseButton !== "function") {
      return false;
    }

    const rect = crop.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return false;
    }

    const scale = codexFocus ? 100 / focusWidth : 1;
    const visibleWidth = rect.width / scale;
    const visibleHeight = rect.height / scale;
    const xStart = codexFocus && focusEdge === "right" ? rect.width - visibleWidth : 0;
    const yStart = codexFocus ? (rect.height * focusYOffset) / 100 : 0;
    const x = Math.min(rect.width - 12, Math.max(12, xStart + visibleWidth * 0.46));
    const y = Math.min(rect.height - 12, Math.max(12, yStart + visibleHeight * 0.88));

    rfb._handleMouseButton(x, y, 0x1);
    rfb._handleMouseButton(x, y, 0x0);
    return true;
  }

  function sendTextToCodex(submitAfter = false): void {
    const viewer = getViewerOrWarn();
    const text = composeText;
    if (!viewer || !text.trim() || isSending) {
      return;
    }

    const primed = primeCodexPrompt(viewer);
    setIsSending(true);
    setStatusMessage(primed ? "Focusing the Codex prompt, then sending your message..." : "Sending your message...");

    window.setTimeout(() => {
      viewer.focus();

      for (const character of text) {
        if (character === "\n") {
          sendChord([KEYCODES.shiftLeft, KEYCODES.enter]);
          continue;
        }

        const codePoint = character.codePointAt(0);
        if (!codePoint) {
          continue;
        }

        const keysym = codePoint <= 0xff ? codePoint : 0x01000000 + codePoint;
        viewer.sendKey(keysym, "");
      }

      if (submitAfter) {
        viewer.sendKey(KEYCODES.enter.keysym, KEYCODES.enter.code);
        setComposeText("");
        requestAnimationFrame(() => {
          composeRef.current?.focus();
        });
      }

      setStatusMessage(
        submitAfter
          ? "Phone keyboard text sent to Codex and submitted."
          : "Phone keyboard text typed into the focused Codex field."
      );
      setIsSending(false);
    }, primed ? 90 : 0);
  }

  function connect(nextUrl = vncUrl.trim()): void {
    if (!nextUrl) {
      setPhase("error");
      setStatusMessage("A VNC stream URL is required.");
      return;
    }

    disconnect(false);
    setPhase("connecting");
    setStatusMessage("Connecting to the desktop stream...");
    setActiveUrl(nextUrl);
    setViewerKey((current) => current + 1);
    setSettingsOpen(false);
  }

  const focusStyle = {
    "--codex-pane-width": `${focusWidth}%`,
    "--codex-focus-scale": `${100 / focusWidth}`,
    "--codex-focus-y": `${focusYOffset}%`
  } as CSSProperties;
  const settingsVisible = settingsOpen || phase !== "connected";

  return (
    <main className="stream-shell stream-shell-compact">
      <section
        className={`stream-stage stream-stage-compact${codexFocus ? ` stream-stage-focus stream-stage-focus-${focusEdge}` : ""}`}
        style={codexFocus ? focusStyle : undefined}
      >
        {phase === "connected" ? (
          <button className="stream-settings-toggle token" onClick={() => setSettingsOpen((current) => !current)}>
            {settingsOpen ? "Close" : "Setup"}
          </button>
        ) : null}
        <div className="stream-crop" ref={cropRef}>
          <div className={`stream-crop-inner${codexFocus ? ` stream-crop-inner-${focusEdge}` : ""}`}>
            <div className="stream-crop-offset">
              <div className="stream-canvas">
              {activeUrl ? (
                <VncScreen
                  key={`${viewerKey}:${activeUrl}`}
                  ref={viewerRef}
                  url={activeUrl}
                  autoConnect
                  background="#0b1016"
                  className="stream-vnc"
                  scaleViewport
                  clipViewport={false}
                  resizeSession
                  focusOnClick={false}
                  retryDuration={0}
                  style={{ width: "100%", height: "100%", minHeight: "100%" }}
                  onConnect={() => {
                    setPhase("connected");
                    setStatusMessage("Live desktop stream connected.");
                    viewerRef.current?.focus();
                  }}
                  onCredentialsRequired={() => {
                    if (password) {
                      viewerRef.current?.sendCredentials({ password });
                      setStatusMessage("Sending VNC credentials...");
                      return;
                    }

                    setPhase("error");
                    setStatusMessage("The VNC server requested a password.");
                  }}
                  onDisconnect={(event) => {
                    setPhase("disconnected");
                    setStatusMessage(event?.detail?.clean ? "Stream disconnected." : "The desktop stream closed unexpectedly.");
                  }}
                  onSecurityFailure={(event) => {
                    setPhase("error");
                    setStatusMessage(event?.detail?.status ? `Security failure: ${event.detail.status}` : "Security failure.");
                  }}
                />
              ) : null}
              </div>
            </div>
          </div>
        </div>
        {settingsVisible ? (
          <aside className="stream-settings-sheet">
            <div className={`status-strip status-${phase}`}>
              <span className="status-label">{phase}</span>
              <p>{statusMessage}</p>
            </div>
            <label>
              Stream URL
              <input
                value={vncUrl}
                onChange={(event) => setVncUrl(event.target.value)}
                placeholder="ws://desktop:8787/vnc?token=..."
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Optional VNC password"
              />
            </label>
            <div className="stream-focus-row">
              <button className="token" onClick={() => setCodexFocus((current) => !current)}>
                {codexFocus ? "Crop: On" : "Crop: Off"}
              </button>
              <button className="token" onClick={() => setFocusEdge((current) => (current === "left" ? "right" : "left"))}>
                Side: {focusEdge === "left" ? "Left" : "Right"}
              </button>
            </div>
            {codexFocus ? (
              <>
                <label className="stream-range-label">
                  Width: {focusWidth}%
                  <input
                    className="stream-range"
                    type="range"
                    min="28"
                    max="65"
                    value={focusWidth}
                    onChange={(event) => setFocusWidth(Number(event.target.value))}
                  />
                </label>
                <label className="stream-range-label">
                  Lift: {focusYOffset}%
                  <input
                    className="stream-range"
                    type="range"
                    min="0"
                    max="28"
                    value={focusYOffset}
                    onChange={(event) => setFocusYOffset(Number(event.target.value))}
                  />
                </label>
              </>
            ) : null}
            <div className="actions">
              <button onClick={() => connect()}>Connect</button>
              <button className="ghost" onClick={() => disconnect()}>
                Disconnect
              </button>
              {phase === "connected" ? (
                <button className="token" onClick={() => setSettingsOpen(false)}>
                  Hide
                </button>
              ) : null}
            </div>
          </aside>
        ) : null}
        {phase !== "connected" && !settingsVisible ? (
          <div className="stream-placeholder">
            <span className="message-tag">Waiting</span>
            <p>Start `remote-codex stream`, then open the printed phone URL here to mirror the real VS Code window.</p>
          </div>
        ) : null}
      </section>

      <div className="stream-compose-minimal">
        <label className="stream-compose-field">
          <textarea
            ref={composeRef}
            value={composeText}
            placeholder="Keep the Codex prompt focused on the desktop, then type here."
            enterKeyHint="send"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendTextToCodex(true);
              }
            }}
            onChange={(event) => setComposeText(event.target.value)}
          />
        </label>
        <button type="button" disabled={!composeText.trim() || isSending} onClick={() => sendTextToCodex(true)}>
          Send
        </button>
      </div>
    </main>
  );
}
