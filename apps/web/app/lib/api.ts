// HTTP layer for the Web client. API base is served same-origin by default;
// point NEXT_PUBLIC_WPT_API_URL elsewhere when hosting the chat UI separately
// from the WPT web server.
export interface WptApiResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
}

export function wptApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_WPT_API_URL;
  return configured && configured.trim() ? configured.replace(/\/+$/, "") : "";
}

export async function wptApi<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown> | null,
): Promise<WptApiResult<T>> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" }, cache: "no-store" };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${wptApiBase()}${path}`, init);
  } catch (err) {
    return { status: 0, ok: false, body: null };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
}