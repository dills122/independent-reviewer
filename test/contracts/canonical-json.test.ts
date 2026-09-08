import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalizeJson, sha256Utf8 } from "../../src/index.js";

describe("canonicalizeJson", () => {
  it("matches the RFC 8785 primitive serialization example", () => {
    const input = {
      numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };

    assert.equal(
      canonicalizeJson(input),
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts object names by UTF-16 code units while preserving array order", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
      nested: [{ z: 1, a: 2 }],
    };

    assert.equal(
      canonicalizeJson(input),
      '{"\\r":"Carriage Return","1":"One","nested":[{"a":2,"z":1}],"\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("rejects non-finite numbers and lone Unicode surrogates", () => {
    assert.throws(() => canonicalizeJson(Number.NaN), /finite/);
    assert.throws(() => canonicalizeJson("\ud800"), /surrogate/);
  });

  it("rejects values that JSON cannot represent without mutation", () => {
    const sparse = new Array<unknown>(3);
    sparse[0] = 1;
    sparse[2] = 3;

    assert.throws(() => canonicalizeJson(undefined), /JSON/);
    assert.throws(() => canonicalizeJson(sparse), /sparse/);
    assert.throws(() => canonicalizeJson({ value: 1n }), /JSON/);
  });

  it("rejects cyclic objects", () => {
    const input: { self?: unknown } = {};
    input.self = input;

    assert.throws(() => canonicalizeJson(input), /cyclic/);
  });

  it("rejects array accessors without invoking them", () => {
    let getterCalls = 0;
    const input: unknown[] = [];
    Object.defineProperty(input, 0, {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "should not be read";
      },
    });

    assert.throws(() => canonicalizeJson(input), /data properties/);
    assert.equal(getterCalls, 0);
  });

  it("rejects proxies without invoking their traps", () => {
    let getTrapCalls = 0;
    const input = new Proxy(
      { value: "should not be read" },
      {
        get(target, property, receiver) {
          getTrapCalls += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    assert.throws(() => canonicalizeJson(input), /proxies/);
    assert.equal(getTrapCalls, 0);
  });
});

describe("sha256Utf8", () => {
  it("matches the standard SHA-256 vector for UTF-8 text", () => {
    assert.deepEqual(sha256Utf8("abc"), {
      algorithm: "SHA256",
      value: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});
