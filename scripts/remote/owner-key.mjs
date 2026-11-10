// Prints a fresh remote-only owner key (drk_ + 32 random bytes). Never reuse a local dok_ key remotely.
import { randomBytes } from "node:crypto";
process.stdout.write(`drk_${randomBytes(32).toString("base64url")}\n`);
