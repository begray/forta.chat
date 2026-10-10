import { describe, it, expect, vi } from "vitest";
import { MatrixClientService } from "../matrix-client";

/** Account deletion: the same /account/deactivate request Pocketnet sends. */
describe("MatrixClientService.deactivateAccount", () => {
  it("erases the account with Pocketnet matrixCredentials as auth", async () => {
    const service = new MatrixClientService("test.invalid");
    const deactivateAccount = vi.fn().mockResolvedValue({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = { deactivateAccount };
    service.setCredentials({ address: "PAddr", username: "paddr", password: "secret" });

    await service.deactivateAccount();

    expect(deactivateAccount).toHaveBeenCalledWith(
      { type: "m.login.password", user: "PAddr", username: "paddr", address: "PAddr", password: "secret", sessionId: "" },
      true,
    );
  });

  it("rejects without a client", async () => {
    const service = new MatrixClientService("test.invalid");
    service.setCredentials({ address: "PAddr", username: "paddr", password: "secret" });
    await expect(service.deactivateAccount()).rejects.toThrow();
  });
});
