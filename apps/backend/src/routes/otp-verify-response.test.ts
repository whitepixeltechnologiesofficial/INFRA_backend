import { buildOtpVerifySuccessResponse } from "./otp-verify-response.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const response = buildOtpVerifySuccessResponse({
  routing: "chats",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  userId: "user-1",
  sessionId: "session-1",
  deviceId: "device-1",
});

assert(response.status === "success", "status must be success");
assert(response.routing === "chats", "routing must be preserved");
assert(response.deviceId === "device-1", "deviceId must be returned to the client");
assert(response.accessToken === "access-token", "accessToken must be preserved");
assert(response.refreshToken === "refresh-token", "refreshToken must be preserved");
assert(response.userId === "user-1", "userId must be preserved");
assert(response.sessionId === "session-1", "sessionId must be preserved");

console.log("otp verify success response contract OK");
