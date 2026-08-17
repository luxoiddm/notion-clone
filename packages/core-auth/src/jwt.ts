import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { JwtPayload } from './types.js';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';
const SALT_ROUNDS = 12;

export interface AuthConfig {
  accessTokenSecret: string;
  refreshTokenSecret: string;
}

export class AuthService {
  constructor(private readonly config: AuthConfig) {
    if (!config.accessTokenSecret || !config.refreshTokenSecret) {
      throw new Error('AuthService requires accessTokenSecret and refreshTokenSecret (set via env vars, never hardcode).');
    }
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Only re-signs the fields JwtPayload actually declares (`sub`, `role`,
   * `displayName`) — deliberately does NOT spread `...payload`. A decoded
   * token (from `verifyAccessToken`/`verifyRefreshToken`) carries `exp`/
   * `iat` at runtime even though `JwtPayload`'s type doesn't say so (the
   * `as JwtPayload` cast in those methods is a lie about the shape, just
   * not one TypeScript catches). Signing a payload that already has `exp`
   * while also passing `expiresIn` makes the `jsonwebtoken` library throw
   * — exactly what happened when `/api/auth/refresh` passed a freshly
   * decoded refresh-token payload straight into this method. Destructuring
   * only the known fields here means every caller is safe by construction,
   * not just the one that happened to trigger the bug.
   */
  signAccessToken(payload: JwtPayload): string {
    const { sub, role, displayName } = payload;
    return jwt.sign({ sub, role, displayName }, this.config.accessTokenSecret, { expiresIn: ACCESS_TOKEN_TTL });
  }

  signRefreshToken(payload: JwtPayload): string {
    const { sub, role, displayName } = payload;
    return jwt.sign({ sub, role, displayName }, this.config.refreshTokenSecret, { expiresIn: REFRESH_TOKEN_TTL });
  }

  verifyAccessToken(token: string): JwtPayload {
    return jwt.verify(token, this.config.accessTokenSecret) as JwtPayload;
  }

  verifyRefreshToken(token: string): JwtPayload {
    return jwt.verify(token, this.config.refreshTokenSecret) as JwtPayload;
  }

  /**
   * Generates a one-time invite token an Admin sends to a new user. There is
   * no self-registration endpoint anywhere in the system — an account only
   * ever comes into existence via this flow or a direct admin-created user.
   */
  signInviteToken(email: string, role: JwtPayload['role']): string {
    return jwt.sign({ email, role, purpose: 'invite' }, this.config.accessTokenSecret, { expiresIn: '7d' });
  }

  verifyInviteToken(token: string): { email: string; role: JwtPayload['role'] } {
    const decoded = jwt.verify(token, this.config.accessTokenSecret) as {
      email: string;
      role: JwtPayload['role'];
      purpose: string;
    };
    if (decoded.purpose !== 'invite') {
      throw new Error('Not an invite token');
    }
    return decoded;
  }
}
