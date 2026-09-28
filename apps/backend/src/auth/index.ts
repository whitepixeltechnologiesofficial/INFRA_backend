export { issueAccessToken, verifyAccessToken, decodeAccessTokenUnsafe } from "./jwt.js";
export { issueAdminToken, verifyAdminToken } from "./jwt.js";
export { AUDIENCE_APP, AUDIENCE_DASHBOARD } from "./jwt.js";
export type { AccessTokenPayload, IssueAccessTokenParams } from "./types.js";

export {
  issueRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
  revokeSession,
  revokeAllUserSessions,
} from "./refresh-token.js";
export type {
  IssueRefreshTokenResult,
  ValidatedSession,
  RotateRefreshTokenResult,
} from "./refresh-token.js";

export {
  recordLegalAcceptance,
  hasAcceptedLegal,
  requireLegalAcceptance,
  LegalAcceptanceRequiredError,
  CURRENT_LEGAL_VERSION,
} from "./legal-gate.js";
