"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getRealBackendClient, type RealBackendClient } from "@wpt/api-client";
import type { Socket } from "socket.io-client";
import type { AccountLinkedPayload } from "@wpt/shared";

const backend = getRealBackendClient();

type BackendClient = RealBackendClient;

type SessionContextValue = {
  backend: BackendClient;
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  linked: boolean;
  saveLinkedSession: (payload: AccountLinkedPayload) => void;
  clearSession: (reason?: string) => void;
  logoff: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const authedSocketRef = useRef<Socket | null>(null);

  const clearSession = useCallback((reason?: string) => {
    authedSocketRef.current?.close();
    authedSocketRef.current = null;
    for (const key of ["sealine.accessToken", "sealine.refreshToken", "sealine.userId", "sealine.deviceId", "sealine.sessionId"]) {
      localStorage.removeItem(key);
    }
    setAccessToken(null); setRefreshToken(null); setUserId(null); setDeviceId(null); setSessionId(null);
    router.push(reason ? `/?reason=${encodeURIComponent(reason)}` : "/");
  }, [router]);

  const saveLinkedSession = useCallback((payload: AccountLinkedPayload) => {
    localStorage.setItem("sealine.accessToken", payload.accessToken);
    localStorage.setItem("sealine.refreshToken", payload.refreshToken);
    localStorage.setItem("sealine.userId", payload.userId);
    localStorage.setItem("sealine.deviceId", payload.deviceId);
    localStorage.setItem("sealine.sessionId", payload.sessionId);
    setAccessToken(payload.accessToken); setRefreshToken(payload.refreshToken);
    setUserId(payload.userId); setDeviceId(payload.deviceId); setSessionId(payload.sessionId);

    if (backend) {
      authedSocketRef.current?.close();
      const socket = backend.openAuthenticatedSocket(payload);
      socket.on("force_logout", () => clearSession("Signed out: linked on another browser"));
      socket.on("connect_error", () => { /* reconnect is handled by socket.io */ });
      authedSocketRef.current = socket;
    }
    router.push("/chats");
  }, [clearSession, router]);

  const logoff = useCallback(async () => {
    if (!backend || !accessToken) {
      clearSession();
      return;
    }
    try {
      await backend.logout(accessToken);
    } finally {
      clearSession();
    }
  }, [accessToken, backend, clearSession]);

  useEffect(() => {
    const a = localStorage.getItem("sealine.accessToken");
    const r = localStorage.getItem("sealine.refreshToken");
    const u = localStorage.getItem("sealine.userId");
    const d = localStorage.getItem("sealine.deviceId");
    const s = localStorage.getItem("sealine.sessionId");
    if (!a || !r || !u || !d || !s || !backend) return;
    const payload = { accessToken: a, refreshToken: r, userId: u, deviceId: d, sessionId: s };
    setAccessToken(a); setRefreshToken(r); setUserId(u); setDeviceId(d); setSessionId(s);
    const socket = backend.openAuthenticatedSocket(payload);
    socket.on("force_logout", () => clearSession("Signed out: linked on another browser"));
    authedSocketRef.current = socket;
    return () => {
      socket.close();
    };
  }, [clearSession]);

  const value = useMemo(() => ({ backend, accessToken, refreshToken, userId, deviceId, sessionId, linked: Boolean(accessToken && refreshToken), saveLinkedSession, clearSession, logoff }), [accessToken, refreshToken, userId, deviceId, sessionId, saveLinkedSession, clearSession, logoff]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside Providers");
  return value;
}