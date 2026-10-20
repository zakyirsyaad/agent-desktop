import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NoticeBanner } from "../components/AppPlaceholders";
import { UpdateNotice } from "../components/UpdateNotice";
import { NOTICE_BANNER_LAYOUT } from "../components/ui/noticeBannerStyle";
import { makeCatalogAgent } from "./fixtures/catalog";

describe("banners under the top bar", () => {
  it("share one layout and keep their own colors", () => {
    render(
      <>
        <NoticeBanner message="Broke" onDismiss={vi.fn()} />
        <UpdateNotice agents={[makeCatalogAgent({ id: "gemini", name: "Gemini", updateVersion: "1.1.0" })]} onShow={vi.fn()} onDismiss={vi.fn()} />
      </>,
    );

    const layout = NOTICE_BANNER_LAYOUT.split(" ");
    const alert = screen.getByRole("alert");
    const status = screen.getByRole("status");
    for (const banner of [alert, status]) expect(banner).toHaveClass(...layout);
    expect(alert).toHaveClass("bg-danger-surface", "text-danger");
    expect(status).toHaveClass("bg-surface-2", "text-fg-secondary");
  });
});
