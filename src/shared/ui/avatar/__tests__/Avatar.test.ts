// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { setArchivedPeertubeServers } from "@/shared/lib/image-url";
import Avatar from "../Avatar.vue";

describe("Avatar", () => {
  it("shows the image again when a failed instance is reused with another src", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // RecycleScroller moves Avatar instances between rows; an error on one row's
    // image used to hide the image on every row the instance showed after it.
    const wrapper = mount(Avatar, { props: { src: "https://a.example/broken.png", name: "A" } });
    await wrapper.find("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);

    await wrapper.setProps({ src: "https://a.example/ok.png", name: "B" });
    expect(wrapper.find("img").attributes("src")).toBe("https://a.example/ok.png");
  });
});

describe("Avatar archived peertube hosts", () => {
  it("rewrites an already rendered src when the archived list arrives later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setArchivedPeertubeServers([]);
    const src = "https://peertube700.pocketnet.app/images/a/a-original.jpg";
    const wrapper = mount(Avatar, { props: { src, name: "S" } });
    // The dead host fails before the list is known.
    await wrapper.find("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);

    setArchivedPeertubeServers(["peertube700.pocketnet.app"]);
    await nextTick();
    expect(wrapper.find("img").attributes("src")).toBe(
      "https://peertube.archive.pocketnet.app/images/a/a-original.jpg",
    );
    setArchivedPeertubeServers([]);
  });

  it("swaps in a fresh img element when a recycled instance gets another src", async () => {
    const wrapper = mount(Avatar, { props: { src: "https://a.example/one.png", name: "A" } });
    const first = wrapper.find("img").element;
    await wrapper.setProps({ src: "https://a.example/two.png", name: "B" });
    expect(wrapper.find("img").element).not.toBe(first);
  });
});
