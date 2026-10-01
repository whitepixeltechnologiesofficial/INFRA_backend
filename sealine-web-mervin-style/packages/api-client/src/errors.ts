import type { ApiErrorCode } from "@wpt/shared";

export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}
