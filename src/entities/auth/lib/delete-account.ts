/**
 * Account deletion, step for step as Pocketnet's `sdk.user.deleteaccount`
 * (pocketnet `js/satolist.js`): prepare → PeerTube → Matrix → blockchain.
 *
 * - prepare: the account must exist on the chain and hold spendable PKOIN
 *   (the `accDel` transaction is paid), else `notprepared` / `balance`.
 * - PeerTube and Matrix are best effort: their failures are logged and the
 *   deletion goes on, as in Pocketnet.
 * - The blockchain transaction is what deletes the account; its failure ends
 *   the run with `undefinedError`.
 */

export type DeleteAccountStep = "prepare" | "removePeertube" | "removeMatrix" | "removeBB";
export type DeleteAccountErrorCode = "notprepared" | "balance" | "undefinedError";

export class DeleteAccountError extends Error {
  constructor(readonly code: DeleteAccountErrorCode, cause?: unknown) {
    super(`delete account: ${code}`);
    this.cause = cause;
  }
}

export interface DeleteAccountDeps {
  address: string;
  isRegistered: (address: string) => Promise<boolean>;
  getBalance: () => Promise<number | null>;
  removePeertube: () => Promise<unknown>;
  deactivateMatrix: () => Promise<unknown>;
  deleteOnChain: (address: string) => Promise<unknown>;
  onProgress?: (step: DeleteAccountStep) => void;
}

export async function runDeleteAccount(deps: DeleteAccountDeps): Promise<void> {
  const progress = deps.onProgress ?? (() => {});

  progress("prepare");
  if (!deps.address) throw new DeleteAccountError("notprepared");
  let registered = false;
  try {
    registered = await deps.isRegistered(deps.address);
  } catch (e) {
    throw new DeleteAccountError("notprepared", e);
  }
  if (!registered) throw new DeleteAccountError("notprepared");
  let balance: number | null = null;
  try {
    balance = await deps.getBalance();
  } catch (e) {
    throw new DeleteAccountError("balance", e);
  }
  if (balance === null) throw new DeleteAccountError("notprepared");
  if (!(balance > 0)) throw new DeleteAccountError("balance");

  progress("removePeertube");
  try {
    await deps.removePeertube();
  } catch (e) {
    console.warn("[deleteAccount] PeerTube step failed:", e);
  }

  progress("removeMatrix");
  try {
    await deps.deactivateMatrix();
  } catch (e) {
    console.warn("[deleteAccount] Matrix deactivation failed:", e);
  }

  progress("removeBB");
  try {
    await deps.deleteOnChain(deps.address);
  } catch (e) {
    throw new DeleteAccountError("undefinedError", e);
  }
}
