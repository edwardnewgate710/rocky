/**
 * A simple in-memory TokenVerifier for tests. Maps tokens to user ids.
 * In production, the API's AccessTokenService satisfies this port.
 */
export class FakeTokenVerifier {
  private readonly tokens = new Map<string, string>();

  /** Register a token → userId mapping. */
  allow(token: string, userId: string): this {
    this.tokens.set(token, userId);
    return this;
  }

  verify(token: string): { readonly userId: string } | null {
    const userId = this.tokens.get(token);
    return userId !== undefined ? { userId } : null;
  }
}
