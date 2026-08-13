import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("secret redaction", () => {
  it("redacts authorization and API key fields recursively", () => {
    expect(
      redactSecrets({ headers: { Authorization: "Bearer top-secret" }, nested: { api_key: "top-secret" } }),
    ).toEqual({ headers: { Authorization: "[REDACTED]" }, nested: { api_key: "[REDACTED]" } });
  });

  it("redacts bearer tokens embedded in strings", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abc.def-123'")).not.toContain("abc.def-123");
  });

  it("redacts explicitly supplied secrets", () => {
    expect(redactSecrets("prefix key-value suffix", ["key-value"])).toBe("prefix [REDACTED] suffix");
  });

  it("removes signed URL query strings but preserves public URLs", () => {
    const value = redactSecrets({
      upload: "https://bucket.example/file.jpg?X-Amz-Signature=abc&X-Amz-Credential=def",
      public: "https://example.com/file.jpg",
    });
    expect(value.upload).toBe("https://bucket.example/file.jpg?[REDACTED_QUERY]");
    expect(value.public).toBe("https://example.com/file.jpg");
  });
});
