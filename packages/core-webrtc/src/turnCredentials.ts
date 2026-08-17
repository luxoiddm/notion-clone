import { createHmac } from 'node:crypto';

export interface TurnCredential {
  username: string;
  credential: string;
  /** Unix timestamp (seconds) the credential stops being valid — matches what's encoded in `username`. */
  expiresAt: number;
}

/**
 * Generates a short-lived TURN username/credential pair using coturn's
 * "long-term credential mechanism over a shared secret" scheme (the
 * `use-auth-secret` / `static-auth-secret` config option — see
 * deploy/turnserver.conf). The server never hands out a permanent TURN
 * password; each client gets one that expires on its own, so leaking it
 * (browser devtools, a compromised client) only exposes a short window
 * instead of a credential someone could reuse indefinitely.
 *
 * Scheme: `username = "<expiryUnixSeconds>:<label>"`, `credential =
 * base64(HMAC-SHA1(secret, username))`. coturn recomputes the same HMAC
 * server-side to validate an allocation request — nothing needs to be
 * stored or looked up, which is why this needs no database and no route
 * back to us once issued.
 */
export function generateTurnCredential(secret: string, label: string, ttlSeconds: number): TurnCredential {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  // coturn splits on the first ':' only, so a label containing ':' would
  // corrupt the expiry parse — strip it defensively rather than trust
  // that a display name or userId never contains one.
  const safeLabel = label.replace(/:/g, '_');
  const username = `${expiresAt}:${safeLabel}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt };
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface BuildIceServersOptions {
  turnHost: string;
  turnPort: number;
  turnTlsPort?: number;
  turnSecret: string;
  ttlSeconds: number;
  /** Included in the credential's username for observability in coturn's logs — not a security boundary, just a label. */
  userLabel: string;
}

/**
 * Assembles the ICE server list an `RTCPeerConnection` should use — our
 * own coturn instance for both STUN (NAT discovery) and TURN (relay
 * fallback when direct P2P can't be established), never a third-party
 * STUN/TURN provider. STUN needs no credentials; TURN gets a fresh
 * short-lived one from `generateTurnCredential`.
 */
export function buildIceServers(options: BuildIceServersOptions): IceServer[] {
  const { turnHost, turnPort, turnTlsPort, turnSecret, ttlSeconds, userLabel } = options;
  const { username, credential } = generateTurnCredential(turnSecret, userLabel, ttlSeconds);

  const servers: IceServer[] = [
    { urls: `stun:${turnHost}:${turnPort}` },
    { urls: `turn:${turnHost}:${turnPort}?transport=udp`, username, credential },
    { urls: `turn:${turnHost}:${turnPort}?transport=tcp`, username, credential },
  ];

  if (turnTlsPort) {
    servers.push({ urls: `turns:${turnHost}:${turnTlsPort}?transport=tcp`, username, credential });
  }

  return servers;
}
