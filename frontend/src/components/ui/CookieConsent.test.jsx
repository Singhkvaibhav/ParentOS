import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import CookieConsent from "./CookieConsent";
import * as productAnalytics from "../../productAnalytics";

// The component reads ENABLED/hasAnsweredConsent/setConsent straight off
// this module at render time (not a value captured once at import), so
// mutating the mocked module's own exports between tests - rather than
// re-mocking per test - is enough to drive each scenario.
vi.mock("../../productAnalytics", () => ({
  ENABLED: true,
  hasAnsweredConsent: vi.fn(),
  setConsent: vi.fn(),
}));

// A minimal real i18next instance rather than mocking useTranslation - the
// banner's copy is short enough that exercising the real translation
// pipeline is simpler than stubbing t().
beforeEach(async () => {
  await i18n.init({
    lng: "en",
    resources: { en: { translation: { cookieConsent: { message: "We use analytics.", accept: "Accept", decline: "Decline" } } } },
  });
});

function renderConsent() {
  return render(
    <I18nextProvider i18n={i18n}>
      <CookieConsent />
    </I18nextProvider>
  );
}

describe("CookieConsent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productAnalytics.ENABLED = true;
  });

  test("renders nothing when analytics is unconfigured - there's nothing to ask consent for", () => {
    productAnalytics.ENABLED = false;
    const { container } = renderConsent();
    expect(container).toBeEmptyDOMElement();
    expect(productAnalytics.hasAnsweredConsent).not.toHaveBeenCalled();
  });

  test("renders nothing if the visitor already answered (accepted or declined) on a previous visit", () => {
    productAnalytics.hasAnsweredConsent.mockReturnValue(true);
    const { container } = renderConsent();
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the banner for a first-time visitor who hasn't answered yet", () => {
    productAnalytics.hasAnsweredConsent.mockReturnValue(false);
    renderConsent();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("We use analytics.")).toBeInTheDocument();
  });

  test("Accept calls setConsent(true) and dismisses the banner", () => {
    productAnalytics.hasAnsweredConsent.mockReturnValue(false);
    renderConsent();

    fireEvent.click(screen.getByText("Accept"));

    expect(productAnalytics.setConsent).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Decline calls setConsent(false) and dismisses the banner", () => {
    productAnalytics.hasAnsweredConsent.mockReturnValue(false);
    renderConsent();

    fireEvent.click(screen.getByText("Decline"));

    expect(productAnalytics.setConsent).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
