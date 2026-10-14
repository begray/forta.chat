import { describe, it, expect } from "vitest";
import { feedProfileToUser } from "../feed-profile";

describe("feedProfileToUser", () => {
  it("maps a getuserprofile row from rpc-ex", () => {
    const user = feedProfileToUser({
      address: "PPN7wEAtGYCB89uCzK947bGEtGZ4MWdqV6",
      name: "Dake_ST",
      i: "https://bastyon.com:8092/i/tpLwsUYBnAEweDUoZXSGIm.jfif",
      a: "%D0%9E%D0%B1%D0%BE%20%D0%B2%D1%81%D0%B5%D0%BC",
      s: "",
      l: "ru",
    });
    expect(user).toMatchObject({
      address: "PPN7wEAtGYCB89uCzK947bGEtGZ4MWdqV6",
      name: "Dake_ST",
      image: "https://bastyon.com:8092/i/tpLwsUYBnAEweDUoZXSGIm.jfif",
      about: "Обо всем",
      language: "ru",
    });
  });

  it("keeps a value that is not URI-encoded as is", () => {
    expect(feedProfileToUser({ address: "P1", name: "100% real" })?.name).toBe("100% real");
  });

  it("drops a row without an address", () => {
    expect(feedProfileToUser({ name: "x" })).toBeNull();
  });
});
