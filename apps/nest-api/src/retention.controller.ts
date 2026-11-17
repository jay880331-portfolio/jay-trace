import { timingSafeEqual } from "node:crypto";
import { Controller, Headers, NotFoundException, Post, UnauthorizedException } from "@nestjs/common";
import { runRetentionCleanup } from "./jaytrace-retention.js";
import type { RetentionSummary } from "./jaytrace-retention.js";

// Externalised retention trigger. In Lambda the in-process timer is off and
// EventBridge POSTs here on a schedule; a shared secret gates it.
@Controller("internal")
export class RetentionController {
  @Post("retention")
  async retention(@Headers("x-jaytrace-internal") token: string | undefined): Promise<RetentionSummary> {
    const expected = process.env.JAYTRACE_INTERNAL_TOKEN;
    if (!expected) {
      // No token configured → the endpoint must not exist (never open without auth).
      throw new NotFoundException();
    }
    if (!token || !timingSafeEqualStr(token, expected)) {
      throw new UnauthorizedException();
    }

    return runRetentionCleanup();
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
