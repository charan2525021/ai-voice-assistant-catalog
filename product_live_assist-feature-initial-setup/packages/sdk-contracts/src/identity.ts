import { SDK_TOKEN_SCHEMA_VERSION } from "./constants.js";

interface SdkTokenClaimsBase {
  v: typeof SDK_TOKEN_SCHEMA_VERSION;
  jti: string;
  installationId: string;
  organizationId: string;
  productId: string;
  environmentId: string;
  roleProfileId: string;
  userId: string;
  /** Exact normalized browser origin, for example https://app.example.com. */
  origin: string;
  /** NumericDate values in seconds since the Unix epoch. */
  iat: number;
  exp: number;
}

export interface SdkIdentityClaims extends SdkTokenClaimsBase {
  typ: "sdk_identity";
}

export interface SdkSessionClaims extends SdkTokenClaimsBase {
  typ: "sdk_session";
  sessionId: string;
  catalogVersionId: string;
}

export interface SdkSocketTicketClaims extends SdkTokenClaimsBase {
  typ: "sdk_socket_ticket";
  sessionId: string;
}
