import { describe, expect, test } from "bun:test";

import { isSoftwareRenderer } from "./lite";

describe("ソフトウェアの描き手の見分け", () => {
  test("ソフトウェアの描き手の名前なら、ソフトウェアとみなす", () => {
    for (const name of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "Google SwiftShader",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "softpipe",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ])
      expect(isSoftwareRenderer(name)).toBe(true);
  });

  test("WebGL を作れなければ、ソフトウェアとみなす", () => {
    expect(isSoftwareRenderer(null)).toBe(true);
  });

  test("GPU の名前と、丸めた名前は止めない (見分けられないときは回り続ける)", () => {
    for (const name of [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6)",
      "Apple GPU",
      "Radeon R9 200 Series, or similar",
      "WebKit WebGL",
    ])
      expect(isSoftwareRenderer(name)).toBe(false);
  });
});
