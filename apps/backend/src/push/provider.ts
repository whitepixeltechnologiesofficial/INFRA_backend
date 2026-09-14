/**
 * Push delivery provider abstraction (Scenario 3.4/3.5, Tech Arch §14.x).
 *
 * The backend fans out a notification to a user's registered devices through a
 * `PushProvider`. Two implementations exist:
 *
 *   - `ExpoPushProvider` — the real provider. Calls Expo's push service
 *     (`exp.host/--/api/v2/push/send`) which routes to APNs (iOS) / FCM
 *     (Android). Gated behind `EXPO_PUSH_ENABLED=1`, which should only be set
 *     once the app is out of mock mode and real device tokens are being
 *     registered.
 *   - `MockPushProvider` — the default. Records deliveries in-memory (same
 *     spirit as the app's in-memory mock APIs) so the whole pipeline can be
 *     exercised with no push credentials. Delivers to nothing real.
 *
 * Screens/senders call `selectPushProvider()` (or the `sendNotification`
 * helper) exactly like the live provider; `mockPushDebug` holds verification
 * helpers.
 */

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android 8+ channel id (the app uses "messages"). */
  channelId?: string;
  apiRoot?: string;
};

export type SendResult =
  | { ok: true; remoteId?: string }
  | { ok: false; message: string };

export interface PushProvider {
  send(token: string, payload: PushPayload): Promise<SendResult>;
}

// ── Real provider (gated) ────────────────────────────────────────────────

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
// Tokens that don't look like Expo push tokens have no route on exp.host.
const TOKEN_SHAPE = /ExponentPushToken\[[A-Za-z0-9\-_~]{6,}\]/;

export class ExpoPushProvider implements PushProvider {
  async send(token: string, payload: PushPayload): Promise<SendResult> {
    if (!TOKEN_SHAPE.test(token)) {
      return { ok: false, message: "TOKEN_INVALID" };
    }

    try {
      const res = await fetch(payload.apiRoot ?? EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify([
          {
            to: token,
            title: payload.title,
            body: payload.body,
            data: payload.data ?? {},
            sound: "default",
            ...(payload.channelId ? { channelId: payload.channelId } : {}),
          },
        ]),
      });

      if (!res.ok) {
        return { ok: false, message: `EXPO_HTTP_${res.status}` };
      }

      const json = (await res.json()) as { data?: { status?: string; id?: string }[] };
      const ticket = json.data?.[0];
      if (ticket && (ticket.status === "error" || ticket.status === "DeviceNotRegistered")) {
        return { ok: false, message: `EXPO_TICKET_${ticket.status}` };
      }
      return { ok: true, remoteId: ticket?.id };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "Expo push send failed",
      };
    }
  }
}

// ── Mock provider (default) ──────────────────────────────────────────────

type MockDelivery = { token: string; title: string; body: string; at: number };

const deliveries: MockDelivery[] = [];

export class MockPushProvider implements PushProvider {
  async send(token: string, payload: PushPayload): Promise<SendResult> {
    // Same trust boundary as the Expo endpoint: refuse anything that isn't an
    // Expo-push-token-shaped string.
    if (!TOKEN_SHAPE.test(token)) {
      return { ok: false, message: "TOKEN_INVALID" };
    }
    deliveries.push({ token, title: payload.title, body: payload.body, at: Date.now() });
    return { ok: true, remoteId: `mock-${deliveries.length}` };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Pick the active provider. Real Expo delivery only when `EXPO_PUSH_ENABLED=1`
 * (requires APNs/FCM credentials provisioned on exp.host); otherwise the mock
 * provider keeps the pipeline runnable with no credentials.
 */
export function selectPushProvider(): PushProvider {
  if (process.env.EXPO_PUSH_ENABLED === "1") {
    return new ExpoPushProvider();
  }
  return new MockPushProvider();
}

// ── Verification helpers (tests only) ────────────────────────────────────
export const mockPushDebug = {
  deliveryCount(): number {
    return deliveries.length;
  },
  deliveries(): readonly MockDelivery[] {
    return deliveries;
  },
  reset(): void {
    deliveries.length = 0;
  },
};
