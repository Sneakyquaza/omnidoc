import { describe, expect, it } from "vitest";
import { bytesToDataUri, mimeFromPath } from "./images";

describe("images", () => {
  it("déduit le type MIME", () => {
    expect(mimeFromPath("/a/b.PNG")).toBe("image/png");
    expect(mimeFromPath("x.jpeg")).toBe("image/jpeg");
    expect(mimeFromPath("x.bin")).toBe("application/octet-stream");
  });

  it("encode en data URI", () => {
    expect(bytesToDataUri(new Uint8Array([72, 105]), "text/plain")).toBe(
      "data:text/plain;base64,SGk=",
    );
  });
});
