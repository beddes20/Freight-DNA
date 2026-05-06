import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Creates an in-memory rate-limiter Express middleware.
 *
 * @param limit   Maximum requests allowed per window.
 * @param windowMs Duration of the window in milliseconds.
 * @param message  Error message returned on 429.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  message = "Too many requests. Please try again later."
) {
  const store = new Map<string, Bucket>();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim() ?? req.socket.remoteAddress ?? "unknown";

    const now = Date.now();
    const bucket = store.get(ip);

    if (bucket) {
      if (now - bucket.windowStart < windowMs) {
        if (bucket.count >= limit) {
          res.status(429).json({ error: message });
          return;
        }
        bucket.count += 1;
      } else {
        store.set(ip, { count: 1, windowStart: now });
      }
    } else {
      store.set(ip, { count: 1, windowStart: now });
    }

    next();
  };
}
