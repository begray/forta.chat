import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDeleteAccount, DeleteAccountError, type DeleteAccountDeps } from "./delete-account";

function deps(over: Partial<DeleteAccountDeps> = {}) {
  const calls: string[] = [];
  const d: DeleteAccountDeps = {
    address: "PAddr",
    isRegistered: vi.fn(async () => { calls.push("isRegistered"); return true; }),
    getBalance: vi.fn(async () => { calls.push("getBalance"); return 1.5; }),
    removePeertube: vi.fn(async () => { calls.push("removePeertube"); }),
    deactivateMatrix: vi.fn(async () => { calls.push("deactivateMatrix"); }),
    deleteOnChain: vi.fn(async () => { calls.push("deleteOnChain"); }),
    onProgress: vi.fn((s) => { calls.push(`step:${s}`); }),
    ...over,
  };
  return { d, calls };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DeleteAccountError ? e.code : "other";
  }
};

describe("runDeleteAccount (Pocketnet deleteaccount order)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("runs prepare, PeerTube, Matrix, blockchain in that order", async () => {
    const { d, calls } = deps();
    await runDeleteAccount(d);
    expect(calls).toEqual([
      "step:prepare", "isRegistered", "getBalance",
      "step:removePeertube", "removePeertube",
      "step:removeMatrix", "deactivateMatrix",
      "step:removeBB", "deleteOnChain",
    ]);
    expect(d.deleteOnChain).toHaveBeenCalledWith("PAddr");
  });

  it("stops with notprepared before anything is removed when the account is not on the chain", async () => {
    const { d } = deps({ isRegistered: vi.fn(async () => false) });
    expect(await codeOf(runDeleteAccount(d))).toBe("notprepared");
    expect(d.removePeertube).not.toHaveBeenCalled();
    expect(d.deactivateMatrix).not.toHaveBeenCalled();
    expect(d.deleteOnChain).not.toHaveBeenCalled();
  });

  it("stops with notprepared when the wallet is unavailable", async () => {
    const { d } = deps({ getBalance: vi.fn(async () => null) });
    expect(await codeOf(runDeleteAccount(d))).toBe("notprepared");
    expect(d.deactivateMatrix).not.toHaveBeenCalled();
  });

  it("stops with balance before anything is removed when there is no PKOIN", async () => {
    const { d } = deps({ getBalance: vi.fn(async () => 0) });
    expect(await codeOf(runDeleteAccount(d))).toBe("balance");
    expect(d.deactivateMatrix).not.toHaveBeenCalled();
    expect(d.deleteOnChain).not.toHaveBeenCalled();
  });

  it("treats a failed unspents refresh as a balance problem", async () => {
    const { d } = deps({ getBalance: vi.fn(async () => { throw new Error("rpc"); }) });
    expect(await codeOf(runDeleteAccount(d))).toBe("balance");
  });

  it("goes on to the blockchain when PeerTube and Matrix fail", async () => {
    const { d } = deps({
      removePeertube: vi.fn(async () => { throw new Error("peertube"); }),
      deactivateMatrix: vi.fn(async () => { throw new Error("matrix"); }),
    });
    await runDeleteAccount(d);
    expect(d.deleteOnChain).toHaveBeenCalledTimes(1);
  });

  it("reports undefinedError when the transaction fails", async () => {
    const { d } = deps({ deleteOnChain: vi.fn(async () => { throw new Error("rejected"); }) });
    expect(await codeOf(runDeleteAccount(d))).toBe("undefinedError");
  });
});
