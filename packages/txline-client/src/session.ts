import nacl from 'tweetnacl';
import { DEVNET } from '@groundtruth/shared';

/** Signs an arbitrary message with the wallet key (nacl detached ed25519). */
export type MessageSigner = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

/** Build a MessageSigner from a raw 64-byte ed25519 secret key (server keypair). */
export function keypairSigner(secretKey: Uint8Array): MessageSigner {
  return (message) => nacl.sign.detached(message, secretKey);
}

/**
 * Holds the two credentials every data call needs:
 *  - `jwt`   — 30-day guest session token (renewable at any time, no wallet needed)
 *  - `apiToken` — long-lived token bound to the on-chain subscribe tx via /api/token/activate
 */
export class TxlineSession {
  jwt = '';
  apiToken = '';

  constructor(readonly origin: string = DEVNET.apiOrigin) {}

  /** POST /auth/guest/start → fresh guest JWT. */
  async renewJwt(): Promise<string> {
    const res = await fetch(`${this.origin}/auth/guest/start`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`guest/start failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string };
    this.jwt = body.token;
    return this.jwt;
  }

  /**
   * Strict activation message binding (per TxLINE docs / tx-on-chain examples):
   * `${txSig}:${leagues.join(',')}:${jwt}` — signed detached, base64-encoded.
   */
  buildActivationMessage(txSig: string, leagues: number[]): string {
    return `${txSig}:${leagues.join(',')}:${this.jwt}`;
  }

  /**
   * POST /api/token/activate with the wallet-signed binding.
   * Requires a confirmed on-chain `subscribe` tx signature.
   */
  async activate(txSig: string, leagues: number[], sign: MessageSigner): Promise<string> {
    if (!this.jwt) await this.renewJwt();
    const message = new TextEncoder().encode(this.buildActivationMessage(txSig, leagues));
    const signature = await sign(message);
    // Platform-neutral base64 (Node and browser) — the signature is 64 bytes.
    const walletSignature = btoa(String.fromCharCode(...signature));

    const res = await fetch(`${this.origin}/api/token/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.jwt}`,
      },
      body: JSON.stringify({ txSig, walletSignature, leagues }),
    });
    if (!res.ok) {
      throw new Error(`token/activate failed: ${res.status} ${await res.text()}`);
    }
    // The endpoint is documented as text/plain but may return JSON {token}.
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as { token?: string };
      this.apiToken = parsed.token ?? raw;
    } catch {
      this.apiToken = raw;
    }
    return this.apiToken;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    if (this.apiToken) h['X-Api-Token'] = this.apiToken;
    return h;
  }
}
