import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceBrandRow } from "../components/SourceBrandIcons";

describe("source brand row", () => {
  it("offers TikTok as an Auto-Pilot profile source brand", () => {
    render(<SourceBrandRow note="Works with" ids={["tiktok"]} />);
    expect(screen.getByText("TikTok")).toBeInTheDocument();
  });
});