import type { SerializeOptions } from "cookie";
import { parse, serialize } from "cookie";
import { sign, unsign } from "cookie-signature";
import { createHash, randomBytes } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import compare from "tsscmp";
import uid from "uid-safe";

import { HttpError } from "@calcom/lib/http-error";

import type { ICSRF } from "./csrf.interface";

export class InvalidCSRFError extends HttpError {
  constructor() {
    super({ statusCode: 403, message: "Invalid CSRF token" });
  }
}

export class RealCSRF implements ICSRF {
  cookieOptions: SerializeOptions;
  secret: string;
  secretCookieName = "csrfSecret";
  tokenCookieName = "XSRF-TOKEN";
  constructor() {
    // This will never be null since we would be using MockCSRF otherwise
    this.secret = process.env.NEXTAUTH_SECRET!;
    this.cookieOptions = {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    };
  }
  private hash(str: string) {
    return createHash("sha1")
      .update(str, "ascii")
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }
  private tokenize(secret: string, salt: string) {
    return `${salt}-${this.hash(`${salt}-${secret}`)}`;
  }
  private verifyToken(secret: string, token: string) {
    const index = token.indexOf("-");
    if (index === -1) return false;
    const salt = token.substr(0, index);
    const expected = this.tokenize(secret, salt);
    return compare(token, expected);
  }
  private createToken(secret: string) {
    const salt = randomBytes(32).toString("hex");
    return this.tokenize(secret, salt);
  }
  private getSecret(req: IncomingMessage): string {
    if (req.headers.cookie) {
      const parsedCookie = parse(req.headers.cookie);
      const secret = parsedCookie[this.secretCookieName.toLowerCase()];
      if (secret) return secret;
    }
    // If no cookie is present, generate a new one
    return uid.sync(18);
  }
  setup(req: IncomingMessage, res: ServerResponse) {
    const csrfSecret = this.getSecret(req);
    const unsignedToken = this.createToken(csrfSecret);
    const token = sign(unsignedToken, this.secret);

    if ("setHeader" in res) {
      // Pages Router
      res.setHeader("Set-Cookie", [
        serialize(this.secretCookieName, csrfSecret, this.cookieOptions),
        serialize(this.tokenCookieName, token, this.cookieOptions),
      ]);
    } else if ("cookies" in res) {
      // App Router
      const cookieAPI = (res as any).cookies;
      cookieAPI.set(this.secretCookieName, csrfSecret, this.cookieOptions);
      cookieAPI.set(this.tokenCookieName, token, this.cookieOptions);
    }
  }
  verify(req: IncomingMessage, res: ServerResponse) {
    // Fail if no cookie is present
    if (req.headers?.cookie === undefined) throw new InvalidCSRFError();

    const cookie = parse(req.headers?.cookie);
    // Extract secret and token from their cookies
    let token = cookie[this.tokenCookieName];
    const csrfSecret = cookie[this.secretCookieName];

    // Check token is in the cookie
    if (!token || !csrfSecret) throw new InvalidCSRFError();

    // https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#synchronizer-token-pattern
    // unsign cookie
    const unsignedToken = unsign(token, this.secret);

    // validate signature
    if (!unsignedToken) throw new InvalidCSRFError();

    token = unsignedToken;

    // verify CSRF token
    if (!this.verifyToken(csrfSecret, token)) throw new InvalidCSRFError();

    // If token is verified, generate a new one and save it in the cookie
    const newToken = sign(this.createToken(csrfSecret), this.secret);
    res.setHeader("Set-Cookie", serialize(this.tokenCookieName, newToken, this.cookieOptions));
  }
}
