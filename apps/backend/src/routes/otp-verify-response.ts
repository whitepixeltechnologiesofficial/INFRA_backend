export type OtpVerifySuccessInput = {
  routing: "chats" | "profile_setup";
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
  deviceId: string;
};

export type OtpVerifySuccessResponse = OtpVerifySuccessInput & {
  status: "success";
};

export function buildOtpVerifySuccessResponse(
  input: OtpVerifySuccessInput,
): OtpVerifySuccessResponse {
  return {
    status: "success",
    routing: input.routing,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    userId: input.userId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
  };
}
