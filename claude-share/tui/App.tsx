import { spawn } from "node:child_process";

import { Box, Text, useInput, useApp } from "ink";
import React, { useState, useEffect, useCallback } from "react";

import {
  regeneratePairingCode,
  type Machine,
  type Session,
} from "../session/manager.js";

const IS_DEV = process.env.NODE_ENV === "development";

type View = "pairing" | "machines" | "sessions";

function formatDuration(from: Date): string {
  const secs = Math.floor((Date.now() - from.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatRelative(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
}

function formatExpiry(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function latestActivity(machine: Machine): Date {
  if (machine.sessions.size === 0) return machine.pairedAt;
  return [...machine.sessions.values()].reduce(
    (latest, s) => (s.lastActiveAt > latest ? s.lastActiveAt : latest),
    machine.pairedAt,
  );
}

interface Props {
  publicUrl: string | null;
  lanUrl: string | null;
  loopbackUrl: string;
  localPort: number;
  sharedUntil: Date;
  getSession: () => Session | null;
  tunnelDown: boolean;
  tunnelStartedAt: Date | null;
  onExit: () => void;
}

function copyToClipboard(text: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "pbcopy";
    args = [];
  } else if (process.platform === "win32") {
    cmd = "clip";
    args = [];
  } else if (process.env.WAYLAND_DISPLAY) {
    cmd = "wl-copy";
    args = [];
  } else {
    cmd = "xclip";
    args = ["-selection", "clipboard"];
  }
  const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  proc.on("error", () => {
    // fallback: OSC 52 — works in most modern terminals without external tools
    process.stdout.write(
      `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`,
    );
  });
  proc.stdin.write(text);
  proc.stdin.end();
}

export function App({
  publicUrl,
  lanUrl,
  loopbackUrl,
  localPort,
  sharedUntil,
  getSession,
  tunnelDown,
  tunnelStartedAt,
  onExit,
}: Props) {
  const { exit } = useApp();
  const [view, setView] = useState<View>("pairing");
  const [pairingCode, setPairingCode] = useState(
    () => getSession()?.pairingCode ?? "",
  );
  const [machines, setMachines] = useState<Machine[]>([]);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const session = getSession();
      if (!session) return;
      setPairingCode(session.pairingCode);
      setMachines([...session.machines.values()]);
      if (session.pairingCodeUsed) {
        setView((v) => (v === "pairing" ? "machines" : v));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setCursorIdx((i) => Math.min(i, Math.max(0, machines.length - 1)));
  }, [machines.length]);

  const connectUrl = useCallback(
    (base: string) =>
      `claudeshare://${base.replace(/^https?:\/\//, "")}/connect/${pairingCode}`,
    [pairingCode],
  );

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      onExit();
      exit();
      return;
    }

    if (view === "machines") {
      if (key.upArrow) setCursorIdx((i) => Math.max(0, i - 1));
      if (key.downArrow)
        setCursorIdx((i) => Math.min(machines.length - 1, i + 1));
      if (key.return && machines.length > 0) {
        setSelectedMachineId(machines[cursorIdx]?.id ?? null);
        setView("sessions");
      }
    }

    if (key.escape) {
      if (view === "sessions") {
        setView("machines");
        setSelectedMachineId(null);
      } else if (view === "pairing" && machines.length > 0) {
        setView("machines");
      }
    }

    if (input === "n" && view !== "pairing") {
      const session = getSession();
      if (session) regeneratePairingCode(session);
      setView("pairing");
      setSelectedMachineId(null);
    }

    if (input === "c" && view === "pairing") {
      const best = publicUrl ?? lanUrl ?? loopbackUrl;
      copyToClipboard(connectUrl(best));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  });

  const selectedMachine = selectedMachineId
    ? (machines.find((m) => m.id === selectedMachineId) ?? null)
    : null;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box gap={2} marginBottom={1}>
        <Text bold color="cyan">
          claude-share
        </Text>
        <Text dimColor>{formatExpiry(sharedUntil)} remaining</Text>
        <Text dimColor>:{localPort}</Text>
        {tunnelDown && (
          <Text color="red">
            ⚠ tunnel disconnected — receivers can't connect
            {tunnelStartedAt
              ? ` (Active for ${formatDuration(tunnelStartedAt)})`
              : ""}
          </Text>
        )}
      </Box>

      {/* Pairing view */}
      {view === "pairing" && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={2}
          paddingY={1}
        >
          <Text bold color="green">
            Waiting for a machine to connect…
          </Text>
          <Box flexDirection="column" marginTop={1} gap={0}>
            {publicUrl ? (
              <Box>
                <Box minWidth={10}><Text dimColor>Public</Text></Box>
                <Text>{connectUrl(publicUrl)}</Text>
              </Box>
            ) : (
              <Box>
                <Box minWidth={10}><Text dimColor>Public</Text></Box>
                <Text dimColor>not available — local network only</Text>
              </Box>
            )}
            {lanUrl && (
              <Box>
                <Box minWidth={10}><Text dimColor>LAN</Text></Box>
                <Text bold>{connectUrl(lanUrl)}</Text>
              </Box>
            )}
            {IS_DEV && (
              <Box>
                <Box minWidth={10}><Text dimColor>Local</Text></Box>
                <Text dimColor>{connectUrl(loopbackUrl)}</Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="column" marginTop={1} gap={0}>
            <Text dimColor>One-time code — only one machine can use it.</Text>
            <Text dimColor>
              Ask your friend to run <Text color="white">claude-connect</Text>{" "}
              and paste the link above.
            </Text>
          </Box>
        </Box>
      )}

      {/* Machines list */}
      {view === "machines" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Machines ({machines.length})</Text>
          </Box>
          {machines.length === 0 ? (
            <Text dimColor>No machines yet.</Text>
          ) : (
            machines.map((m, i) => {
              const active = [...m.sessions.values()].some((s) => s.active);
              const last = latestActivity(m);
              const cursor = i === cursorIdx;
              return (
                <Box key={m.id} gap={1}>
                  <Text color={cursor ? "cyan" : undefined}>
                    {cursor ? "›" : " "}
                  </Text>
                  <Text color={active ? "green" : "yellow"}>●</Text>
                  <Text bold={cursor}>{m.name}</Text>
                  <Text dimColor>— {formatRelative(last)}</Text>
                </Box>
              );
            })
          )}
        </Box>
      )}

      {/* Sessions detail */}
      {view === "sessions" && selectedMachine && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>{selectedMachine.name} — Sessions</Text>
          </Box>
          {selectedMachine.sessions.size === 0 ? (
            <Text dimColor>No sessions yet.</Text>
          ) : (
            [...selectedMachine.sessions.values()]
              .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
              .map((s, i) => (
                <Box key={s.id} gap={2}>
                  <Text color={s.active ? "green" : "gray"}>●</Text>
                  <Text dimColor>#{i + 1}</Text>
                  <Text dimColor>{s.id.slice(0, 8)}</Text>
                  <Text dimColor>{formatRelative(s.lastActiveAt)}</Text>
                </Box>
              ))
          )}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} gap={2}>
        <Text dimColor>q quit</Text>
        {view === "pairing" && machines.length > 0 && (
          <Text dimColor>esc back</Text>
        )}
        {view === "pairing" &&
          (copied ? (
            <Text color="green">✓ copied!</Text>
          ) : (
            <Text dimColor>c copy url</Text>
          ))}
        {view === "machines" && (
          <Text dimColor>↑↓ select · enter view sessions · n new pairing</Text>
        )}
        {view === "sessions" && <Text dimColor>esc back · n new pairing</Text>}
      </Box>
    </Box>
  );
}
