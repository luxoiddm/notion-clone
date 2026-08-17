export type Role = 'Admin' | 'Team-Lead' | 'Member' | 'Guest';

export interface AuthUser {
  id: string;
  displayName: string;
  role: Role;
}

export interface JwtPayload {
  sub: string; // userId
  role: Role;
  displayName: string;
}

/** Attached to `req.user` by `requireAuth` middleware. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const ROLE_RANK: Record<Role, number> = {
  Guest: 0,
  Member: 1,
  'Team-Lead': 2,
  Admin: 3,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
